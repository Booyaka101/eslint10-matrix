import { readFile, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { findUp } from './find-up.js';

const CONFIG_NAMES = [
  'eslint.config.js',
  'eslint.config.mjs',
  'eslint.config.cjs',
  'eslint.config.ts',
  'eslint.config.mts',
  'eslint.config.cts',
];

export class ConfigError extends Error {
  constructor(message: string, readonly hint?: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

const ESLINTRC_NAMES = ['.eslintrc.js', '.eslintrc.cjs', '.eslintrc.yaml', '.eslintrc.yml', '.eslintrc.json', '.eslintrc'];

export interface ResolvedConfig {
  configPath: string;
  projectDir: string;
  /** Plugin package names present in package.json and used by the config. */
  plugins: string[];
  /** Config keys whose package could not be identified in package.json. */
  unknown: string[];
  /** Config keys mapped to the package they resolved to, for reporting. */
  keys: Record<string, string>;
  /** Every `ignores` pattern in the config, in declaration order. */
  ignores: string[];
  /** Merged `settings`, minus anything that will not survive JSON. */
  settings: Record<string, unknown>;
}

export function findConfigFile(startDir: string): string | null {
  return findUp(startDir, ...CONFIG_NAMES);
}

export async function readDependencies(projectDir: string): Promise<Record<string, string>> {
  const manifestPath = join(projectDir, 'package.json');
  if (!existsSync(manifestPath)) return {};
  try {
    const doc = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, Record<string, string>>;
    return { ...doc.dependencies, ...doc.devDependencies, ...doc.peerDependencies, ...doc.optionalDependencies };
  } catch {
    return {};
  }
}

/**
 * npm/yarn/pnpm workspace globs. `scan` measures one config, so a monorepo root
 * needs to be told that the packages under it were not walked.
 */
export async function readWorkspaces(projectDir: string): Promise<string[]> {
  const pnpm = join(projectDir, 'pnpm-workspace.yaml');
  if (existsSync(pnpm)) {
    try {
      const text = await readFile(pnpm, 'utf8');
      const globs: string[] = [];
      let inPackages = false;
      for (const raw of text.split('\n')) {
        const line = raw.replace(/#.*$/, '').trimEnd();
        if (/^\S/.test(line)) inPackages = line.trim() === 'packages:';
        else if (inPackages && line.trim().startsWith('- ')) {
          globs.push(line.trim().slice(2).trim().replace(/^['"]|['"]$/g, ''));
        }
      }
      if (globs.length > 0) return globs;
    } catch {
      /* an unreadable workspace file is not worth failing a scan over */
    }
  }
  try {
    const doc = JSON.parse(await readFile(join(projectDir, 'package.json'), 'utf8')) as {
      workspaces?: string[] | { packages?: string[] };
    };
    const globs = Array.isArray(doc.workspaces) ? doc.workspaces : doc.workspaces?.packages;
    return (globs ?? []).filter((g) => typeof g === 'string');
  } catch {
    return [];
  }
}

export function looksLikePluginPackage(name: string): boolean {
  return (
    name.includes('eslint-plugin') ||
    name === 'typescript-eslint' ||
    name.endsWith('/eslint-plugin') ||
    /^@[^/]+\/eslint-plugin(-|$)/.test(name)
  );
}

/** `x` -> eslint-plugin-x, `@scope/x` -> @scope/eslint-plugin-x, `@scope` -> @scope/eslint-plugin. */
export function conventionalPackageNames(configKey: string): string[] {
  if (configKey.startsWith('@')) {
    const slash = configKey.indexOf('/');
    if (slash === -1) return [`${configKey}/eslint-plugin`];
    const scope = configKey.slice(0, slash);
    const rest = configKey.slice(slash + 1);
    return [`${scope}/eslint-plugin-${rest}`, `${scope}/eslint-plugin`];
  }
  return [`eslint-plugin-${configKey}`, configKey];
}

interface ConfigContents {
  plugins: Map<string, unknown>;
  ignores: string[];
  settings: Record<string, unknown>;
}

/** Walks arrays, nested arrays and single objects; flat config permits all three. */
function collectPluginEntries(value: unknown, out: ConfigContents, depth = 0): void {
  if (!value || depth > 8) return;
  if (Array.isArray(value)) {
    for (const item of value) collectPluginEntries(item, out, depth + 1);
    return;
  }
  if (typeof value !== 'object') return;
  const entry = value as { plugins?: unknown; ignores?: unknown; settings?: unknown };
  if (entry.plugins && typeof entry.plugins === 'object' && !Array.isArray(entry.plugins)) {
    for (const [key, mod] of Object.entries(entry.plugins as Record<string, unknown>)) {
      if (!out.plugins.has(key)) out.plugins.set(key, mod);
    }
  }
  // A flat-config object whose only key is `ignores` is the global ignore list.
  // Beside `files` it scopes that block instead, and hoisting it would skip
  // files ESLint still lints.
  if (Array.isArray(entry.ignores) && Object.keys(entry).length === 1) {
    for (const pattern of entry.ignores) {
      if (typeof pattern === 'string' && !out.ignores.includes(pattern)) out.ignores.push(pattern);
    }
  }
  if (entry.settings && typeof entry.settings === 'object') {
    Object.assign(out.settings, jsonSafe(entry.settings) as Record<string, unknown>);
  }
}

/**
 * Settings travel to the probe as JSON, and real configs put functions and
 * regexes in there. Dropping those is better than failing the whole scan, and
 * the settings that matter for compatibility (react.version and friends) are
 * plain data.
 */
function jsonSafe(value: unknown, depth = 0): unknown {
  if (value === null || depth > 6) return null;
  if (Array.isArray(value)) return value.map((item) => jsonSafe(item, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const safe = jsonSafe(item, depth + 1);
      if (safe !== undefined) out[key] = safe;
    }
    return out;
  }
  return ['string', 'number', 'boolean'].includes(typeof value) ? value : undefined;
}

/**
 * Modern plugins self-identify through meta.name; older ones do not, so we fall
 * back to matching the loaded object against each dependency's own export and
 * finally to the naming convention. A key we cannot pin to an installed package
 * is reported as unknown rather than guessed at.
 *
 * meta.name is not always the package name. eslint-plugin-vitest@0.5.4 reports
 * `vitest`, which in a repo that also depends on the test runner would resolve
 * to the wrong package entirely, so a declared name that is not plugin-shaped
 * only counts once the naming convention has had its turn.
 */
async function identifyPackage(
  configKey: string,
  pluginModule: unknown,
  deps: Record<string, string>,
  projectDir: string
): Promise<string | null> {
  const meta = (pluginModule as { meta?: { name?: unknown } } | null)?.meta;
  const declared = typeof meta?.name === 'string' ? meta.name : null;
  if (declared && deps[declared] && looksLikePluginPackage(declared)) return declared;

  for (const candidate of conventionalPackageNames(configKey)) {
    if (deps[candidate]) return candidate;
  }

  if (pluginModule && typeof pluginModule === 'object') {
    for (const dep of Object.keys(deps).filter(looksLikePluginPackage)) {
      try {
        const mod = (await import(await resolveFrom(dep, projectDir))) as Record<string, unknown>;
        const exported = mod.default ?? mod;
        if (exported === pluginModule) return dep;
        if ((exported as { default?: unknown })?.default === pluginModule) return dep;
      } catch {
        /* dependency not installed or not importable: keep looking */
      }
    }
  }

  if (declared) return deps[declared] ? declared : null;
  return null;
}

async function resolveFrom(specifier: string, fromDir: string): Promise<string> {
  const { createRequire } = await import('node:module');
  const require = createRequire(pathToFileURL(join(fromDir, 'package.json')));
  return pathToFileURL(require.resolve(specifier)).href;
}

export async function resolveConfig(startDir: string): Promise<ResolvedConfig> {
  const configPath = findConfigFile(startDir);
  if (!configPath) {
    const legacy = findEslintrc(startDir);
    if (legacy) {
      throw new ConfigError(
        `${legacy} is a legacy eslintrc config, and ESLint 10 removed eslintrc entirely`,
        'Migrate to flat config first: npx @eslint/migrate-config .eslintrc. Until then no plugin version can make this repo run on ESLint 10, ' +
          'so the answer to "can I upgrade" is no for a reason this tool cannot measure.'
      );
    }
    throw new ConfigError(
      `no ESLint flat config found in ${resolve(startDir)} or any parent directory`,
      `eslint10-matrix reads flat config only. Create one of ${CONFIG_NAMES.join(', ')}. ` +
        'Legacy .eslintrc files are not supported: ESLint 10 removed eslintrc, so a repo still on it has a larger migration than this tool measures.'
    );
  }

  const projectDir = dirname(configPath);
  const deps = await readDependencies(projectDir);

  let exported: unknown;
  try {
    // Import through the resolved real path: a Windows 8.3 short name such as
    // RUNNER~1 percent-encodes to %7E in a file URL and fails to resolve, and a
    // symlinked checkout would otherwise import under the wrong identity.
    const mod = (await import(pathToFileURL(await realpath(configPath)).href)) as { default?: unknown };
    exported = mod.default ?? mod;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ConfigError(`could not import ${configPath}: ${message}`, importHint(configPath, message));
  }

  if (typeof exported === 'function') {
    throw new ConfigError(
      `${configPath} default-exports a function`,
      'Config functions are resolved by the ESLint CLI, not by this tool. Export the resolved array instead, or run with --plugins to list them explicitly.'
    );
  }

  const contents: ConfigContents = { plugins: new Map(), ignores: [], settings: {} };
  collectPluginEntries(exported, contents);

  const plugins: string[] = [];
  const unknown: string[] = [];
  const keys: Record<string, string> = {};
  for (const [key, mod] of contents.plugins) {
    const pkg = await identifyPackage(key, mod, deps, projectDir);
    if (pkg) {
      keys[key] = pkg;
      if (!plugins.includes(pkg)) plugins.push(pkg);
    } else if (!unknown.includes(key)) {
      unknown.push(key);
    }
  }

  return {
    configPath,
    projectDir,
    plugins: plugins.sort(),
    unknown: unknown.sort(),
    keys,
    ignores: contents.ignores,
    settings: contents.settings,
  };
}

/** Reported as a blocking answer of its own: eslintrc cannot run on ESLint 10 at all. */
export function findEslintrc(startDir: string): string | null {
  return findUp(startDir, ...ESLINTRC_NAMES);
}

function importHint(configPath: string, message: string): string {
  if (/\.[cm]?ts$/.test(configPath) && /Unknown file extension|ERR_UNKNOWN_FILE_EXTENSION|strip/i.test(message)) {
    return 'A TypeScript config needs Node 22.18+ (type stripping) or a loader such as jiti. Compile it, or pass --plugins with the package names.';
  }
  if (/Cannot find package|ERR_MODULE_NOT_FOUND/i.test(message)) {
    return 'The config imports a package that is not installed here. Run your package manager\'s install first.';
  }
  return 'Check that the config imports resolve from this directory.';
}
