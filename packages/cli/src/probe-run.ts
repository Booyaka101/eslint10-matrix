import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classify, installFail, type ProbeResult } from './classify.js';
import { cacheDir } from './matrix.js';
import type { PluginRunResult, RescueResult } from './matrix.js';
import { COMPAT_SPEC, deriveRescue, rescueEligibility, skippedRescue } from './rescue.js';

const HERE = dirname(fileURLToPath(import.meta.url));
/** Ships beside dist/ in the published package, and in the repo checkout too. */
const PROBE = resolve(HERE, '..', 'probe', 'probe.mjs');

const INSTALL_TIMEOUT_MS = 5 * 60_000;
const PROBE_TIMEOUT_MS = 6 * 60_000;

export interface ProbePlan {
  /** npm specs installed into the isolated environment, eslint included. */
  deps: string[];
  /** What the probe imports: a bare specifier or a file URL. */
  specifier: string;
  namespace: string;
  settings?: Record<string, unknown> | null;
  parserSpecifier?: string | null;
  /** Directory the linted files are relative to. Defaults to the install dir. */
  cwd?: string;
  /** Paths to lint, relative to `cwd`. */
  files: string[];
  /** Record which files each crashing rule broke on. Off for the fixture corpus. */
  recordFiles?: boolean;
  fixup?: boolean;
  /** Runs inside the freshly installed directory before the probe does. */
  prepare?: (dir: string) => Promise<void>;
}

export interface ProbeOptions {
  keepTemp?: boolean;
  /** Reuse installed environments under ~/.cache/eslint10-matrix/envs. */
  cache?: boolean;
  onLog?: (message: string) => void;
}

export interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * `shell` is opt-in per call: npm resolves to npm.cmd on Windows and Node refuses
 * to spawn a .cmd without a shell, while process.execPath lives under
 * "C:\Program Files\..." and gets torn in half by one.
 */
export function run(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  shell = false
): Promise<CommandResult> {
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

function envKey(deps: readonly string[]): string {
  return createHash('sha256').update([...deps].sort().join('\n')).digest('hex').slice(0, 16);
}

export function envsDir(): string {
  return join(cacheDir(), 'envs');
}

const ENV_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Each cached environment is a full npm install, so the directory has to be
 * bounded. Anything untouched for a fortnight is a plugin version nobody scans
 * any more.
 */
export async function pruneEnvs(maxAgeMs = ENV_MAX_AGE_MS): Promise<number> {
  let removed = 0;
  const cutoff = Date.now() - maxAgeMs;
  let entries;
  try {
    entries = await readdir(envsDir(), { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(envsDir(), entry.name);
    try {
      const info = await stat(dir);
      if (info.mtimeMs > cutoff) continue;
      await rm(dir, { recursive: true, force: true, maxRetries: 3 });
      removed += 1;
    } catch {
      /* another scan may be using it: leaving it is always safe */
    }
  }
  return removed;
}

async function npmInstall(dir: string, deps: string[]): Promise<CommandResult> {
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'eslint10-matrix-probe', version: '0.0.0', private: true, type: 'module' }, null, 2)
  );
  // The declared peer range is what we are testing, so a plain install would
  // just refuse to resolve. --legacy-peer-deps installs past it deliberately.
  return run(
    'npm',
    ['install', '--no-audit', '--no-fund', '--no-package-lock', '--legacy-peer-deps', '--loglevel', 'error', ...deps],
    dir,
    INSTALL_TIMEOUT_MS,
    true
  );
}

interface Environment {
  dir: string;
  reused: boolean;
  install?: CommandResult;
}

/**
 * A cached environment is keyed by its exact dependency specs, so reuse can only
 * ever hand back the same install. Building into a temp directory and renaming
 * means a half-finished install is never mistaken for a cache hit.
 */
