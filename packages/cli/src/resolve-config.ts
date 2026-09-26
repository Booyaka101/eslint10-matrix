import { readFile, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { findUp } from './find-up.js';
import { findInstalledManifest, readInstalled, readJsonFile } from './installed.js';

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
  /** Plugin packages that reach the config through a shared config rather than package.json. */
  via: Record<string, SharedConfigSource>;
  /** Why a key in `unknown` is there, where the default reason would mislead. */
  unknownReasons: Record<string, string>;
  /** Anything about how the plugins were attributed that the report should say. */
  notes: string[];
  /** Parsers a shared config sets, which run on ESLint 10 unmeasured. */
  parsers: string[];
}

export interface SharedConfigSource {
  /** The dependency package.json names, which is what the reader will recognise. */
  config: string;
  configVersion: string;
  /** Where the plugin resolves from: that config's install, or the config it pulls in. */
  dir: string;
  /** The config the root pulls in that registers the plugin, when that is not the root itself. */
  through?: string;
  /**
   * What of the config's main export goes in the array: the export itself when
   * absent, a call to it for a factory like neostandard, or one of its `configs`.
   */
  spread?: 'call' | `configs.${string}`;
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

/**
 * A package that registers plugins on the caller's behalf. typescript-eslint is
 * one in all but name: it depends on @typescript-eslint/eslint-plugin and its
 * configs register it, and eslint-config-next pulls it in the same way.
 */
export function looksLikeSharedConfig(name: string): boolean {
  return name === 'typescript-eslint' || /^(@[^/]+\/)?eslint-config(-|$)/.test(name);
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

/** Carry no semantics of their own, so a block holding only these plus `ignores` is still a global ignore. */
const CONFIG_META_KEYS = new Set(['name', 'basePath']);

interface ConfigContents {
  plugins: Map<string, unknown>;
  ignores: string[];
  settings: Record<string, unknown>;
  /** Parser meta.name to the `files` of the first block that sets it. */
  parsers: Map<string, string[]>;
}

/** Walks arrays, nested arrays and single objects; flat config permits all three. */
function collectPluginEntries(value: unknown, out: ConfigContents, depth = 0): void {
  if (!value || depth > 8) return;
  if (Array.isArray(value)) {
    for (const item of value) collectPluginEntries(item, out, depth + 1);
    return;
  }
  if (typeof value !== 'object') return;
  const entry = value as {
    plugins?: unknown;
    ignores?: unknown;
    settings?: unknown;
    basePath?: unknown;
    files?: unknown;
    languageOptions?: { parser?: { meta?: { name?: unknown } } };
  };
  if (entry.plugins && typeof entry.plugins === 'object' && !Array.isArray(entry.plugins)) {
    for (const [key, mod] of Object.entries(entry.plugins as Record<string, unknown>)) {
      if (!out.plugins.has(key)) out.plugins.set(key, mod);
    }
  }
  // A flat-config object whose only key is `ignores` is the global ignore list.
  // Beside `files` it scopes that block instead, and hoisting it would skip
  // files ESLint still lints. `name` and `basePath` are metadata and do not
  // count, which is the shape ESLint's own globalIgnores() emits.
  const significant = Object.keys(entry).filter((key) => !CONFIG_META_KEYS.has(key));
  if (Array.isArray(entry.ignores) && significant.length === 1) {
    const base = typeof entry.basePath === 'string' ? entry.basePath : '';
    for (const pattern of entry.ignores) {
      if (typeof pattern !== 'string') continue;
      const scoped = base ? `${base.replace(/\/+$/, '')}/${pattern.replace(/^\.\//, '')}` : pattern;
      if (!out.ignores.includes(scoped)) out.ignores.push(scoped);
    }
  }
  const parser = entry.languageOptions?.parser?.meta?.name;
  if (typeof parser === 'string' && !out.parsers.has(parser)) {
    out.parsers.set(parser, Array.isArray(entry.files) ? entry.files.filter((f) => typeof f === 'string') : []);
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
 *
 * `deps` and `fromDir` are the project's own, or a shared config's when the
 * plugin arrives through one: the same three steps answer both. A package not
 * named like a config gets no say by name, since depending on eslint-plugin-react
 * does not mean registering it: only meta.name or the object itself counts.
 */
async function identifyPackage(
  configKey: string,
  pluginModule: unknown,
  deps: Record<string, string>,
  fromDir: string,
  guessByName = true
): Promise<string | null> {
  const meta = (pluginModule as { meta?: { name?: unknown } } | null)?.meta;
  const declared = typeof meta?.name === 'string' ? meta.name : null;
  if (declared && deps[declared] && looksLikePluginPackage(declared)) return declared;

  // The bare key is a candidate only when it names a plugin package: `react` is
  // the key eslint-plugin-react registers under and also a dependency of every
  // React app, so reached through a shared config it would name the library.
  for (const candidate of guessByName ? conventionalPackageNames(configKey) : []) {
    if (deps[candidate] && (candidate !== configKey || looksLikePluginPackage(candidate))) return candidate;
  }

  for (const dep of Object.keys(deps).filter(looksLikePluginPackage)) {
    if (await isLoadedFrom(dep, fromDir, pluginModule)) return dep;
  }

  if (declared) return deps[declared] ? declared : null;
  return null;
}

/** Whether `dep`, resolved the way Node would from `fromDir`, is the object the config registered. */
async function isLoadedFrom(dep: string, fromDir: string, pluginModule: unknown): Promise<boolean> {
  if (!pluginModule || typeof pluginModule !== 'object') return false;
  try {
    const mod = (await import(await resolveFrom(dep, fromDir))) as Record<string, unknown>;
    const exported = mod.default ?? mod;
    return exported === pluginModule || (exported as { default?: unknown })?.default === pluginModule;
  } catch {
    return false;
  }
}

/** A factory is called and typescript-eslint is spread through its configs; anything else is spread as is. */
async function spreadOf(name: string, projectDir: string): Promise<SharedConfigSource['spread']> {
  try {
    const mod = (await import(await resolveFrom(name, projectDir))) as { default?: unknown };
    const exported = mod.default ?? mod;
    if (typeof exported === 'function') return 'call';
    const configs = (exported as { configs?: unknown } | null)?.configs;
    if (!Array.isArray(exported) && configs && typeof configs === 'object') {
      const keys = Object.keys(configs);
      const key = keys.find((k) => /recommended/i.test(k)) ?? keys[0];
      if (key) return `configs.${key}`;
    }
  } catch {
    /* no importable main entry: the plain spread is the best guess */
  }
  return undefined;
}

/** The first source whose copy of `pkg` is the very object the config registered. */
async function sourceThatLoads(pkg: string, pluginModule: unknown, sources: SharedSource[]): Promise<SharedSource | undefined> {
  for (const source of sources) {
    if (source.from.deps[pkg] && (await isLoadedFrom(pkg, source.from.dir, pluginModule))) return source;
  }
  return undefined;
}

async function viaSource({ root, from }: SharedSource, projectDir: string): Promise<SharedConfigSource> {
  const spread = await spreadOf(root.name, projectDir);
  return {
    config: root.name,
    configVersion: root.version,
    dir: from.dir,
    ...(from !== root ? { through: from.name } : {}),
    ...(spread ? { spread } : {}),
  };
}

async function resolveFrom(specifier: string, fromDir: string): Promise<string> {
  const { createRequire } = await import('node:module');
  const require = createRequire(pathToFileURL(join(fromDir, 'package.json')));
  return pathToFileURL(require.resolve(specifier)).href;
}

interface SharedConfig {
  name: string;
  version: string;
  /** Real path, so a pnpm symlink lands in the store where its own deps sit beside it. */
  dir: string;
  deps: Record<string, string>;
}

async function readSharedConfig(name: string, fromDir: string): Promise<SharedConfig | null> {
  const manifestPath = findInstalledManifest(name, fromDir);
  if (!manifestPath) return null;
  const dir = await realpath(dirname(manifestPath)).catch(() => null);
  const doc = dir
    ? await readJsonFile<{ version?: string; dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> }>(
        join(dir, 'package.json')
      )
    : null;
  if (!dir || !doc) return null;
  // A peer is the caller's to install, so it is already a direct dependency or not there at all.
  return { name, version: String(doc.version ?? ''), dir, deps: { ...doc.dependencies, ...doc.optionalDependencies } };
}

interface SharedSource {
  /** The direct dependency, named in the report. */
  root: SharedConfig;
  /** Whose dependencies are searched: the root itself, or a config the root depends on. */
  from: SharedConfig;
  /** Whether the root is named like a config, and so trusted to register what it depends on. */
  named: boolean;
}

/**
 * Every shared config in package.json order, each followed by the configs it
 * depends on, one level down: eslint-config-next brings typescript-eslint, and
 * that is where @typescript-eslint/eslint-plugin comes from. After them, any
 * other dependency that depends on plugins, since neostandard and angular-eslint
 * register theirs without being named like a config.
 */
async function sharedSources(
  deps: Record<string, string>,
  projectDir: string
): Promise<{ sources: SharedSource[]; missing: string[] }> {
  const sources: SharedSource[] = [];
  const missing: string[] = [];
  // Yarn PnP has no node_modules to walk, and "run install" would be false advice there.
  if (findUp(projectDir, '.pnp.cjs', '.pnp.js')) return { sources, missing };
  const names = Object.keys(deps);
  const bringsPlugins = (dep: string) => looksLikePluginPackage(dep) || looksLikeSharedConfig(dep);
  for (const name of [...names.filter(looksLikeSharedConfig), ...names.filter((n) => !looksLikeSharedConfig(n))]) {
    const named = looksLikeSharedConfig(name);
    const root = await readSharedConfig(name, projectDir);
    if (!root) {
      if (named) missing.push(name);
      continue;
    }
    if (!named && !Object.keys(root.deps).some(bringsPlugins)) continue;
    sources.push({ root, from: root, named });
    for (const nested of Object.keys(root.deps).filter(looksLikeSharedConfig)) {
      const from = await readSharedConfig(nested, root.dir);
      if (from) sources.push({ root, from, named });
    }
  }
  return { sources, missing };
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

  const contents: ConfigContents = { plugins: new Map(), ignores: [], settings: {}, parsers: new Map() };
  collectPluginEntries(exported, contents);

  const plugins: string[] = [];
  const unknown: string[] = [];
  const keys: Record<string, string> = {};
  const via: Record<string, SharedConfigSource> = {};
  const unknownReasons: Record<string, string> = {};
  const notes: string[] = [];
  let shared: Awaited<ReturnType<typeof sharedSources>> | undefined;
  for (const [key, mod] of contents.plugins) {
    let pkg = await identifyPackage(key, mod, deps, projectDir);
    // package.json names the plugin, but a config that nests its own copy
    // registers that one, and it is the copy ESLint runs.
    if (pkg && looksLikePluginPackage(pkg) && !via[pkg] && !(await isLoadedFrom(pkg, projectDir, mod))) {
      shared ??= await sharedSources(deps, projectDir);
      const source = await sourceThatLoads(pkg, mod, shared.sources);
      if (source) {
        via[pkg] = await viaSource(source, projectDir);
        const [ours, theirs] = await Promise.all([readInstalled(pkg, projectDir), readInstalled(pkg, source.from.dir)]);
        notes.push(
          `${pkg}${ours ? `@${ours.version}` : ''} in package.json is not the copy eslint.config loads: ` +
            `${source.root.name} registers its own${theirs ? ` ${theirs.version}` : ''}, so that is the one measured`
        );
      }
    }
    if (!pkg) {
      shared ??= await sharedSources(deps, projectDir);
      let first: SharedSource | undefined;
      for (const source of shared.sources) {
        pkg = await identifyPackage(key, mod, source.from.deps, source.from.dir, source.named);
        if (pkg) {
          first = source;
          break;
        }
      }
      if (pkg && first && !via[pkg] && !deps[pkg]) {
        // Configs that each nest their own copy register different objects, and
        // only the one eslint.config loaded says which copy runs.
        const loaded = await sourceThatLoads(pkg, mod, shared.sources);
        const source = loaded ?? first;
        via[pkg] = await viaSource(source, projectDir);
        const also = [
          ...new Set(
            shared.sources.filter((s) => s.named && s.root !== source.root && s.from.deps[pkg!]).map((s) => s.root.name)
          ),
        ];
        if (also.length > 0) {
          notes.push(
            `${pkg} arrives through ${[source.root.name, ...also].join(' and ')}; measured the copy ${source.root.name} ` +
              (loaded ? 'registers, which is the one eslint.config loads' : 'installed, which comes first in package.json')
          );
        }
      }
      if (!pkg && shared.missing.length > 0) {
        unknownReasons[key] =
          `may arrive through ${shared.missing.join(' or ')}, which ${shared.missing.length === 1 ? 'is' : 'are'} ` +
          'not installed where eslint10-matrix looked; run install and try again';
      }
    }
    if (pkg) {
      keys[key] = pkg;
      if (!plugins.includes(pkg)) plugins.push(pkg);
    } else if (!unknown.includes(key)) {
      unknown.push(key);
    }
  }

  // A parser a shared config bundles is not on the board, and it runs on every
  // file its block matches whether or not the plugins do: eslint-config-next's
  // crashes ESLint 10 on .js and .mjs files with every plugin rescued.
  const parsers: string[] = [];
  for (const [parser, files] of contents.parsers) {
    const config = /^(@[^/]+\/)?[^/]+/.exec(parser)?.[0];
    if (!config || config === parser || config === 'typescript-eslint' || !looksLikeSharedConfig(config)) continue;
    parsers.push(parser);
    const scope = files.length > 0 ? ` for ${files.join(', ')}` : '';
    notes.push(`${config} sets its own parser (${parser})${scope}; eslint10-matrix measures plugins, not parsers, so nothing here says it runs on ESLint 10`);
  }

  return {
    configPath,
    projectDir,
    plugins: plugins.sort(),
    unknown: unknown.sort(),
    keys,
    ignores: contents.ignores,
    settings: contents.settings,
    via,
    unknownReasons,
    notes,
    parsers,
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
