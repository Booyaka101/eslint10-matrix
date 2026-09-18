import { palette } from './colour.js';
import type { Matrix, MeasuredEnv, PluginRow, PluginRunResult, RescueVerdict, Status } from './matrix.js';
import { describeDelta, versionDeltas, type VersionDelta } from './version-delta.js';
import { wrapList } from './wrap.js';

/**
 * Why two boards disagree, most specific first. `unknown-env` is not a weaker
 * `unexplained`: it means one of the boards predates 1.4.0 and recorded no
 * environment at all, so there is nothing to have changed. Calling that
 * unexplained would make every diff against a published 1.3.0 board alarming.
 */
export type DiffCause = 'eslint' | 'plugin' | 'env' | 'unknown-env' | 'unexplained';

export interface StatusChange {
  /** The ESLint major this moved on, named by the `after` board's version. */
  eslintVersion: string;
  before: Status | 'untested';
  after: Status | 'untested';
}

export type EnvChange = VersionDelta;

export interface DiffEntry {
  name: string;
  kind: 'changed' | 'added' | 'removed';
  statuses: StatusChange[];
  /** Present when the rescue verdict moved. `none` means the row had no rescue. */
  rescue?: { before: RescueVerdict | 'none'; after: RescueVerdict | 'none' };
  /** Absent on added and removed rows: there is no pair to attribute. */
  cause?: DiffCause;
  causeDetail?: string;
  /** Populated for `env`, so the reader sees the packages without re-reading both boards. */
  envChanges?: EnvChange[];
}

export interface DiffCounts {
  changed: number;
  added: number;
  removed: number;
  eslint: number;
  plugin: number;
  env: number;
  unknownEnv: number;
  unexplained: number;
}

export interface BoardSummary {
  source: string;
  generatedAt: string;
  eslintVersions: { v9: string; v10: string };
  plugins: number;
}

export interface DiffResult {
  before: BoardSummary;
  after: BoardSummary;
  changes: DiffEntry[];
  counts: DiffCounts;
}

interface Boards {
  before: Matrix;
  after: Matrix;
}

interface Rows {
  before: PluginRow;
  after: PluginRow;
}

function summarise(matrix: Matrix, source: string): BoardSummary {
  return {
    source,
    generatedAt: matrix.generatedAt,
    eslintVersions: matrix.eslintVersions,
    plugins: matrix.plugins.length,
  };
}

function statusOf(result: PluginRunResult | undefined): Status | 'untested' {
  return result?.status ?? 'untested';
}

function rescueVerdict(row: PluginRow): RescueVerdict | 'none' {
  return row.rescue?.verdict ?? 'none';
}

/**
 * Compared by major slot rather than by version key: two boards built a week
 * apart pin different ESLint patches, and pairing `10.10.0` against `10.10.0`
 * would silently report every row as untested the day ESLint ships one.
 */
const MAJORS = ['v9', 'v10'] as const;

type Major = (typeof MAJORS)[number];

/**
 * The majors this change is about. A row that moved on ESLint 10 is not
 * explained by what happened around ESLint 9, and an install that left no
 * node_modules on one major must not blind the attribution on the other.
 */
function majorsInvolved(change: Pick<DiffEntry, 'statuses' | 'rescue'>, boards: Boards, rows: Rows): Major[] {
  const involved = new Set<Major>();
  for (const status of change.statuses) {
    for (const major of MAJORS) {
      if (boards.after.eslintVersions[major] === status.eslintVersion) involved.add(major);
    }
  }
  if (change.rescue) {
    for (const [board, row] of [
      [boards.before, rows.before],
      [boards.after, rows.after],
    ] as const) {
      const version = row.rescue?.eslintVersion;
      for (const major of MAJORS) {
        if (version !== undefined && board.eslintVersions[major] === version) involved.add(major);
      }
    }
  }
  // A rescue on a version neither board lists leaves nothing to narrow to.
  return involved.size > 0 ? MAJORS.filter((major) => involved.has(major)) : [...MAJORS];
}

/**
 * The runtime sits in with the dependencies because it drifts the same way and
 * explains the same thing: the nightly floats node 22 and takes whichever npm
 * ships with it, so either can move under a spec that did not.
 */
function withRuntime(env: MeasuredEnv): Record<string, string | null> {
  return { ...env.deps, node: env.node, npm: env.npm };
}

