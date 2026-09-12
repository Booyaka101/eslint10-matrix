import { dirname, resolve } from 'node:path';
import { collectFiles } from './collect-files.js';
import { displayPath } from './display-path.js';
import { hasNodeModules, readLockfile, resolveInstalled, type InstalledPackage, type Lockfile } from './installed.js';
import type { CrashingRule, Matrix, PluginRow, PluginRunResult } from './matrix.js';
import { mapWithConcurrency, probe, pruneEnvs, rescuePass, type ProbeOptions, type ProbePlan } from './probe-run.js';
import { regressionOnTen } from './report.js';
import {
  findConfigFile,
  readDependencies,
  readWorkspaces,
  resolveConfig,
  looksLikePluginPackage,
  type ResolvedConfig,
} from './resolve-config.js';
import { pluginNamespace } from './snippet.js';
import { TESTED_ESLINT } from './versions.js';

const TS_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts'];
const TS_PARSER = '@typescript-eslint/parser';

export class ScanError extends Error {
  constructor(message: string, readonly hint?: string) {
    super(message);
    this.name = 'ScanError';
  }
}

export interface ScanOptions {
  dir: string;
  /** The ESLint 10 release to measure against. */
  eslintVersion?: string;
  /** Package names to measure instead of reading them out of the config. */
  plugins?: string[];
  maxFiles?: number;
  concurrency?: number;
  cache?: boolean;
  onLog?: (message: string) => void;
}

export interface ScanResult {
  matrix: Matrix;
  plugins: string[];
  unknown: string[];
  projectDir: string;
  configPath: string;
  files: number;
  baseline: string;
  notes: string[];
}

/**
 * The peers a plugin needs to behave like it does in the caller's repo: react
 * for eslint-plugin-react, typescript for the typed rules. Installed versions
 * win over declared ranges, because the point of `scan` is the caller's tree.
 */
async function peerSpecs(
  installed: InstalledPackage,
  projectDir: string,
  lockfile: Lockfile | null
): Promise<string[]> {
  const specs: string[] = [];
  for (const [peer, range] of Object.entries(installed.peerDependencies)) {
    if (peer === 'eslint') continue;
    const here = await resolveInstalled(peer, projectDir, lockfile);
    if (here) specs.push(`${peer}@${here.version}`);
    else if (!installed.optionalPeers.has(peer)) specs.push(`${peer}@${range}`);
  }
  return specs;
}

function isTsFile(file: string): boolean {
  return TS_EXTENSIONS.some((ext) => file.endsWith(ext));
}

interface Confirmed {
  result: PluginRunResult;
  note?: string;
}

function ruleIds(result: PluginRunResult): Set<string> {
  return new Set(result.crashingRules.map((r) => r.rule));
}

/**
 * A crash that does not reproduce is not an upgrade blocker, so anything that
 * looks like a regression is measured twice and only what both runs agree on is
 * reported. The second run reuses the first one's install.
 */
function agree(name: string, first: PluginRunResult, second: PluginRunResult): Confirmed {
  if (first.status === 'rule-crash' && second.status === 'rule-crash') {
    const alsoSecond = ruleIds(second);
    const stable: CrashingRule[] = first.crashingRules.filter((r) => alsoSecond.has(r.rule));
    const dropped = first.crashingRules.length - stable.length;
    if (stable.length === 0) {
      return {
        result: { ...first, status: 'clean', crashingRules: [] },
        note: `${name}: the first run crashed and the second did not agree on a single rule, so it is reported as clean`,
      };
    }
    return {
      result: { ...first, crashingRules: stable },
      ...(dropped > 0
        ? { note: `${name}: ${dropped} ${dropped === 1 ? 'rule crashed' : 'rules crashed'} on only one of two runs and ${dropped === 1 ? 'was' : 'were'} dropped` }
        : {}),
    };
  }

  if (first.status === second.status) return { result: first };
  if (second.status === 'clean' || first.status === 'clean') {
    return {
      result: second.status === 'clean' ? second : first,
      note: `${name}: crashed on one of two runs and not the other, so it is reported as clean`,
    };
  }
  return { result: first, note: `${name}: failed two different ways on two runs (${first.status}, then ${second.status})` };
}

