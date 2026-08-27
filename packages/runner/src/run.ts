import { spawn } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classify, installFail } from './classify.js';
import { buildMatrix, writeMatrix } from './emit.js';
import { eslintDistTags, packageFacts } from './registry.js';
import { pluginNamespace } from '../../cli/dist/snippet.js';
import { COMPAT_SPEC, deriveRescue, rescueEligibility, skippedRescue } from './rescue.js';
import type { PluginRow, PluginRunResult, PluginSpec, ProbeResult, RescueResult } from './types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, '..');
const REPO_ROOT = resolve(PACKAGE_ROOT, '..', '..');
const FIXTURES = join(PACKAGE_ROOT, 'fixtures');
const PROBE = join(PACKAGE_ROOT, 'probe', 'probe.mjs');
const PLUGINS_JSON = join(PACKAGE_ROOT, 'src', 'plugins.json');

const INSTALL_TIMEOUT_MS = 5 * 60_000;
const PROBE_TIMEOUT_MS = 6 * 60_000;

interface RunOptions {
  shardIndex: number;
  shardTotal: number;
  concurrency: number;
  outFile: string;
  only: string[];
  keepTemp: boolean;
}

function parseArgs(argv: string[]): RunOptions {
  const opts: RunOptions = {
    shardIndex: 0,
    shardTotal: 1,
    concurrency: Math.max(1, Number(process.env.MATRIX_CONCURRENCY ?? 4)),
    outFile: join(REPO_ROOT, 'matrix.json'),
    only: [],
    keepTemp: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const next = () => argv[++i];
    if (arg === '--shard') {
      const [index, total] = String(next() ?? '').split('/');
      opts.shardIndex = Number(index ?? 0);
      opts.shardTotal = Math.max(1, Number(total ?? 1));
    } else if (arg === '--concurrency') opts.concurrency = Math.max(1, Number(next() ?? 4));
    else if (arg === '--out') opts.outFile = resolve(String(next() ?? opts.outFile));
    else if (arg === '--only') opts.only.push(...String(next() ?? '').split(',').filter(Boolean));
    else if (arg === '--keep-temp') opts.keepTemp = true;
    else if (arg === '--help' || arg === '-h') {
      console.log(HELP);
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}\n\n${HELP}`);
    }
  }
  return opts;
}

const HELP = `eslint10-matrix runner

  node dist/run.js [options]

  --shard <i/n>        run only shard i of n (default 0/1)
  --concurrency <n>    parallel plugin installs (default 4, env MATRIX_CONCURRENCY)
  --out <file>         where to write the matrix (default ./matrix.json)
  --only <a,b>         restrict to these plugin names
  --keep-temp          leave the temp install directories on disk for debugging
`;

/**
 * `shell` is opt-in per call: npm resolves to npm.cmd on Windows and Node refuses
 * to spawn a .cmd without a shell, while process.execPath lives under
 * "C:\Program Files\..." and gets torn in half by one.
 */
function run(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  shell = false
): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      cwd,
      shell,
      env: { ...process.env, NO_COLOR: '1', npm_config_update_notifier: 'false' },
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', (c) => {
      stdout += c;
    });
    child.stderr.on('data', (c) => {
      stderr += c;
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolvePromise({ code: null, stdout, stderr: `${stderr}\n${err.message}`, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ code, stdout, stderr, timedOut });
    });
  });
}

async function probePair(
  spec: PluginSpec,
  eslintVersion: string,
  keepTemp: boolean,
  rescue = false
): Promise<PluginRunResult> {
  const dir = await mkdtemp(join(tmpdir(), 'e10m-'));
  try {
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'eslint10-matrix-probe', version: '0.0.0', private: true, type: 'module' }, null, 2)
    );
    await cp(FIXTURES, join(dir, 'fixtures'), { recursive: true });
    await cp(PROBE, join(dir, 'probe.mjs'));

    const parser = spec.parser ?? null;
    const deps = [`eslint@${eslintVersion}`, `${spec.name}@latest`, ...(spec.extraDeps ?? [])];
    if (rescue) deps.push(COMPAT_SPEC);

    // The declared peer range is what we are testing, so a plain install would
    // just refuse to resolve. --legacy-peer-deps installs past it deliberately.
    const install = await run(
      'npm',
      ['install', '--no-audit', '--no-fund', '--no-package-lock', '--legacy-peer-deps', '--loglevel', 'error', ...deps],
      dir,
      INSTALL_TIMEOUT_MS,
      true
    );
    if (install.code !== 0) {
      const reason = install.timedOut ? `npm install timed out after ${INSTALL_TIMEOUT_MS / 1000}s` : install.stderr || install.stdout;
      return installFail(reason);
    }

    await writeFile(
      join(dir, 'probe-input.json'),
      JSON.stringify(
        {
          specifier: spec.name,
          namespace: spec.namespace ?? pluginNamespace(spec.name),
          settings: spec.settings ?? null,
          parserSpecifier: parser,
          fixturesDir: 'fixtures',
          fixup: rescue,
        },
        null,
        2
      )
    );

    const probe = await run(process.execPath, ['probe.mjs'], dir, PROBE_TIMEOUT_MS);
    let parsed: ProbeResult | null = null;
    try {
      parsed = JSON.parse(await readFile(join(dir, 'probe-result.json'), 'utf8')) as ProbeResult;
    } catch {
      parsed = null;
    }
    if (!parsed && probe.timedOut) {
      return { status: 'load-fail', crashingRules: [], totalRules: 0, detail: `probe timed out after ${PROBE_TIMEOUT_MS / 1000}s` };
    }
    return classify(parsed, probe.stderr);
  } catch (err) {
    return installFail(err instanceof Error ? err.message : String(err));
  } finally {
    if (!keepTemp) await rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  }
}

/**
 * Runs only for plugins whose plain v10 result is a regression on ESLint 10.
 * Clean and safe-to-force rows never get a rescue field: a no-op wrap must not
 * be reported as a rescue.
 */
async function rescuePass(
  spec: PluginSpec,
  results: Record<string, PluginRunResult>,
  eslintVersions: { v9: string; v10: string },
  keepTemp: boolean
): Promise<RescueResult | undefined> {
  const onNine = results[eslintVersions.v9];
  const onTen = results[eslintVersions.v10]!;
  const eligibility = rescueEligibility(onNine, onTen);
  if (eligibility.kind === 'not-blocked') return undefined;
  if (eligibility.kind === 'skip') return skippedRescue(eslintVersions.v10, eligibility.reason);

  const wrapped = await probePair(spec, eslintVersions.v10, keepTemp, true);
  return deriveRescue(onNine, onTen, wrapped, eslintVersions.v10, eligibility.newlyBroken);
}

async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      out[index] = await fn(items[index]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export async function loadPlugins(): Promise<PluginSpec[]> {
  if (!existsSync(PLUGINS_JSON)) throw new Error(`plugin list missing: ${PLUGINS_JSON}`);
  const doc = JSON.parse(await readFile(PLUGINS_JSON, 'utf8')) as { plugins?: PluginSpec[] };
  if (!Array.isArray(doc.plugins) || doc.plugins.length === 0) {
    throw new Error(`${PLUGINS_JSON} does not contain a non-empty "plugins" array`);
  }
  return doc.plugins;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const all = await loadPlugins();
  const selected = opts.only.length > 0 ? all.filter((p) => opts.only.includes(p.name)) : all;
  if (selected.length === 0) throw new Error(`--only matched no plugins (known: ${all.length})`);

  const shard = selected.filter((_, i) => i % opts.shardTotal === opts.shardIndex);
  console.log(`[matrix] resolving eslint versions from the npm registry…`);
  const eslintVersions = await eslintDistTags();
  console.log(`[matrix] eslint v9=${eslintVersions.v9}  v10=${eslintVersions.v10}`);
  console.log(
    `[matrix] shard ${opts.shardIndex + 1}/${opts.shardTotal}: ${shard.length} plugins, concurrency ${opts.concurrency}`
  );

  const started = Date.now();
  let done = 0;

  const rows = await mapWithConcurrency(shard, opts.concurrency, async (spec): Promise<PluginRow> => {
    const facts = await packageFacts(spec.name);
    const results: Record<string, PluginRunResult> = {};
    for (const version of [eslintVersions.v9, eslintVersions.v10]) {
      results[version] = await probePair(spec, version, opts.keepTemp);
    }
    const rescue = await rescuePass(spec, results, eslintVersions, opts.keepTemp);
    done += 1;
    const v10 = results[eslintVersions.v10]!;
    console.log(
      `[matrix] (${done}/${shard.length}) ${spec.name}@${facts.version ?? '?'} ` +
        `v9=${results[eslintVersions.v9]!.status} v10=${v10.status}` +
        (v10.crashingRules.length > 0 ? ` (${v10.crashingRules.length} crashing rules)` : '') +
        (rescue ? ` rescue=${rescue.attempted ? rescue.verdict : `skipped (${rescue.skipReason})`}` : '')
    );
    return {
      name: spec.name,
      version: facts.version,
      declaredPeerRange: facts.peerRange,
      weeklyDownloads: spec.weeklyDownloads,
      results,
      ...(rescue ? { rescue } : {}),
    };
  });

  const matrix = buildMatrix(eslintVersions, rows, new Date().toISOString());
  await writeMatrix(opts.outFile, matrix);
  const elapsed = Math.round((Date.now() - started) / 1000);
  console.log(`[matrix] wrote ${opts.outFile} (${rows.length} plugins) in ${elapsed}s`);
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main().catch((err: unknown) => {
    console.error(`[matrix] fatal: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}

export { probePair };
