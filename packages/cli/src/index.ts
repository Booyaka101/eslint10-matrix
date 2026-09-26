#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { diffBlocks, diffMatrices, renderDiff, sharedRows, type DiffResult } from './diff.js';
import { displayPath } from './display-path.js';
import { measuredDrift } from './env-drift.js';
import { DEFAULT_MATRIX_URL, loadMatrix, MatrixError, rowFor, type Matrix } from './matrix.js';
import { buildReport, renderReport, type Report } from './report.js';
import { ConfigError, resolveConfig, type ResolvedConfig } from './resolve-config.js';
import { scan, ScanError } from './scan.js';
import { TESTED_ESLINT } from './versions.js';

const HELP = `eslint10-matrix - can this repo upgrade to ESLint 10 yet?

USAGE
  eslint10-matrix check [dir]      read the published board for a repo (default: .)
  eslint10-matrix scan [dir]       execute your installed plugin versions against
                                   ESLint 10 on your own source files
  eslint10-matrix plugins          list every plugin in the published matrix
  eslint10-matrix diff [a] <b>     what changed between two boards, and why
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
  --matrix <src>      a matrix.json path, an http(s) URL, or a git revision like
                      HEAD~7:matrix.json, instead of the published board
  --timeout <ms>      network timeout for fetching the matrix (default 15000)

  diff only
  Each board is a matrix.json path, an http(s) URL, or a git revision like
  HEAD~7:matrix.json. Given one board, it is compared against the published one.
  Every changed row is attributed to the eslint version, the plugin version, an
  installed dependency, or nothing.
  --ci                exit 1 when a change has no recorded cause, or a row was
                      removed from the board
  --only <a,b>        compare only these plugins. --ci then judges exactly what
                      was printed
  --timeout <ms>      network timeout when a board is a URL (default 15000)

  scan only
  --against [board]   after the report, say where this repo disagrees with a
                      board and why. No board named means the published one
  --eslint <version>  the ESLint 10 release to measure against (default ${TESTED_ESLINT.v10})
  --max-files <n>     how many of the repo's files to lint (default 200)
  --concurrency <n>   plugins measured in parallel (default 3)
  --quiet             do not print progress to stderr

EXIT CODES
  0  report printed
  1  --ci and at least one plugin blocks the upgrade, or a diff change has
     no recorded cause, or a row left the board
  2  the command could not run (no flat config, no node_modules, bad arguments)
`;

interface Options {
  command: 'check' | 'scan' | 'plugins' | 'diff' | 'help' | 'version';
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
  /** `diff` only: the two boards to compare, in that order. */
  boards: [string, string];
  /** `diff` only: restrict the comparison to these plugin names. */
  only: string[];
  /** `scan` only: a board to compare the local results against. */
  against?: string;
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
    boards: ['', ''],
    only: [],
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
      case '--only': opts.only.push(...next().split(',').map((s) => s.trim()).filter(Boolean)); break;
      case '--against': {
        // The value is optional, the same way `diff` with one board means "against
        // what is published". A following flag is not this flag's argument.
        const value = argv[i + 1];
        opts.against = value !== undefined && !value.startsWith('-') ? argv[++i]! : DEFAULT_MATRIX_URL;
        break;
      }
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
  } else if (command === 'diff') {
    opts.command = 'diff';
    const [, first, second] = positional;
    if (!first) throw new UsageError('diff needs a board: eslint10-matrix diff [before] <after>');
    if (positional.length > 3) throw new UsageError(`diff takes at most two boards, got ${positional.length - 1}`);
    // One board means "how does this differ from what is published", which is the
    // question people actually ask, and the same default check runs on.
    opts.boards = second ? [first, second] : [DEFAULT_MATRIX_URL, first];
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

function jsonReport(report: Report, source: string, stale?: string, comparison?: DiffResult): string {
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
        harnessMisconfig: report.harnessMisconfig.length,
        untested: report.untested.length,
        unknown: report.unknown.length,
      },
      blocked: report.blocked,
      rescuable: report.rescuable,
      partialRescue: report.partialRescue,
      safeToForce: report.safeToForce,
      clean: report.clean,
      harnessMisconfig: report.harnessMisconfig,
      untested: report.untested,
      unknown: report.unknown,
      overrides: report.overrides,
      ...(report.measuredDrift ? { measuredDrift: report.measuredDrift } : {}),
      notes: report.notes,
      ...(comparison ? { comparison } : {}),
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

/**
 * Where this repo's own measurements disagree with a published board, in the
 * words `diff` already uses. Both sides are matrices carrying what they were
 * measured in, so the existing attribution answers the question people used to
 * have to answer by running both commands and comparing by eye.
 *
 * Only rows the board also has: a plugin it does not measure is on the report
 * above with its own verdict, and calling it `added to the board` would be a
 * sentence about the board that is not true.
 */
async function compareWithBoard(local: Matrix, source: string, opts: Options): Promise<DiffResult | null> {
  const board = await loadMatrix({ url: source, noCache: true, timeoutMs: opts.timeoutMs });
  const only = sharedRows(board.matrix, local);
  // Nothing in common is not agreement, and rendering it as an empty diff would
  // read as agreement. The caller says so instead.
  if (only.length === 0) return null;
  return diffMatrices(
    { matrix: board.matrix, source },
    { matrix: local, source: 'this repo' },
    { only }
  );
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
    unknownReasons: result.unknownReasons,
    via: result.via,
    projectDir: result.projectDir,
    configPath: result.configPath,
    measured: { files: result.files, baseline: result.baseline },
    notes: result.notes,
    parsers: result.parsers,
  });

  // json is one document, so the board has to be in hand before anything is
  // written. The human report goes out first instead: the scan is the expensive
  // part of this command, and an unreachable board is no reason to lose it.
  if (opts.json) {
    const comparison = opts.against ? await compareWithBoard(result.matrix, opts.against, opts) : null;
    console.log(jsonReport(report, 'scan', undefined, comparison ?? undefined));
  } else {
    process.stdout.write(renderReport(report, { color: opts.color }));
    if (opts.against) {
      const comparison = await compareWithBoard(result.matrix, opts.against, opts);
      if (comparison)
        process.stdout.write(
          renderDiff(comparison, {
            color: opts.color,
            unchanged: 'This repo and the board agree on every plugin they both measure.',
          })
        );
      else console.log(`
The board measures none of these plugins, so there is nothing to compare.`);
    }
  }

  const blocking = report.blocked.length + report.rescuable.length + report.partialRescue.length;
  return opts.ci && blocking > 0 ? 1 : 0;
}

