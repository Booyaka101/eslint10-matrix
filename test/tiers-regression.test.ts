import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Matrix } from '../packages/cli/src/matrix.js';
import { buildReport, renderReport, verdictFor, type Entry } from '../packages/cli/src/report.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

interface Captured {
  eslintVersions: { v9: string; v10: string };
  matrixGeneratedAt: string;
  verdicts: { name: string; version: string | null; verdict: string; regressedRules: string[] }[];
  buckets: Record<string, { name: string; bucket: string; reason: string; snippet: string | null }[]>;
  overrides: Record<string, { eslint: string }>;
  rendered: string;
}

async function readJson<T>(name: string): Promise<T> {
  return JSON.parse(await readFile(join(FIXTURES, name), 'utf8')) as T;
}

function summarise(entries: Entry[]): { name: string; bucket: string; reason: string; snippet: string | null }[] {
  return entries.map((e) => ({ name: e.name, bucket: e.bucket, reason: e.reason, snippet: e.snippet ?? null }));
}

/**
 * The shared-module extraction moved classification and rescue out of the runner
 * and into the CLI. Nothing about the tiers was meant to change, so this replays
 * the 1.1.0 matrix through the current code and compares against output captured
 * before the move. Both fixtures are frozen: refreshing the published board must
 * not touch them.
 */
describe('tiers are unchanged by the shared-module extraction', () => {
  it('reproduces the captured verdicts, buckets, overrides and rendered report', async () => {
    const matrix = await readJson<Matrix>('matrix-1.1.0.json');
    const before = await readJson<Captured>('tiers-before-refactor.json');

    const report = buildReport(matrix, {
      plugins: matrix.plugins.map((p) => p.name),
      unknown: [],
      projectDir: '/regression',
      configPath: '/regression/eslint.config.js',
    });

    const verdicts = matrix.plugins.map((row) => ({
      name: row.name,
      version: row.version,
      ...verdictFor(row, matrix.eslintVersions),
    }));

    expect(matrix.eslintVersions).toEqual(before.eslintVersions);
    expect(matrix.generatedAt).toBe(before.matrixGeneratedAt);
    expect(verdicts).toEqual(before.verdicts);
    expect({
      blocked: summarise(report.blocked),
      rescuable: summarise(report.rescuable),
      partialRescue: summarise(report.partialRescue),
      safeToForce: summarise(report.safeToForce),
      clean: summarise(report.clean),
    }).toEqual(before.buckets);
    expect(report.overrides).toEqual(before.overrides);
    expect(renderReport(report)).toBe(before.rendered);
  });
});
