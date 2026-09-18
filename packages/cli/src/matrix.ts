import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_MATRIX_URL = 'https://booyaka101.github.io/eslint10-matrix/matrix.json';

export type Status = 'clean' | 'rule-crash' | 'load-fail' | 'install-fail' | 'harness-misconfig';

/** Why a measurement says more about our environment than about the plugin. */
export type HarnessCause = 'missing-peer' | 'parser-unavailable' | 'ast-shape' | 'corpus-unparsed';

export interface HarnessFinding {
  cause: HarnessCause;
  /** The package, parser or directory the cause is about. Keeps a report line short. */
  subject: string;
  detail: string;
  fix: string;
}

export interface HarnessRule extends CrashingRule, HarnessFinding {}

/** Rules excluded from a verdict because the environment was wrong, not the plugin. */
export interface HarnessReport {
  rules: HarnessRule[];
}

export interface CrashingRule {
  rule: string;
  message: string;
  /** `scan` only: the first repo file the rule crashed on, relative to the repo root. */
  file?: string;
  /** `scan` only: how many scanned files the rule crashed on, when more than one. */
  fileCount?: number;
  /** Set when the count above is a floor: attribution stopped at the evidence cap. */
  fileCountCapped?: boolean;
}

/**
 * What was actually on disk when the run happened, read back out of the probe's
 * own node_modules. A spec is a wish and a range resolves differently on
 * different days, so a verdict that does not carry this cannot say which
 * environment produced it. `null` means we asked npm for the package and it was
 * not there afterwards, which is the interesting case.
 */
export interface MeasuredEnv {
  node: string;
  npm: string | null;
  deps: Record<string, string | null>;
}

export interface PluginRunResult {
  status: Status;
  crashingRules: CrashingRule[];
  totalRules: number;
  /** Populated for install-fail and load-fail so the reader can see why. */
  detail?: string;
  /** Set on rescue-pass results: which @eslint/compat function produced this run. */
  fixupFunction?: FixupFunction;
  /** Set when fixupConfigRules was used: the plugin config key it wrapped. */
  fixupConfigKey?: string;
  /** The run supplied a `parser`, so a crash reading AST fields is on us. */
  parserRequested?: boolean;
  /** Whether that parser imported. Only meaningful alongside parserRequested. */
  parserLoaded?: boolean;
  /** Fatal messages carrying no rule id: files that did not parse at all. */
  parseErrors?: number;
  /** The denominator for `parseErrors`. Recorded only alongside it. */
  lintedFiles?: number;
  /** Present when `partitionHarness` moved rules off this result. */
  harness?: HarnessReport;
  /** The resolved environment this run happened in. Absent when nothing installed. */
  measuredWith?: MeasuredEnv;
}

export type FixupFunction = 'fixupPluginRules' | 'fixupConfigRules';

export type RescueVerdict = 'rescuable' | 'partial-rescue' | 'blocked';

/** Outcome of re-running a blocked plugin wrapped by @eslint/compat. */
export interface RescueResult {
  eslintVersion: string;
  compatVersion: string;
  attempted: boolean;
  verdict: RescueVerdict;
  skipReason?: string;
  fixupFunction?: FixupFunction;
  fixupConfigKey?: string;
  crashingRulesBefore?: number;
  crashingRulesAfter?: number;
  residualRules?: CrashingRule[];
  preexistingRulesAfter?: number;
  detail?: string;
}

export interface PluginRow {
  name: string;
  version: string | null;
  declaredPeerRange: string | null;
  weeklyDownloads: number;
  results: Record<string, PluginRunResult>;
  rescue?: RescueResult;
}

export interface Matrix {
  schemaVersion: number;
  generatedAt: string;
  eslintVersions: { v9: string; v10: string };
  plugins: PluginRow[];
}

export interface MatrixLoad {
  matrix: Matrix;
  source: 'network' | 'cache' | 'file';
  /** Set when the network failed and a cached copy was used instead. */
  staleReason?: string;
  cachedAt?: string;
}

export class MatrixError extends Error {
  constructor(message: string, readonly hint?: string) {
    super(message);
    this.name = 'MatrixError';
  }
}

export function cacheDir(): string {
  const base = process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache');
  return join(base, 'eslint10-matrix');
}

export function cachePath(): string {
  return join(cacheDir(), 'matrix.json');
}