async function commandDiff(opts: Options): Promise<number> {
  const [beforeSource, afterSource] = opts.boards;
  // Never the cache, either way round. The cached board is whatever `check` last
  // fetched, so falling back to it would diff a board nobody asked for under the
  // URL they typed, and caching a board given to `diff` would poison `check`.
  const load = (source: string) => loadMatrix({ url: source, noCache: true, timeoutMs: opts.timeoutMs });
  // Sequential so a bad first argument reports itself rather than racing the second.
  const before = await load(beforeSource);
  const after = await load(afterSource);

  const result = diffMatrices(
    { matrix: before.matrix, source: beforeSource },
    { matrix: after.matrix, source: afterSource },
    { ...(opts.only.length > 0 ? { only: opts.only } : {}) }
  );

  if (opts.json) console.log(JSON.stringify(result, null, 2));
  else process.stdout.write(renderDiff(result, { color: opts.color }));

  return opts.ci && diffBlocks(result) ? 1 : 0;
}

async function commandCheck(opts: Options): Promise<number> {
  const resolved: Pick<ResolvedConfig, 'plugins' | 'unknown' | 'unknownReasons' | 'via' | 'notes' | 'parsers' | 'configPath' | 'projectDir'> =
    opts.plugins.length > 0
      ? {
          plugins: [...new Set(opts.plugins)].sort(),
          unknown: [],
          unknownReasons: {},
          via: {},
          notes: [],
          parsers: [],
          configPath: '(--plugins)',
          projectDir: opts.dir,
        }
      : await resolveConfig(opts.dir);
  const { plugins, unknown, unknownReasons, via, notes, parsers, configPath, projectDir } = resolved;

  const load = await loadMatrix({ url: opts.matrix, noCache: opts.noCache, timeoutMs: opts.timeoutMs });
  // The ESLint 10 run is the one the report is about, so it is the environment
  // worth comparing. An install that failed on 10 recorded nothing, and the
  // ESLint 9 run of the same row was installed the same night out of the same
  // registry, so it answers the question rather than leaving the row silent.
  // Rows the board never measured at all contribute nothing and cost no reads.
  const { v9, v10 } = load.matrix.eslintVersions;
  const drift = await measuredDrift(
    plugins.map((name) => {
      const row = rowFor(load.matrix, name);
      return {
        name,
        measuredWith: row?.results[v10]?.measuredWith ?? row?.results[v9]?.measuredWith,
        fromDir: via[name]?.dir,
      };
    }),
    projectDir
  );
  const report = buildReport(load.matrix, {
    plugins,
    unknown,
    unknownReasons,
    via,
    projectDir,
    configPath,
    measuredDrift: drift,
    notes,
    parsers,
  });

  if (opts.json) {
    console.log(jsonReport(report, load.source, load.staleReason));
  } else {
    if (load.source === 'cache') {
      console.error(
        `warning: could not reach the published matrix (${load.staleReason}); using the cached copy from ${load.cachedAt}`
      );
    }
    if (plugins.length === 0 && unknown.length === 0) {
      console.log(`\nNo ESLint plugins found in ${displayPath(configPath)}. Nothing to check.\n`);
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

  const commands = { plugins: commandPlugins, scan: commandScan, check: commandCheck, diff: commandDiff };
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
