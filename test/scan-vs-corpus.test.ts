import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { classify } from '../packages/cli/src/classify.js';
import { collectFiles } from '../packages/cli/src/collect-files.js';
import { resolveInstalled } from '../packages/cli/src/installed.js';
import type { Matrix, PluginRow } from '../packages/cli/src/matrix.js';
import { deriveRescue, rescueEligibility } from '../packages/cli/src/rescue.js';
import { buildReport, renderReport, verdictFor } from '../packages/cli/src/report.js';
import { resolveConfig } from '../packages/cli/src/resolve-config.js';
import { ESLINT_9, probeFixturePlugin, REPO_ROOT } from './probe-sandbox.js';

const SCAN_REPO = join(REPO_ROOT, 'test', 'fixtures', 'scan-repo');
const PLUGIN = 'eslint-plugin-fixture-lazy-import';
const PLUGIN_DIR = join(SCAN_REPO, 'node_modules', PLUGIN);

async function versionOf(dir: string): Promise<string> {
  return (JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as { version: string }).version;
}

async function measure(caseName: string, eslintDir: string | undefined, files?: string[], fixup = false) {
  const { probe, stderr } = await probeFixturePlugin(caseName, PLUGIN_DIR, 'fixture', {
    eslintDir,
    ...(fixup ? { fixup } : {}),
    ...(files ? { cwd: SCAN_REPO, files, recordFiles: true } : {}),
  });
  return classify(probe, stderr);
}

/**
 * The reason `scan` exists. Same plugin, same two ESLint versions, same probe:
 * the only thing that changes is which files get linted, and that flips the
 * verdict from CLEAN to BLOCKED.
 */
describe('the corpus and the caller\'s own repository can disagree', () => {
  it('tiers CLEAN on the fixture corpus and BLOCKED on the repo that triggers it', async () => {
    const v9 = await versionOf(ESLINT_9);
    const v10 = await versionOf(join(REPO_ROOT, 'node_modules', 'eslint'));
    const eslintVersions = { v9, v10 };

    const resolved = await resolveConfig(SCAN_REPO);
    expect(resolved.plugins).toEqual([PLUGIN]);
    expect(resolved.ignores).toEqual(['build/**']);

    const collected = await collectFiles(SCAN_REPO, { ignores: resolved.ignores });
    expect(collected.files).toContain(join('src', 'Card.jsx'));
    expect(collected.files).not.toContain(join('build', 'generated.js'));

    const installed = await resolveInstalled(PLUGIN, SCAN_REPO, null);
    expect(installed?.version).toBe('1.2.3');

    const rowFrom = async (name: string, files?: string[]): Promise<PluginRow> => {
      const onNine = await measure(`${name}-9`, ESLINT_9, files);
      const onTen = await measure(`${name}-10`, undefined, files);
      const row: PluginRow = {
        name: PLUGIN,
        version: installed!.version,
        declaredPeerRange: installed!.peerEslintRange,
        weeklyDownloads: 0,
        results: { [v9]: onNine, [v10]: onTen },
      };
      const eligibility = rescueEligibility(onNine, onTen);
      if (eligibility.kind === 'attempt') {
        const wrapped = await measure(`${name}-fixup`, undefined, files, true);
        row.rescue = deriveRescue(onNine, onTen, wrapped, v10, eligibility.newlyBroken);
      }
      return row;
    };

    const corpusRow = await rowFrom('corpus');
    const repoRow = await rowFrom('repo', collected.files);

    expect(corpusRow.results[v9]!.status).toBe('clean');
    expect(corpusRow.results[v10]!.status).toBe('clean');
    expect(verdictFor(corpusRow, eslintVersions).verdict).toBe('clean');

    expect(repoRow.results[v9]!.status).toBe('clean');
    expect(repoRow.results[v10]!.status).toBe('rule-crash');
    expect(verdictFor(repoRow, eslintVersions).verdict).toBe('blocked');
    // The wrap is measured rather than predicted from the message, and here it
    // genuinely does not help: the rule throws from inside its own visitor.
    expect(repoRow.rescue).toMatchObject({ attempted: true, verdict: 'blocked' });
    expect(corpusRow.rescue).toBeUndefined();

    const crash = repoRow.results[v10]!.crashingRules;
    expect(crash).toHaveLength(1);
    expect(crash[0]).toMatchObject({
      rule: 'no-lazy-import',
      file: join('src', 'Card.jsx'),
      fileCount: 2,
    });

    const matrix: Matrix = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      eslintVersions,
      plugins: [repoRow],
    };
    const rendered = renderReport(
      buildReport(matrix, {
        plugins: [PLUGIN],
        unknown: [],
        projectDir: SCAN_REPO,
        configPath: resolved.configPath,
        measured: { files: collected.files.length, baseline: v9 },
      }),
      { color: false }
    );
    expect(rendered).toContain('BLOCKED');
    expect(rendered).toContain('1.2.3');
    expect(rendered).toContain(`fixture-lazy-import/no-lazy-import crashed on ${join('src', 'Card.jsx')}`);
    expect(rendered).toContain('(1 more file)');
  }, 120_000);
});
