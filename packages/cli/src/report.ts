import type { Matrix, PluginRow, PluginRunResult } from './matrix.js';
import { rowFor } from './matrix.js';
import { satisfies } from './semver-lite.js';

export type Bucket = 'blocked' | 'safe-to-force' | 'clean' | 'untested' | 'unknown';

export interface Entry {
  name: string;
  version: string | null;
  declaredPeerRange: string | null;
  bucket: Bucket;
  result?: PluginRunResult;
  reason: string;
}

export interface Report {
  eslintVersions: { v9: string; v10: string };
  generatedAt: string;
  projectDir: string;
  configPath: string;
  blocked: Entry[];
  safeToForce: Entry[];
  clean: Entry[];
  untested: Entry[];
  unknown: Entry[];
  overrides: Record<string, { eslint: string }>;
}

const ISSUE_URL = 'https://github.com/cbosch101/eslint10-matrix/issues/new';

function describeFailure(rules: string[], result: PluginRunResult, eslintV10: string): string {
  if (result.status === 'load-fail') return `fails to load on ${eslintV10}`;
  if (result.status === 'install-fail') return `could not be installed alongside ${eslintV10}`;
  const shown = rules.slice(0, 3).join(', ');
  const rest = rules.length > 3 ? `, +${rules.length - 3} more` : '';
  const noun = rules.length === 1 ? 'rule crashes' : 'rules crash';
  return `${rules.length} ${noun} on ${eslintV10}: ${shown}${rest}`;
}

/**
 * A failure that reproduces identically on ESLint 9 is not an upgrade blocker,
 * so `blocked` means "breaks on 10 and not on 9". Returns the newly broken rule
 * ids, or null when ESLint 10 is not what breaks this plugin.
 */
function regressionOnTen(onNine: PluginRunResult | undefined, onTen: PluginRunResult): string[] | null {
  if (onTen.status === 'clean') return null;
  if (!onNine || onNine.status === 'clean') {
    return onTen.status === 'rule-crash' ? onTen.crashingRules.map((r) => r.rule) : [];
  }
  if (onTen.status !== 'rule-crash' && onNine.status === onTen.status) return null;
  if (onTen.status !== 'rule-crash') return [];

  const alreadyBroken = new Set(onNine.crashingRules.map((r) => r.rule));
  const newlyBroken = onTen.crashingRules.map((r) => r.rule).filter((rule) => !alreadyBroken.has(rule));
  return newlyBroken.length > 0 ? newlyBroken : null;
}

export type Verdict = 'blocked' | 'force' | 'clean' | 'untested';

/**
 * The single place a matrix row becomes a verdict. The CLI buckets by it and the
 * site colours its table by it, so they cannot drift apart.
 */
export function verdictFor(
  row: PluginRow,
  versions: { v9: string; v10: string }
): { verdict: Verdict; regressedRules: string[] } {
  const onTen = row.results[versions.v10];
  if (!onTen) return { verdict: 'untested', regressedRules: [] };

  const regressed = regressionOnTen(row.results[versions.v9], onTen);
  if (regressed !== null) return { verdict: 'blocked', regressedRules: regressed };

  return { verdict: satisfies(versions.v10, row.declaredPeerRange) ? 'clean' : 'force', regressedRules: [] };
}

