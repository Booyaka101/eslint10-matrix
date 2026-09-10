import { cp, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { corpusFiles, CORPUS_DIR } from './corpus.js';
import { buildMatrix, writeMatrix } from './emit.js';
import { eslintDistTags, packageFacts } from './registry.js';
import { pluginNamespace } from '../../cli/dist/snippet.js';
import { mapWithConcurrency, probe, rescuePass, type ProbePlan } from '../../cli/dist/probe-run.js';
import type { PluginRow, PluginRunResult, PluginSpec } from './types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, '..');
const REPO_ROOT = resolve(PACKAGE_ROOT, '..', '..');
const PLUGINS_JSON = join(PACKAGE_ROOT, 'src', 'plugins.json');

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

async function corpusPlan(spec: PluginSpec, eslintVersion: string): Promise<ProbePlan> {
  return {
    deps: [`eslint@${eslintVersion}`, `${spec.name}@latest`, ...(spec.extraDeps ?? [])],
    specifier: spec.name,
    namespace: spec.namespace ?? pluginNamespace(spec.name),
    settings: spec.settings ?? null,
    parserSpecifier: spec.parser ?? null,
    files: await corpusFiles(),
    prepare: (dir) => cp(CORPUS_DIR, join(dir, 'fixtures'), { recursive: true }),
  };
}

export async function loadPlugins(): Promise<PluginSpec[]> {
  if (!existsSync(PLUGINS_JSON)) throw new Error(`plugin list missing: ${PLUGINS_JSON}`);
  const doc = JSON.parse(await readFile(PLUGINS_JSON, 'utf8')) as { plugins?: PluginSpec[] };
  if (!Array.isArray(doc.plugins) || doc.plugins.length === 0) {
    throw new Error(`${PLUGINS_JSON} does not contain a non-empty "plugins" array`);
  }
  return doc.plugins;
}

export async function probePair(spec: PluginSpec, eslintVersion: string, keepTemp: boolean): Promise<PluginRunResult> {
  return probe(await corpusPlan(spec, eslintVersion), { keepTemp });
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
    const rescue = await rescuePass(results, eslintVersions, () => corpusPlan(spec, eslintVersions.v10), {
      keepTemp: opts.keepTemp,
    });
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