export function assertMatrixShape(value: unknown): asserts value is Matrix {
  const m = value as Partial<Matrix> | null;
  if (!m || typeof m !== 'object') throw new MatrixError('matrix document is not an object');
  if (m.schemaVersion !== 1) {
    throw new MatrixError(
      `unsupported matrix schemaVersion: ${String(m.schemaVersion)}`,
      'Upgrade the CLI: npm install -g eslint10-matrix@latest'
    );
  }
  if (!m.eslintVersions?.v9 || !m.eslintVersions?.v10) throw new MatrixError('matrix is missing eslintVersions');
  if (!Array.isArray(m.plugins)) throw new MatrixError('matrix is missing a plugins array');
}

async function readCache(): Promise<{ matrix: Matrix; cachedAt: string } | null> {
  try {
    const path = cachePath();
    const [raw, info] = await Promise.all([readFile(path, 'utf8'), stat(path)]);
    const parsed = JSON.parse(raw) as unknown;
    assertMatrixShape(parsed);
    return { matrix: parsed, cachedAt: info.mtime.toISOString() };
  } catch {
    return null;
  }
}

async function writeCache(matrix: Matrix): Promise<void> {
  try {
    await mkdir(cacheDir(), { recursive: true });
    await writeFile(cachePath(), JSON.stringify(matrix), 'utf8');
  } catch {
    /* a read-only cache directory must never fail the command */
  }
}

function isHttpUrl(source: string): boolean {
  try {
    return ['http:', 'https:'].includes(new URL(source).protocol);
  } catch {
    return false;
  }
}

async function loadFromFile(path: string): Promise<MatrixLoad> {
  let raw: string;
  try {
    raw = await readFile(resolve(path), 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    throw new MatrixError(
      code === 'ENOENT' ? `matrix file not found: ${resolve(path)}` : `could not read ${resolve(path)}: ${String(err)}`,
      'Give a matrix.json path or an http(s) URL. check reads the published board when you give it neither.'
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new MatrixError(`${resolve(path)} is not valid JSON`);
  }
  assertMatrixShape(parsed);
  return { matrix: parsed, source: 'file' };
}

export async function loadMatrix(options: {
  url?: string;
  file?: string;
  noCache?: boolean;
  timeoutMs?: number;
} = {}): Promise<MatrixLoad> {
  if (options.file) return loadFromFile(options.file);

  const source = options.url ?? DEFAULT_MATRIX_URL;
  const timeoutMs = options.timeoutMs ?? 15_000;

  if (source.startsWith('file:')) return loadFromFile(fileURLToPath(source));
  // Anything that is not http(s) is a path. A bare `--matrix matrix.json` used to
  // parse as a URL, fail to fetch, and fall back to the cached board without
  // saying that the file had been ignored.
  if (!isHttpUrl(source)) return loadFromFile(source);
  const url = source;

  let networkError: string;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } });
      if (res.status === 429) {
        const retryAfter = res.headers.get('retry-after');
        throw new Error(`rate limited (HTTP 429)${retryAfter ? `, retry after ${retryAfter}s` : ''}`);
      }
      if (res.status === 404) throw new Error('HTTP 404 - nothing published there');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const parsed = (await res.json()) as unknown;
      assertMatrixShape(parsed);
      if (!options.noCache) await writeCache(parsed);
      return { matrix: parsed, source: 'network' };
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    if (err instanceof MatrixError) throw err;
    const raw = err instanceof Error ? err.message : String(err);
    networkError = /abort/i.test(raw) ? `timed out after ${timeoutMs / 1000}s` : raw;
  }

  if (!options.noCache) {
    const cached = await readCache();
    if (cached) {
      return { matrix: cached.matrix, source: 'cache', staleReason: networkError, cachedAt: cached.cachedAt };
    }
  }

  // "no cached copy" would be a lie when --no-cache told us not to look for one.
  const cacheNote = options.noCache ? '' : ' and no cached copy is available';
  throw new MatrixError(
    `could not fetch the matrix from ${url}: ${networkError}${cacheNote}`,
    'Check your network, or point the command at a local matrix.json instead.'
  );
}

export function rowFor(matrix: Matrix, packageName: string): PluginRow | undefined {
  return matrix.plugins.find((p) => p.name === packageName);
}