async function prepareEnvironment(deps: string[], options: ProbeOptions): Promise<Environment> {
  if (!options.cache) {
    const dir = await mkdtemp(join(tmpdir(), 'e10m-'));
    return { dir, reused: false, install: await npmInstall(dir, deps) };
  }

  const target = join(envsDir(), envKey(deps));
  if (existsSync(join(target, 'node_modules'))) return { dir: target, reused: true };

  await mkdir(envsDir(), { recursive: true });
  const staging = await mkdtemp(join(envsDir(), 'staging-'));
  const install = await npmInstall(staging, deps);
  if (install.code !== 0) {
    await rm(staging, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
    return { dir: target, reused: false, install };
  }
  try {
    await rename(staging, target);
  } catch {
    // A parallel scan won the race, or the rename is not permitted here. Either
    // way an existing target is a complete install, and a temp dir is a fallback.
    await rm(staging, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
    if (!existsSync(target)) return { dir: staging, reused: false, install };
  }
  return { dir: target, reused: false, install };
}

/** Installs an isolated environment, runs the probe in it, and classifies the result. */
export async function probe(plan: ProbePlan, options: ProbeOptions = {}): Promise<PluginRunResult> {
  const environment = await prepareEnvironment(plan.deps, options);
  const dir = environment.dir;
  const disposable = !options.cache && !options.keepTemp;
  try {
    const install = environment.install;
    if (install && install.code !== 0) {
      const reason = install.timedOut
        ? `npm install timed out after ${INSTALL_TIMEOUT_MS / 1000}s`
        : install.stderr || install.stdout;
      return installFail(reason);
    }
    if (environment.reused) options.onLog?.(`reusing cached environment ${dir}`);

    await plan.prepare?.(dir);
    await cp(PROBE, join(dir, 'probe.mjs'));
    await writeFile(
      join(dir, 'probe-input.json'),
      JSON.stringify(
        {
          specifier: plan.specifier,
          namespace: plan.namespace,
          settings: plan.settings ?? null,
          parserSpecifier: plan.parserSpecifier ?? null,
          cwd: plan.cwd ?? dir,
          files: plan.files,
          recordFiles: plan.recordFiles ?? false,
          fixup: plan.fixup ?? false,
        },
        null,
        2
      )
    );

    const result = await run(process.execPath, ['probe.mjs'], dir, PROBE_TIMEOUT_MS);
    let parsed: ProbeResult | null = null;
    try {
      parsed = JSON.parse(await readFile(join(dir, 'probe-result.json'), 'utf8')) as ProbeResult;
    } catch {
      parsed = null;
    }
    if (!parsed && result.timedOut) {
      return {
        status: 'load-fail',
        crashingRules: [],
        totalRules: 0,
        detail: `probe timed out after ${PROBE_TIMEOUT_MS / 1000}s`,
      };
    }
    return classify(parsed, result.stderr);
  } catch (err) {
    return installFail(err instanceof Error ? err.message : String(err));
  } finally {
    if (disposable) await rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  }
}

/**
 * Runs only for plugins whose plain v10 result is a regression on ESLint 10.
 * Clean and safe-to-force rows never get a rescue field: a no-op wrap must not
 * be reported as a rescue.
 */
export async function rescuePass(
  results: Record<string, PluginRunResult>,
  eslintVersions: { v9: string; v10: string },
  wrappedPlan: () => ProbePlan | Promise<ProbePlan>,
  options: ProbeOptions = {}
): Promise<RescueResult | undefined> {
  const onNine = results[eslintVersions.v9];
  const onTen = results[eslintVersions.v10]!;
  const eligibility = rescueEligibility(onNine, onTen);
  if (eligibility.kind === 'not-blocked') return undefined;
  if (eligibility.kind === 'skip') return skippedRescue(eslintVersions.v10, eligibility.reason);

  const plan = await wrappedPlan();
  const wrapped = await probe({ ...plan, deps: [...plan.deps, COMPAT_SPEC], fixup: true }, options);
  return deriveRescue(onNine, onTen, wrapped, eslintVersions.v10, eligibility.newlyBroken);
}

/** Shared by the corpus runner and `scan`: both fan out over plugins. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
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
