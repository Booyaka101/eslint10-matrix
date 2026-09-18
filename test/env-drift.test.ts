import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { measuredDrift } from '../packages/cli/src/env-drift.js';
import type { Matrix, MeasuredEnv } from '../packages/cli/src/matrix.js';
import { buildReport, renderReport } from '../packages/cli/src/report.js';
import { ROOT, runNode } from './run-script.js';

async function repo(installed: Record<string, string>, files: Record<string, string> = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'e10m-drift-'));
  for (const [name, version] of Object.entries(installed)) {
    const pkgDir = join(dir, 'node_modules', ...name.split('/'));
    await mkdir(pkgDir, { recursive: true });
    await writeFile(join(pkgDir, 'package.json'), JSON.stringify({ name, version }));
  }
  for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), text);
  return dir;
}

const env = (deps: Record<string, string | null>): MeasuredEnv => ({ node: '22.18.0', npm: '10.9.3', deps });

const row = (name: string, deps: Record<string, string | null>) => ({ name, measuredWith: env(deps) });

describe('measuredDrift', () => {
  it('names the package the verdict was measured against, and what this repo has', async () => {
    const dir = await repo({ 'vue-eslint-parser': '9.1.0' });
    const drift = await measuredDrift([row('eslint-plugin-vue', { 'vue-eslint-parser': '10.3.0' })], dir);
    expect(drift).toEqual([
      {
        plugin: 'eslint-plugin-vue',
        deltas: [{ package: 'vue-eslint-parser', before: '10.3.0', after: '9.1.0' }],
      },
    ]);
  });

  it('says nothing when the repo has what the board measured', async () => {
    const dir = await repo({ 'vue-eslint-parser': '10.3.0' });
    expect(await measuredDrift([row('eslint-plugin-vue', { 'vue-eslint-parser': '10.3.0' })], dir)).toEqual([]);
  });

  /** The board runs ESLint 10 and a repo running `check` is on 9, so it always differs. */
  it('does not report eslint itself', async () => {
    const dir = await repo({ eslint: '9.39.5' });
    expect(await measuredDrift([row('eslint-plugin-vue', { eslint: '10.10.0' })], dir)).toEqual([]);
  });

  /**
   * The probe installs peers this repo may legitimately not have, and a list of
   * packages you do not use would bury the row that matters.
   */
  it('skips a package only one side has', async () => {
    const dir = await repo({ 'vue-eslint-parser': '9.1.0' });
    const drift = await measuredDrift(
      [row('eslint-plugin-vue', { 'vue-eslint-parser': '10.3.0', typescript: '5.9.3', jest: null })],
      dir
    );
    expect(drift[0]!.deltas.map((d) => d.package)).toEqual(['vue-eslint-parser']);
  });

  it('falls back to the lockfile when nothing is installed', async () => {
    const dir = await repo(
      {},
      {
        'package-lock.json': JSON.stringify({
          lockfileVersion: 3,
          packages: { 'node_modules/vue-eslint-parser': { version: '9.1.0' } },
        }),
      }
    );
    const drift = await measuredDrift([row('eslint-plugin-vue', { 'vue-eslint-parser': '10.3.0' })], dir);
    expect(drift[0]!.deltas).toEqual([{ package: 'vue-eslint-parser', before: '10.3.0', after: '9.1.0' }]);
  });

  /** Every board published before 1.4.0 is this case, so it has to cost nothing. */
  it('has nothing to say about a board that recorded no environment', async () => {
    const dir = await repo({ 'vue-eslint-parser': '9.1.0' });
    expect(await measuredDrift([{ name: 'eslint-plugin-vue', measuredWith: undefined }], dir)).toEqual([]);
  });
});

const CLEAN_BOARD: Matrix = {
  schemaVersion: 1,
  generatedAt: '2026-09-18T00:00:00.000Z',
  eslintVersions: { v9: '9.39.5', v10: '10.10.0' },
  plugins: [
    {
      name: 'eslint-plugin-vue',
      version: '10.5.0',
      declaredPeerRange: '^9.0.0 || ^10.0.0',
      weeklyDownloads: 1,
      results: {
        '9.39.5': { status: 'clean', crashingRules: [], totalRules: 4 },
        '10.10.0': { status: 'clean', crashingRules: [], totalRules: 4 },
      },
    },
  ],
};

const reportWith = (drift: Awaited<ReturnType<typeof measuredDrift>>): string =>
  renderReport(
    buildReport(CLEAN_BOARD, {
      plugins: ['eslint-plugin-vue'],
      unknown: [],
      projectDir: './',
      configPath: './eslint.config.js',
      measuredDrift: drift,
    }),
    { color: false }
  );