export function buildReport(
  matrix: Matrix,
  input: { plugins: string[]; unknown: string[]; projectDir: string; configPath: string }
): Report {
  const { v9, v10 } = matrix.eslintVersions;
  const report: Report = {
    eslintVersions: matrix.eslintVersions,
    generatedAt: matrix.generatedAt,
    projectDir: input.projectDir,
    configPath: input.configPath,
    blocked: [],
    safeToForce: [],
    clean: [],
    untested: [],
    unknown: [],
    overrides: {},
  };

  for (const key of input.unknown) {
    report.unknown.push({
      name: key,
      version: null,
      declaredPeerRange: null,
      bucket: 'unknown',
      reason: 'used in eslint.config but not found in package.json dependencies',
    });
  }

  for (const name of input.plugins) {
    const row: PluginRow | undefined = rowFor(matrix, name);
    if (!row) {
      report.untested.push({
        name,
        version: null,
        declaredPeerRange: null,
        bucket: 'untested',
        reason: `not in the matrix yet - request it at ${ISSUE_URL}?title=${encodeURIComponent(`Add ${name} to the matrix`)}`,
      });
      continue;
    }

    const result = row.results[v10];
    if (!result) {
      report.untested.push({
        name,
        version: row.version,
        declaredPeerRange: row.declaredPeerRange,
        bucket: 'untested',
        reason: `the matrix has no result for eslint ${v10}`,
      });
      continue;
    }

    const base = { name, version: row.version, declaredPeerRange: row.declaredPeerRange };
    const { verdict, regressedRules } = verdictFor(row, matrix.eslintVersions);

    if (verdict === 'blocked') {
      report.blocked.push({
        ...base,
        bucket: 'blocked',
        result: { ...result, crashingRules: result.crashingRules.filter((r) => regressedRules.includes(r.rule)) },
        reason: describeFailure(regressedRules, result, v10),
      });
      continue;
    }

    const preexisting = result.status !== 'clean' ? ` (its ${result.status} reproduces on ${v9} too, so the upgrade is not what breaks it)` : '';

    if (verdict === 'clean') {
      report.clean.push({
        ...base,
        bucket: 'clean',
        result,
        reason: `already declares support for ESLint 10${preexisting}`,
      });
    } else {
      report.safeToForce.push({
        ...base,
        bucket: 'safe-to-force',
        result,
        reason: `declares ${row.declaredPeerRange ?? 'no eslint peer range'}, verified clean on ${v10} with all ${result.totalRules} rules enabled${preexisting}`,
      });
      report.overrides[name] = { eslint: '$eslint' };
    }
  }

  const byName = (a: Entry, b: Entry) => a.name.localeCompare(b.name);
  report.blocked.sort(byName);
  report.safeToForce.sort(byName);
  report.clean.sort(byName);
  return report;
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

function label(entry: Entry): string {
  return entry.version ? `${entry.name}@${entry.version}` : entry.name;
}

export function renderOverrides(overrides: Record<string, { eslint: string }>): string {
  const body = JSON.stringify({ overrides }, null, 2);
  return body
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n');
}

export function renderReport(report: Report, options: { color?: boolean } = {}): string {
  const c = options.color ?? false;
  const dim = (s: string) => (c ? `[2m${s}[0m` : s);
  const bold = (s: string) => (c ? `[1m${s}[0m` : s);
  const red = (s: string) => (c ? `[31m${s}[0m` : s);
  const yellow = (s: string) => (c ? `[33m${s}[0m` : s);
  const green = (s: string) => (c ? `[32m${s}[0m` : s);

  const total = report.blocked.length + report.safeToForce.length + report.clean.length + report.untested.length;
  const out: string[] = [];
  const plural = total === 1 ? 'plugin' : 'plugins';

  out.push('');
  out.push(bold(`ESLint ${report.eslintVersions.v10} readiness for ${report.projectDir} (${total} ${plural})`));
  out.push(dim(`matrix generated ${report.generatedAt}`));
  out.push('');

  if (report.blocked.length > 0) {
    out.push(red(bold(`BLOCKED (${report.blocked.length})`)));
    const width = Math.max(...report.blocked.map((e) => label(e).length));
    for (const entry of report.blocked) out.push(`  ${pad(label(entry), width + 2)}${entry.reason}`);
    out.push('');
  }

  if (report.safeToForce.length > 0) {
    out.push(
      yellow(bold(`SAFE TO FORCE (${report.safeToForce.length})`)) +
        `  declared below ^10, verified clean on ${report.eslintVersions.v10} with all rules enabled`
    );
    out.push(`  ${report.safeToForce.map(label).join(', ')}`);
    out.push('');
    out.push(dim('  Add to package.json to install them against ESLint 10 anyway:'));
    out.push(renderOverrides(report.overrides));
    out.push('');
  }

  if (report.clean.length > 0) {
    out.push(green(bold(`CLEAN (${report.clean.length})`)) + '  already declares ^10');
    out.push(`  ${report.clean.map(label).join(', ')}`);
    out.push('');
  }

  if (report.untested.length > 0) {
    out.push(bold(`UNTESTED (${report.untested.length})`));
    for (const entry of report.untested) out.push(`  ${entry.name}  ${dim(entry.reason)}`);
    out.push('');
  }

  if (report.unknown.length > 0) {
    out.push(bold(`UNKNOWN (${report.unknown.length})`));
    for (const entry of report.unknown) out.push(`  ${entry.name}  ${dim(entry.reason)}`);
    out.push('');
  }

  if (report.blocked.length === 0) {
    out.push(green(`Nothing blocks the upgrade to ESLint ${report.eslintVersions.v10}.`));
  } else {
    const worst = report.blocked
      .filter((e) => e.result?.status === 'rule-crash')
      .flatMap((e) => e.result?.crashingRules.map((r) => `${e.name}/${r.rule}: ${r.message}`) ?? []);
    if (worst.length > 0) {
      out.push(dim('First crash observed:'));
      out.push(dim(`  ${worst[0]}`));
      out.push('');
    }
    out.push(
      `${report.blocked.length} of ${total} ${plural} block the upgrade to ESLint ${report.eslintVersions.v10}.`
    );
  }
  out.push('');
  return out.join('\n');
}
