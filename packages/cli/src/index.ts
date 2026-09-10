#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMatrix, MatrixError, type Matrix } from './matrix.js';
import { buildReport, renderReport, type Report } from './report.js';
import { ConfigError, resolveConfig } from './resolve-config.js';
import { scan, ScanError } from './scan.js';
import { TESTED_ESLINT } from './versions.js';

const HELP = `eslint10-matrix - can this repo upgrade to ESLint 10 yet?

USAGE
  eslint10-matrix check [dir]      read the published board for a repo (default: .)
  eslint10-matrix scan [dir]       execute your installed plugin versions against
                                   ESLint 10 on your own source files
  eslint10-matrix plugins          list every plugin in the published matrix
  eslint10-matrix --help
  eslint10-matrix --version

OPTIONS
  check and scan
  --ci                exit 1 when any plugin is BLOCKED, RESCUABLE or
                      PARTIAL-RESCUE (default: always exit 0)
  --color             force ANSI colour when the output is not a terminal
  --json              print machine-readable JSON instead of the human report
  --no-cache          never read or write anything under ~/.cache/eslint10-matrix
  --no-color          disable ANSI colour
  --plugins <a,b>     skip config resolution and use these package names

  check only
  --matrix <src>      use a matrix.json path or URL instead of the published one
  --timeout <ms>      network timeout for fetching the matrix (default 15000)

  scan only
  --eslint <version>  the ESLint 10 release to measure against (default ${TESTED_ESLINT.v10})
  --max-files <n>     how many of the repo's files to lint (default 200)
  --concurrency <n>   plugins measured in parallel (default 3)
  --quiet             do not print progress to stderr

EXIT CODES
  0  report printed
  1  --ci and at least one plugin blocks the upgrade
  2  the command could not run (no flat config, no node_modules, bad arguments)
`;

interface Options {
  command: 'check' | 'scan' | 'plugins' | 'help' | 'version';
  dir: string;
  ci: boolean;
  json: boolean;
  matrix?: string;
  noCache: boolean;
  plugins: string[];
  timeoutMs: number;
  color: boolean;
  eslintVersion: string;
  maxFiles: number;
  concurrency: number;
  quiet: boolean;
}

class UsageError extends Error {}

function positiveInteger(flag: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new UsageError(`${flag} needs a positive whole number`);
  return parsed;
}

export function parseArgs(argv: string[]): Options {
  const opts: Options = {
    command: 'help',
    dir: process.cwd(),
    ci: false,
    json: false,
    noCache: false,
    plugins: [],
    timeoutMs: 15_000,
    color: process.stdout.isTTY === true && !process.env.NO_COLOR,
    eslintVersion: TESTED_ESLINT.v10,
    maxFiles: 200,
    concurrency: 3,
    quiet: false,
  };

  const positional: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const next = (): string => {
      const value = argv[++i];
      if (value === undefined) throw new UsageError(`${arg} needs a value`);
      return value;
    };
    switch (arg) {
      case '--ci': opts.ci = true; break;
      case '--json': opts.json = true; break;
      case '--no-cache': opts.noCache = true; break;
      case '--no-color': opts.color = false; break;
      case '--color': opts.color = true; break;
      case '--matrix': opts.matrix = next(); break;
      case '--timeout': {
        const ms = Number(next());
        if (!Number.isFinite(ms) || ms <= 0) throw new UsageError('--timeout needs a positive number of milliseconds');
        opts.timeoutMs = ms;
        break;
      }
      case '--plugins': opts.plugins.push(...next().split(',').map((s) => s.trim()).filter(Boolean)); break;
      case '--quiet': opts.quiet = true; break;
      case '--eslint': opts.eslintVersion = next(); break;
      case '--max-files': opts.maxFiles = positiveInteger(arg, next()); break;
      case '--concurrency': opts.concurrency = positiveInteger(arg, next()); break;
      case '-h': case '--help': opts.command = 'help'; return opts;
      case '-v': case '--version': opts.command = 'version'; return opts;
      default:
        if (arg.startsWith('-')) throw new UsageError(`unknown option: ${arg}`);
        positional.push(arg);
    }
  }

  const [command, target] = positional;
  if (command === undefined) {
    opts.command = 'help';
  } else if (command === 'check' || command === 'scan') {
    opts.command = command;
    if (target) opts.dir = resolve(target);
  } else if (command === 'plugins') {
    opts.command = 'plugins';
  } else if (command === 'help') {
    opts.command = 'help';
  } else {
    throw new UsageError(`unknown command: ${command}`);
  }
  return opts;
}