describe('the MEASURED DIFFERENTLY section', () => {
  it('says which plugin, which package, and both versions', () => {
    const text = reportWith([
      { plugin: 'eslint-plugin-vue', deltas: [{ package: 'vue-eslint-parser', before: '10.3.0', after: '9.1.0' }] },
    ]);
    expect(text).toContain('MEASURED DIFFERENTLY (1)');
    expect(text).toContain('eslint-plugin-vue');
    expect(text).toContain('vue-eslint-parser 10.3.0, here 9.1.0');
  });

  it('is absent when nothing drifted', () => {
    expect(reportWith([])).not.toContain('MEASURED DIFFERENTLY');
  });

  /** Six packages of a repo's own drift ran past 200 columns on one line. */
  it('wraps a long list rather than running off the terminal', () => {
    const deltas = [
      { package: '@typescript-eslint/parser', before: '8.67.0', after: '8.40.1' },
      { package: 'eslint-plugin-testing-library', before: '7.13.1', after: '6.5.0' },
      { package: 'eslint-plugin-vitest', before: '0.5.4', after: '0.4.1' },
      { package: 'typescript', before: '5.9.3', after: '5.4.5' },
      { package: 'vitest', before: '2.1.9', after: '1.6.0' },
    ];
    const lines = reportWith([{ plugin: 'eslint-plugin-testing-library', deltas }])
      .split('\n')
      .filter((line) => line.includes('here '));
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(118);
    for (const delta of deltas) expect(lines.join('\n')).toContain(`${delta.package} ${delta.before}, here ${delta.after}`);
  });
});

/**
 * The whole point of recording what the probe installed: a repo is told a plugin
 * is clean on ESLint 10 on the strength of a parser it is not running.
 */
describe('check, end to end', () => {
  it('tells a repo when its own versions are not the ones the verdict came from', async () => {
    const dir = await repo({ 'eslint-plugin-vue': '10.5.0', 'vue-eslint-parser': '9.1.0' });
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'drift-app',
        version: '0.0.0',
        private: true,
        type: 'module',
        devDependencies: { eslint: '^10.9.0', 'eslint-plugin-vue': '10.5.0', 'vue-eslint-parser': '9.1.0' },
      })
    );
    await writeFile(
      join(dir, 'eslint.config.js'),
      ["import vue from 'eslint-plugin-vue';", '', 'export default [{ plugins: { vue } }];', ''].join('\n')
    );
    // The config gets imported for real, so the plugin needs something to import.
    await writeFile(
      join(dir, 'node_modules', 'eslint-plugin-vue', 'package.json'),
      JSON.stringify({ name: 'eslint-plugin-vue', version: '10.5.0', type: 'module', main: 'index.js' })
    );
    await writeFile(join(dir, 'node_modules', 'eslint-plugin-vue', 'index.js'), 'export default { rules: {} };\n');

    const board: Matrix = structuredClone(CLEAN_BOARD);
    board.plugins[0]!.results['10.10.0']!.measuredWith = env({
      eslint: '10.10.0',
      'vue-eslint-parser': '10.3.0',
    });
    const matrixPath = join(dir, 'matrix.json');
    await writeFile(matrixPath, JSON.stringify(board));

    const cli = join(ROOT, 'packages', 'cli', 'dist', 'index.js');
    const human = await runNode(cli, ['check', dir, '--matrix', matrixPath, '--no-cache', '--no-color']);
    expect(human.code).toBe(0);
    expect(human.out).toContain('MEASURED DIFFERENTLY (1)');
    expect(human.out).toContain('vue-eslint-parser 10.3.0, here 9.1.0');
    // eslint is the axis, not drift, even though the repo is on a different one.
    expect(human.out).not.toContain('eslint 10.10.0, here');

    // A note, not a verdict: the board knows the versions disagree, not that the
    // disagreement matters, so it must not fail anybody's build.
    const ci = await runNode(cli, ['check', dir, '--matrix', matrixPath, '--no-cache', '--ci', '--no-color']);
    expect(ci.code).toBe(0);
    expect(ci.out).toContain('MEASURED DIFFERENTLY (1)');

    const json = await runNode(cli, ['check', dir, '--matrix', matrixPath, '--no-cache', '--json']);
    const parsed = JSON.parse(json.out) as { measuredDrift?: Array<{ plugin: string }> };
    expect(parsed.measuredDrift).toEqual([
      {
        plugin: 'eslint-plugin-vue',
        deltas: [{ package: 'vue-eslint-parser', before: '10.3.0', after: '9.1.0' }],
      },
    ]);
  });
});
