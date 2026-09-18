import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { partitionHarness } from '../packages/cli/src/harness.js';
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
 * not touch them. The rendered capture was retaken once, in 1.4.0, when the notes
 * started counting the indent they print under; the two lines that moved are the
 * two that ran past 120 columns, and no verdict, bucket or override changed.
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

/**
 * 1.3.0 added a fifth status. Nothing on the board it shipped against was meant
 * to move, so this replays the board 1.2.1 published and checks every row lands
 * in the tier it landed in then. The fixture is a frozen copy rather than the
 * live matrix.json: the nightly rewrites that file and pushes it to main, where
 * a genuine upstream fix would turn this red for the wrong reason.
 */
describe('tiers are unchanged by harness attribution', () => {
  it('gives every plugin on the 1.2.1 board the tier it had then', async () => {
    const matrix = await readJson<Matrix>('matrix-1.2.1.json');
    const before = await readJson<{ verdicts: { name: string; verdict: string; regressedRules: number }[] }>(
      'tiers-1.2.1.json'
    );

    const now = matrix.plugins.map((row) => {
      const { verdict, regressedRules } = verdictFor(row, matrix.eslintVersions);
      return { name: row.name, verdict, regressedRules: regressedRules.length };
    });

    expect(now).toEqual(before.verdicts);
    expect(now.some((row) => row.verdict === 'harness-misconfig')).toBe(false);
  });

  it('leaves every result on that board untouched when the runner re-partitions it', async () => {
    const matrix = await readJson<Matrix>('matrix-1.2.1.json');
    const { v9, v10 } = matrix.eslintVersions;
    for (const row of matrix.plugins) {
      const partitioned = partitionHarness(row.results[v9], row.results[v10]!, {
        plugin: row.name,
        recordFiles: false,
      });
      expect(partitioned.onNine).toBe(row.results[v9]);
      expect(partitioned.onTen).toBe(row.results[v10]);
    }
  });
});
