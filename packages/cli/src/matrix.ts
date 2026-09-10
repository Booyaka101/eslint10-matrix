import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_MATRIX_URL = 'https://booyaka101.github.io/eslint10-matrix/matrix.json';

export type Status = 'clean' | 'rule-crash' | 'load-fail' | 'install-fail';

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
      'Pass --matrix with a path to a matrix.json, or omit it to fetch the published one.'
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
      if (res.status === 404) throw new Error(`HTTP 404 - no matrix published at ${url}`);
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

  throw new MatrixError(
    `could not fetch the matrix from ${url} (${networkError}) and no cached copy is available`,
    'Check your network, or pass --matrix <path-to-matrix.json> to use a local copy.'
  );
}

export function rowFor(matrix: Matrix, packageName: string): PluginRow | undefined {
  return matrix.plugins.find((p) => p.name === packageName);
}