function envDiff(before: PluginRow, after: PluginRow, boards: Boards, majors: readonly Major[]): EnvChange[] {
  const found = new Map<string, EnvChange>();
  for (const major of majors) {
    const was = before.results[boards.before.eslintVersions[major]]?.measuredWith;
    const now = after.results[boards.after.eslintVersions[major]]?.measuredWith;
    if (!was || !now) continue;
    for (const delta of versionDeltas(withRuntime(was), withRuntime(now))) {
      found.set(`${delta.package}|${delta.before}|${delta.after}`, delta);
    }
  }
  return [...found.values()].sort((a, b) => a.package.localeCompare(b.package));
}

/**
 * True when either board reached this row without leaving an environment behind.
 * A result that is absent counts: `untested -> clean` has nothing recorded on the
 * before side, so nothing can be ruled out there either, and calling that
 * `unexplained` would fail the nightly for a row nobody had measured yet.
 */
function environmentUnrecorded(
  before: PluginRow,
  after: PluginRow,
  boards: Boards,
  majors: readonly Major[]
): boolean {
  return majors.some(
    (major) =>
      !before.results[boards.before.eslintVersions[major]]?.measuredWith ||
      !after.results[boards.after.eslintVersions[major]]?.measuredWith
  );
}

function describeEnv(changes: EnvChange[]): string {
  return changes.map(describeDelta).join(', ');
}

function attribute(
  before: PluginRow,
  after: PluginRow,
  boards: Boards,
  majors: readonly Major[]
): Pick<DiffEntry, 'cause' | 'causeDetail' | 'envChanges'> {
  const eslintMoved = majors.filter(
    (major) => boards.before.eslintVersions[major] !== boards.after.eslintVersions[major]
  );
  if (eslintMoved.length > 0) {
    return {
      cause: 'eslint',
      causeDetail: eslintMoved
        .map((m) => `eslint ${boards.before.eslintVersions[m]} -> ${boards.after.eslintVersions[m]}`)
        .join(', '),
    };
  }

  // A null version is a registry lookup that failed, not a version that changed.
  if (before.version !== null && after.version !== null && before.version !== after.version) {
    return { cause: 'plugin', causeDetail: `${before.name} ${before.version} -> ${after.version}` };
  }

  const env = envDiff(before, after, boards, majors);
  if (env.length > 0) return { cause: 'env', causeDetail: describeEnv(env), envChanges: env };

  if (environmentUnrecorded(before, after, boards, majors)) {
    return {
      cause: 'unknown-env',
      causeDetail: 'one of these boards predates 1.4.0 and recorded no environment, so nothing can be ruled out',
    };
  }
  return { cause: 'unexplained', causeDetail: 'no recorded version changed' };
}

export function diffMatrices(
  before: { matrix: Matrix; source: string },
  after: { matrix: Matrix; source: string }
): DiffResult {
  const boards = { before: before.matrix, after: after.matrix };
  const beforeRows = new Map(before.matrix.plugins.map((row) => [row.name, row]));
  const afterRows = new Map(after.matrix.plugins.map((row) => [row.name, row]));
  const changes: DiffEntry[] = [];

  for (const [name, afterRow] of afterRows) {
    const beforeRow = beforeRows.get(name);
    if (!beforeRow) {
      changes.push({ name, kind: 'added', statuses: [] });
      continue;
    }
    const statuses: StatusChange[] = [];
    for (const major of MAJORS) {
      const was = statusOf(beforeRow.results[boards.before.eslintVersions[major]]);
      const now = statusOf(afterRow.results[boards.after.eslintVersions[major]]);
      if (was !== now) statuses.push({ eslintVersion: boards.after.eslintVersions[major], before: was, after: now });
    }
    const rescueBefore = rescueVerdict(beforeRow);
    const rescueAfter = rescueVerdict(afterRow);
    const rescueMoved = rescueBefore !== rescueAfter;
    if (statuses.length === 0 && !rescueMoved) continue;
    const rescue = rescueMoved ? { before: rescueBefore, after: rescueAfter } : undefined;
    const rows = { before: beforeRow, after: afterRow };
    const majors = majorsInvolved({ statuses, rescue }, boards, rows);
    changes.push({
      name,
      kind: 'changed',
      statuses,
      ...(rescue ? { rescue } : {}),
      ...attribute(beforeRow, afterRow, boards, majors),
    });
  }

  for (const name of beforeRows.keys()) {
    if (!afterRows.has(name)) changes.push({ name, kind: 'removed', statuses: [] });
  }

  changes.sort((a, b) => a.name.localeCompare(b.name));
  return {
    before: summarise(before.matrix, before.source),
    after: summarise(after.matrix, after.source),
    changes,
    counts: count(changes),
  };
}