export async function scan(options: ScanOptions): Promise<ScanResult> {
  const target = options.eslintVersion ?? TESTED_ESLINT.v10;
  const maxFiles = options.maxFiles ?? 200;
  const named = [...new Set(options.plugins ?? [])].sort();

  // Ahead of resolveConfig, which imports the config: without an install that
  // fails on the first plugin import, and "cannot find package" is a worse
  // answer to "why did the scan stop" than naming the missing install.
  const found = findConfigFile(options.dir);
  const rootDir = found ? dirname(found) : resolve(options.dir);
  if ((found || named.length > 0) && !hasNodeModules(rootDir)) {
    throw new ScanError(
      `no node_modules under ${displayPath(rootDir)}, so there are no installed plugin versions to measure`,
      'Run your package manager\'s install first. `scan` reports on the versions this repo actually has; it will not fall back to whatever npm publishes as latest.'
    );
  }

  // --plugins is the way past a config this tool cannot read: a function export,
  // a TypeScript config Node will not strip. The files and the installed versions
  // are still the caller's, only the config's ignores and settings are lost.
  const resolved: ResolvedConfig =
    named.length > 0
      ? { configPath: '(--plugins)', projectDir: rootDir, plugins: named, unknown: [], keys: {}, ignores: [], settings: {} }
      : await resolveConfig(options.dir);
  const { projectDir, configPath } = resolved;

  const lockfile = await readLockfile(projectDir);
  const eslintHere = await resolveInstalled('eslint', projectDir, lockfile);
  const baseline = eslintHere?.version.startsWith('9.') ? eslintHere.version : TESTED_ESLINT.v9;

  const collected = await collectFiles(projectDir, { ignores: resolved.ignores, max: maxFiles });
  if (collected.files.length === 0) {
    throw new ScanError(
      `found no JavaScript or TypeScript files to lint under ${displayPath(projectDir)}`,
      'Everything matching was ignored by the config, or the sources live elsewhere. Point scan at the directory holding them.'
    );
  }

  const notes: string[] = [];
  if (named.length > 0 && found) {
    notes.push(`--plugins skipped ${displayPath(found)}, so its ignores and settings were not applied`);
  }
  if (collected.skipped > 0) {
    notes.push(`${collected.skipped} more files matched and were not scanned (raise --max-files to include them)`);
  }

  // The probe parses every file with this parser, so a repo with no .ts in it
  // still wants it installed: typescript-eslint's rules crash under espree for
  // a reason no ESLint 10 upgrade would hit.
  const typescriptFiles = collected.files.some(isTsFile);
  const parser = await resolveInstalled(TS_PARSER, projectDir, lockfile);
  const typescript = parser ? await resolveInstalled('typescript', projectDir, lockfile) : null;
  if (typescriptFiles && !parser) {
    notes.push(`no ${TS_PARSER} installed, so the TypeScript files here were skipped`);
  }

  const workspaces = await readWorkspaces(projectDir);
  if (workspaces.length > 0) {
    notes.push(
      `${displayPath(projectDir)} is a workspace root (${workspaces.join(', ')}); scan measures the config here only and does not walk into the packages`
    );
  }

  const deps = named.length > 0 ? {} : await readDependencies(projectDir);
  const unreferenced = Object.keys(deps)
    .filter((name) => looksLikePluginPackage(name) && !resolved.plugins.includes(name))
    .sort();
  if (unreferenced.length > 0) {
    notes.push(`installed but not used by ${displayPath(configPath)}, so not scanned: ${unreferenced.join(', ')}`);
  }

  const probeOptions: ProbeOptions = { cache: options.cache ?? true, onLog: options.onLog };
  if (probeOptions.cache) {
    const pruned = await pruneEnvs();
    if (pruned > 0) options.onLog?.(`removed ${pruned} cached installs older than 14 days`);
  }
  const measured: string[] = [];
  const rows: PluginRow[] = [];

  const specs = await Promise.all(
    resolved.plugins.map(async (name) => ({ name, installed: await resolveInstalled(name, projectDir, lockfile) }))
  );

  for (const { name, installed } of specs) {
    if (!installed) {
      notes.push(`${name} is used by the config but has no installed version here, so it was not scanned`);
    } else if (installed.source === 'lockfile') {
      notes.push(`${name} was read from ${lockfile ? displayPath(lockfile.path) : 'the lockfile'}, not from node_modules`);
    }
  }

  const runnable = specs.filter((s): s is { name: string; installed: InstalledPackage } => s.installed !== null);

  const results = await mapWithConcurrency(runnable, options.concurrency ?? 3, async ({ name, installed }) => {
    const peers = await peerSpecs(installed, projectDir, lockfile);
    const planFor = (eslintVersion: string): ProbePlan => ({
      deps: [
        `eslint@${eslintVersion}`,
        `${name}@${installed.version}`,
        ...peers,
        ...(parser ? [`${TS_PARSER}@${parser.version}`] : []),
        ...(typescript ? [`typescript@${typescript.version}`] : []),
      ],
      specifier: name,
      namespace: pluginNamespace(name),
      settings: resolved.settings,
      parserSpecifier: parser ? TS_PARSER : null,
      cwd: projectDir,
      files: collected.files,
      recordFiles: true,
    });

    options.onLog?.(`${name}@${installed.version}: measuring on eslint ${baseline} and ${target}`);
    const onNine = await probe(planFor(baseline), probeOptions);
    let onTen = await probe(planFor(target), probeOptions);
    const localNotes: string[] = [];

    if (regressionOnTen(onNine, onTen) !== null) {
      const confirmed = agree(name, onTen, await probe(planFor(target), probeOptions));
      onTen = confirmed.result;
      if (confirmed.note) localNotes.push(confirmed.note);
    }

    const row: PluginRow = {
      name,
      version: installed.version,
      declaredPeerRange: installed.peerEslintRange,
      weeklyDownloads: 0,
      results: { [baseline]: onNine, [target]: onTen },
    };
    const rescue = await rescuePass(row.results, { v9: baseline, v10: target }, () => planFor(target), probeOptions);
    if (rescue) row.rescue = rescue;
    return { row, localNotes };
  });

  for (const { row, localNotes } of results) {
    rows.push(row);
    measured.push(row.name);
    notes.push(...localNotes);
  }

  return {
    matrix: {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      eslintVersions: { v9: baseline, v10: target },
      plugins: rows,
    },
    plugins: measured.sort(),
    unknown: resolved.unknown,
    projectDir,
    configPath,
    files: collected.files.length,
    baseline,
    notes,
  };
}
