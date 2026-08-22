import { readFile, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, parse, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

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

export interface ResolvedConfig {
  configPath: string;
  projectDir: string;
  /** Plugin package names present in package.json and used by the config. */
  plugins: string[];
  /** Config keys whose package could not be identified in package.json. */
  unknown: string[];
}

export function findConfigFile(startDir: string): string | null {
  let dir = resolve(startDir);
  const { root } = parse(dir);
  for (;;) {
    for (const name of CONFIG_NAMES) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
    if (dir === root) return null;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

async function readDependencies(projectDir: string): Promise<Record<string, string>> {
  const manifestPath = join(projectDir, 'package.json');
  if (!existsSync(manifestPath)) return {};
  try {
    const doc = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, Record<string, string>>;
    return { ...doc.dependencies, ...doc.devDependencies, ...doc.peerDependencies, ...doc.optionalDependencies };
  } catch {
    return {};
  }
}

function looksLikePluginPackage(name: string): boolean {
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

/** Walks arrays, nested arrays and single objects; flat config permits all three. */
function collectPluginEntries(value: unknown, out: Map<string, unknown>, depth = 0): void {
  if (!value || depth > 8) return;
  if (Array.isArray(value)) {
    for (const item of value) collectPluginEntries(item, out, depth + 1);
    return;
  }
  if (typeof value !== 'object') return;
  const plugins = (value as { plugins?: unknown }).plugins;
  if (plugins && typeof plugins === 'object' && !Array.isArray(plugins)) {
    for (const [key, mod] of Object.entries(plugins as Record<string, unknown>)) {
      if (!out.has(key)) out.set(key, mod);
    }
  }
}

/**
 * Modern plugins self-identify through meta.name; older ones do not, so we fall
 * back to matching the loaded object against each dependency's own export and
 * finally to the naming convention. A key we cannot pin to an installed package
 * is reported as unknown rather than guessed at.
 */
async function identifyPackage(
  configKey: string,
  pluginModule: unknown,
  deps: Record<string, string>,
  projectDir: string
): Promise<string | null> {
  const meta = (pluginModule as { meta?: { name?: unknown } } | null)?.meta;
  const declared = typeof meta?.name === 'string' ? meta.name : null;
  if (declared && deps[declared]) return declared;

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

  const entries = new Map<string, unknown>();
  collectPluginEntries(exported, entries);

  const plugins: string[] = [];
  const unknown: string[] = [];
  for (const [key, mod] of entries) {
    const pkg = await identifyPackage(key, mod, deps, projectDir);
    if (pkg) {
      if (!plugins.includes(pkg)) plugins.push(pkg);
    } else if (!unknown.includes(key)) {
      unknown.push(key);
    }
  }

  return { configPath, projectDir, plugins: plugins.sort(), unknown: unknown.sort() };
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
