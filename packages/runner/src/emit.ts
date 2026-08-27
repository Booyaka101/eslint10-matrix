import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { SCHEMA_VERSION, type Matrix, type PluginRow } from './types.js';

const STATUSES = new Set(['clean', 'rule-crash', 'load-fail', 'install-fail']);
const RESCUE_VERDICTS = new Set(['rescuable', 'partial-rescue', 'blocked']);

export function buildMatrix(
  eslintVersions: { v9: string; v10: string },
  rows: PluginRow[],
  generatedAt: string
): Matrix {
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt,
    eslintVersions,
    plugins: [...rows].sort((a, b) => b.weeklyDownloads - a.weeklyDownloads),
  };
}

/** Returns a list of human-readable problems; empty means the document is valid. */
export function validateMatrix(value: unknown): string[] {
  const problems: string[] = [];
  const m = value as Partial<Matrix>;

  if (!m || typeof m !== 'object') return ['matrix is not an object'];
  if (m.schemaVersion !== SCHEMA_VERSION) problems.push(`schemaVersion must be ${SCHEMA_VERSION}`);
  if (typeof m.generatedAt !== 'string' || Number.isNaN(Date.parse(m.generatedAt))) {
    problems.push('generatedAt must be an ISO timestamp');
  }
  if (!m.eslintVersions || typeof m.eslintVersions.v9 !== 'string' || typeof m.eslintVersions.v10 !== 'string') {
    problems.push('eslintVersions must be {v9, v10} strings');
  }
  if (!Array.isArray(m.plugins)) return [...problems, 'plugins must be an array'];

  const seen = new Set<string>();
  for (const [i, row] of m.plugins.entries()) {
    const at = `plugins[${i}]`;
    if (!row || typeof row.name !== 'string' || row.name.length === 0) {
      problems.push(`${at}.name must be a non-empty string`);
      continue;
    }
    if (seen.has(row.name)) problems.push(`${at}.name duplicated: ${row.name}`);
    seen.add(row.name);

    if (row.version !== null && typeof row.version !== 'string') problems.push(`${at}.version must be string|null`);
    if (row.declaredPeerRange !== null && typeof row.declaredPeerRange !== 'string') {
      problems.push(`${at}.declaredPeerRange must be string|null`);
    }
    if (typeof row.weeklyDownloads !== 'number') problems.push(`${at}.weeklyDownloads must be a number`);
    if (!row.results || typeof row.results !== 'object') {
      problems.push(`${at}.results must be an object`);
      continue;
    }
    for (const [version, result] of Object.entries(row.results)) {
      const rat = `${at}.results['${version}']`;
      if (!STATUSES.has(result?.status)) problems.push(`${rat}.status invalid: ${result?.status}`);
      if (!Array.isArray(result?.crashingRules)) problems.push(`${rat}.crashingRules must be an array`);
      else {
        for (const [j, rule] of result.crashingRules.entries()) {
          if (typeof rule?.rule !== 'string' || typeof rule?.message !== 'string') {
            problems.push(`${rat}.crashingRules[${j}] must be {rule, message} strings`);
          }
        }
      }
      if (typeof result?.totalRules !== 'number') problems.push(`${rat}.totalRules must be a number`);
    }

    if (row.rescue !== undefined) {
      const rat = `${at}.rescue`;
      if (!row.rescue || typeof row.rescue !== 'object') {
        problems.push(`${rat} must be an object when present`);
        continue;
      }
      if (!RESCUE_VERDICTS.has(row.rescue.verdict)) problems.push(`${rat}.verdict invalid: ${row.rescue.verdict}`);
      if (typeof row.rescue.attempted !== 'boolean') problems.push(`${rat}.attempted must be a boolean`);
      if (typeof row.rescue.eslintVersion !== 'string') problems.push(`${rat}.eslintVersion must be a string`);
      if (typeof row.rescue.compatVersion !== 'string') problems.push(`${rat}.compatVersion must be a string`);
      if (!row.rescue.attempted && typeof row.rescue.skipReason !== 'string') {
        problems.push(`${rat}.skipReason must explain an unattempted rescue`);
      }
      if (row.rescue.residualRules !== undefined) {
        if (!Array.isArray(row.rescue.residualRules)) problems.push(`${rat}.residualRules must be an array`);
        else {
          for (const [j, rule] of row.rescue.residualRules.entries()) {
            if (typeof rule?.rule !== 'string' || typeof rule?.message !== 'string') {
              problems.push(`${rat}.residualRules[${j}] must be {rule, message} strings`);
            }
          }
        }
      }
    }
  }
  return problems;
}

export async function writeMatrix(path: string, matrix: Matrix): Promise<void> {
  const problems = validateMatrix(matrix);
  if (problems.length > 0) {
    throw new Error(`refusing to write an invalid matrix:\n  - ${problems.join('\n  - ')}`);
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(matrix, null, 2)}\n`, 'utf8');
}