function count(changes: DiffEntry[]): DiffCounts {
  const counts: DiffCounts = {
    changed: 0,
    added: 0,
    removed: 0,
    eslint: 0,
    plugin: 0,
    env: 0,
    unknownEnv: 0,
    unexplained: 0,
  };
  for (const change of changes) {
    if (change.kind === 'added') counts.added += 1;
    else if (change.kind === 'removed') counts.removed += 1;
    else counts.changed += 1;
    if (change.cause === 'eslint') counts.eslint += 1;
    if (change.cause === 'plugin') counts.plugin += 1;
    if (change.cause === 'env') counts.env += 1;
    if (change.cause === 'unknown-env') counts.unknownEnv += 1;
    if (change.cause === 'unexplained') counts.unexplained += 1;
  }
  return counts;
}

/**
 * An unexplained change is a measurement neither board can account for, and a
 * removed row is a plugin that stopped being measured at all. Both want a human
 * before the board is published; everything else has its answer printed beside it.
 */
export function diffBlocks(result: DiffResult): boolean {
  return result.counts.unexplained > 0 || result.counts.removed > 0;
}

function headline(change: DiffEntry): string {
  if (change.kind === 'added') return 'added to the board';
  if (change.kind === 'removed') return 'removed from the board';
  const parts = change.statuses.map((s) => `${s.before} -> ${s.after} on ${s.eslintVersion}`);
  if (change.rescue) parts.push(`rescue ${change.rescue.before} -> ${change.rescue.after}`);
  return parts.join(', ');
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

/** Narrower than the report's notes: this line is read against the names above it. */
const CAUSE_WIDTH = 100;

/**
 * The "why" under a changed row, wrapped with continuations aligned under the
 * first version. `eslint` and `env` details are lists, and a week where node,
 * npm and four packages all moved a patch runs past 200 columns. Nothing is
 * dropped the way the report's environment note drops names: there the line is
 * a footnote, here it is the answer.
 */
function causeLines(cause: DiffCause, detail: string): string[] {
  const head = `  ${cause}: `;
  // The other two causes are sentences, and re-flowing English at a comma reads
  // worse than one long line.
  if (cause !== 'eslint' && cause !== 'env') return [head + detail];
  return wrapList(head, detail.split(', '), CAUSE_WIDTH);
}

export function renderDiff(result: DiffResult, options: { color?: boolean } = {}): string {
  const { dim, bold, red, green } = palette(options.color ?? false);

  const out: string[] = [''];
  out.push(bold(`${result.before.source} -> ${result.after.source}`));
  out.push(
    dim(
      `generated ${result.before.generatedAt} -> ${result.after.generatedAt}, ` +
        `${result.before.plugins} -> ${result.after.plugins} plugins`
    )
  );
  out.push('');

  if (result.changes.length === 0) {
    out.push(green('No row changed status or rescue verdict.'));
    out.push('');
    return out.join('\n');
  }

  const width = Math.max(...result.changes.map((change) => change.name.length));
  for (const change of result.changes) {
    out.push(`${pad(change.name, width + 2)}${headline(change)}`);
    if (!change.cause) continue;
    const paint = change.cause === 'unexplained' ? red : dim;
    for (const line of causeLines(change.cause, change.causeDetail ?? '')) out.push(paint(line));
  }
  out.push('');

  const { counts } = result;
  const attributed = counts.eslint + counts.plugin + counts.env;
  const tail = [
    `${counts.changed} ${counts.changed === 1 ? 'row' : 'rows'} changed`,
    `${counts.added} added`,
    `${counts.removed} removed`,
  ].join(', ');
  out.push(`${tail}. ${attributed} attributed, ${counts.unknownEnv} with no recorded environment.`);
  if (counts.unexplained > 0) {
    out.push(
      red(
        `${counts.unexplained} ${counts.unexplained === 1 ? 'change has' : 'changes have'} no recorded cause: ` +
          'every version both boards recorded is identical.'
      )
    );
  }
  // The other half of what --ci exits 1 on. Without this the summary reads clean
  // while the command fails, and the reader has to count the rows to find out why.
  if (counts.removed > 0) {
    out.push(
      red(
        `${counts.removed} ${counts.removed === 1 ? 'row' : 'rows'} left the board: ` +
          'a dropped row has no cause to attribute, and a shard that died looks exactly like one.'
      )
    );
  }
  out.push('');
  return out.join('\n');
}