async function readVersion(): Promise<string> {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const doc = JSON.parse(await readFile(join(here, '..', 'package.json'), 'utf8')) as { version?: string };
    return doc.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function jsonReport(report: Report, source: string, stale?: string): string {
  return JSON.stringify(
    {
      eslintVersions: report.eslintVersions,
      matrixGeneratedAt: report.generatedAt,
      matrixSource: source,
      ...(stale ? { matrixStaleReason: stale } : {}),
      projectDir: report.projectDir,
      configPath: report.configPath,
      ready: report.blocked.length + report.rescuable.length + report.partialRescue.length === 0,
      counts: {
        blocked: report.blocked.length,
        rescuable: report.rescuable.length,
        partialRescue: report.partialRescue.length,
        safeToForce: report.safeToForce.length,
        clean: report.clean.length,
        untested: report.untested.length,
        unknown: report.unknown.length,
      },
      blocked: report.blocked,
      rescuable: report.rescuable,
      partialRescue: report.partialRescue,
      safeToForce: report.safeToForce,
      clean: report.clean,
      untested: report.untested,
      unknown: report.unknown,
      overrides: report.overrides,
      notes: report.notes,
    },
    null,
    2
  );
}

async function commandPlugins(opts: Options): Promise<number> {
  const load = await loadMatrix({ url: opts.matrix, noCache: opts.noCache, timeoutMs: opts.timeoutMs });
  const matrix: Matrix = load.matrix;
  if (opts.json) {
    console.log(JSON.stringify(matrix, null, 2));
    return 0;
  }
  const { v9, v10 } = matrix.eslintVersions;
  console.log(`${matrix.plugins.length} plugins, executed against eslint ${v9} and ${v10} (generated ${matrix.generatedAt})`);
  const width = Math.max(...matrix.plugins.map((p) => p.name.length)) + 2;
  for (const row of matrix.plugins) {
    const nine = row.results[v9]?.status ?? 'untested';
    const ten = row.results[v10]?.status ?? 'untested';
    const rescue =
      row.rescue?.attempted && row.rescue.verdict !== 'blocked'
        ? `  ${row.rescue.verdict} via ${row.rescue.fixupFunction ?? 'fixupPluginRules'}`
        : '';
    console.log(`  ${row.name.padEnd(width)}${String(v9).padEnd(9)}${nine.padEnd(14)}${v10} ${ten}${rescue}`);
  }
  return 0;
}

async function commandScan(opts: Options): Promise<number> {
  const result = await scan({
    dir: opts.dir,
    plugins: opts.plugins,
    eslintVersion: opts.eslintVersion,
    maxFiles: opts.maxFiles,
    concurrency: opts.concurrency,
    cache: !opts.noCache,
    onLog: opts.quiet || opts.json ? undefined : (message) => console.error(`  ${message}`),
  });

  const report = buildReport(result.matrix, {
    plugins: result.plugins,
    unknown: result.unknown,
    projectDir: result.projectDir,
    configPath: result.configPath,
    measured: { files: result.files, baseline: result.baseline },
    notes: result.notes,
  });

  if (opts.json) console.log(jsonReport(report, 'scan'));
  else process.stdout.write(renderReport(report, { color: opts.color }));

  const blocking = report.blocked.length + report.rescuable.length + report.partialRescue.length;
  return opts.ci && blocking > 0 ? 1 : 0;
}

async function commandCheck(opts: Options): Promise<number> {
  let plugins: string[];
  let unknown: string[];
  let configPath: string;
  let projectDir: string;

  if (opts.plugins.length > 0) {
    plugins = [...new Set(opts.plugins)].sort();
    unknown = [];
    configPath = '(--plugins)';
    projectDir = opts.dir;
  } else {
    const resolved = await resolveConfig(opts.dir);
    plugins = resolved.plugins;
    unknown = resolved.unknown;
    configPath = resolved.configPath;
    projectDir = resolved.projectDir;
  }

  const load = await loadMatrix({ url: opts.matrix, noCache: opts.noCache, timeoutMs: opts.timeoutMs });
  const report = buildReport(load.matrix, { plugins, unknown, projectDir, configPath });

  if (opts.json) {
    console.log(jsonReport(report, load.source, load.staleReason));
  } else {
    if (load.source === 'cache') {
      console.error(
        `warning: could not reach the published matrix (${load.staleReason}); using the cached copy from ${load.cachedAt}`
      );
    }
    if (plugins.length === 0 && unknown.length === 0) {
      console.log(`\nNo ESLint plugins found in ${configPath}. Nothing to check.\n`);
      return 0;
    }
    process.stdout.write(renderReport(report, { color: opts.color }));
  }

  // Rescuable plugins still block a plain upgrade until the wrap is applied,
  // which also keeps --ci's exit code identical to when they were all BLOCKED.
  const blocking = report.blocked.length + report.rescuable.length + report.partialRescue.length;
  return opts.ci && blocking > 0 ? 1 : 0;
}

export async function main(argv: string[]): Promise<number> {
  let opts: Options;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    console.error(HELP);
    return 2;
  }

  if (opts.command === 'help') {
    console.log(HELP);
    return 0;
  }
  if (opts.command === 'version') {
    console.log(await readVersion());
    return 0;
  }

  const commands = { plugins: commandPlugins, scan: commandScan, check: commandCheck };
  try {
    return await commands[opts.command](opts);
  } catch (err) {
    if (err instanceof ConfigError || err instanceof MatrixError || err instanceof ScanError) {
      console.error(`error: ${err.message}`);
      if (err.hint) console.error(`\n${err.hint}`);
      return 2;
    }
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
}

const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 2;
    }
  );
}
