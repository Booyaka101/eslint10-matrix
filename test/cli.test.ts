import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadMatrix, MatrixError, type Matrix } from '../packages/cli/src/matrix.js';
import { buildReport, renderOverrides, renderReport, verdictFor } from '../packages/cli/src/report.js';
import { ConfigError, conventionalPackageNames, findConfigFile, resolveConfig } from '../packages/cli/src/resolve-config.js';
import { satisfies } from '../packages/cli/src/semver-lite.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_FIXTURE = join(HERE, 'fixtures', 'repo');

function result(status: 'clean' | 'rule-crash' | 'load-fail', rules: string[] = [], totalRules = 10) {
  return {
    status,
    totalRules,
    crashingRules: rules.map((rule) => ({ rule, message: `Error while loading rule '${rule}': boom` })),
  };
}

const MATRIX: Matrix = {
  schemaVersion: 1,
  generatedAt: '2026-08-22T09:00:00.000Z',
  eslintVersions: { v9: '9.39.5', v10: '10.9.0' },
  plugins: [
    {
      name: 'eslint-plugin-react',
      version: '7.37.5',
      declaredPeerRange: '^3 || ^4 || ^5 || ^6 || ^7 || ^8 || ^9.7',
      weeklyDownloads: 50254779,
      results: {
        '9.39.5': result('clean', [], 101),
        '10.9.0': result('rule-crash', ['display-name', 'prop-types', 'no-typos'], 101),
      },
    },
    {
      name: 'eslint-plugin-jsx-a11y',
      version: '6.10.2',
      declaredPeerRange: '^3 || ^4 || ^5 || ^6 || ^7 || ^8 || ^9',
      weeklyDownloads: 38034458,
      results: { '9.39.5': result('clean'), '10.9.0': result('load-fail') },
    },
    {
      name: 'eslint-plugin-import',
      version: '2.32.0',
      declaredPeerRange: '^2 || ^3 || ^4 || ^5 || ^6 || ^7.2.0 || ^8 || ^9',
      weeklyDownloads: 49679969,
      results: { '9.39.5': result('clean', [], 84), '10.9.0': result('clean', [], 84) },
    },
    {
      name: 'eslint-plugin-promise',
      version: '7.3.0',
      declaredPeerRange: '^7.0.0 || ^8.0.0 || ^9.0.0',
      weeklyDownloads: 5430594,
      results: { '9.39.5': result('clean', [], 17), '10.9.0': result('clean', [], 17) },
    },
    {
      name: '@typescript-eslint/eslint-plugin',
      version: '8.67.0',
      declaredPeerRange: '^8.57.0 || ^9.0.0 || ^10.0.0',
      weeklyDownloads: 114433858,
      results: { '9.39.5': result('clean', [], 150), '10.9.0': result('clean', [], 150) },
    },
  ],
};

const INPUT = {
  plugins: [
    'eslint-plugin-react',
    'eslint-plugin-jsx-a11y',
    'eslint-plugin-import',
    'eslint-plugin-promise',
    '@typescript-eslint/eslint-plugin',
    'eslint-plugin-nowhere',
  ],
  unknown: ['mystery'],
  projectDir: './',
  configPath: './eslint.config.js',
};

describe('resolve-config', () => {
  it('finds a flat config by walking upward', () => {
    expect(findConfigFile(join(REPO_FIXTURE, 'stubs'))).toBe(join(REPO_FIXTURE, 'eslint.config.js'));
  });

  it('returns exactly the three plugin package names used by a real eslint.config.js', async () => {
    const resolved = await resolveConfig(REPO_FIXTURE);
    expect(resolved.plugins).toEqual(['eslint-plugin-import', 'eslint-plugin-promise', 'eslint-plugin-react']);
    expect(resolved.unknown).toEqual([]);
    expect(resolved.configPath).toBe(join(REPO_FIXTURE, 'eslint.config.js'));
  });

  it('reports a plugin absent from package.json as unknown instead of guessing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'e10m-cfg-'));
    try {
      await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'x', type: 'module', devDependencies: {} }));
      await writeFile(
        join(dir, 'eslint.config.js'),
        'export default [{ files: ["**/*.js"], plugins: { ghost: { rules: {} } }, rules: {} }];\n'
      );
      const resolved = await resolveConfig(dir);
      expect(resolved.plugins).toEqual([]);
      expect(resolved.unknown).toEqual(['ghost']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('names flat config as the requirement when no config file exists', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'e10m-empty-'));
    try {
      await expect(resolveConfig(dir)).rejects.toThrowError(ConfigError);
      await expect(resolveConfig(dir)).rejects.toThrow(/no ESLint flat config found/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('maps config keys to conventional package names', () => {
    expect(conventionalPackageNames('react')).toContain('eslint-plugin-react');
    expect(conventionalPackageNames('@typescript-eslint')).toContain('@typescript-eslint/eslint-plugin');
    expect(conventionalPackageNames('@next/next')).toContain('@next/eslint-plugin-next');
  });
});

describe('semver-lite', () => {
  it('decides whether a declared peer range admits ESLint 10', () => {
    expect(satisfies('10.9.0', '^3 || ^4 || ^5 || ^6 || ^7 || ^8 || ^9.7')).toBe(false);
    expect(satisfies('10.9.0', '^7.0.0 || ^8.0.0 || ^9.0.0 || ^10.0.0')).toBe(true);
    expect(satisfies('10.9.0', '>=8.40.0')).toBe(true);
    expect(satisfies('10.9.0', '^10.0.0')).toBe(true);
    expect(satisfies('10.9.0', '*')).toBe(true);
    expect(satisfies('10.9.0', null)).toBe(false);
    expect(satisfies('10.9.0', '^9')).toBe(false);
    expect(satisfies('9.39.5', '^9.7')).toBe(true);
    expect(satisfies('9.5.0', '^9.7')).toBe(false);
    expect(satisfies('10.9.0', '>=9 <10')).toBe(false);
  });
});

describe('report', () => {
  const report = buildReport(MATRIX, INPUT);

  it('sorts plugins into blocked, safe-to-force, clean and untested', () => {
    expect(report.blocked.map((e) => e.name)).toEqual(['eslint-plugin-jsx-a11y', 'eslint-plugin-react']);
    expect(report.safeToForce.map((e) => e.name)).toEqual(['eslint-plugin-import', 'eslint-plugin-promise']);
    expect(report.clean.map((e) => e.name)).toEqual(['@typescript-eslint/eslint-plugin']);
    expect(report.untested.map((e) => e.name)).toEqual(['eslint-plugin-nowhere']);
    expect(report.unknown.map((e) => e.name)).toEqual(['mystery']);
  });

  it('describes each blocked plugin with its actual failure', () => {
    const react = report.blocked.find((e) => e.name === 'eslint-plugin-react')!;
    expect(react.reason).toBe('3 rules crash on 10.9.0: display-name, prop-types, no-typos');
    const a11y = report.blocked.find((e) => e.name === 'eslint-plugin-jsx-a11y')!;
    expect(a11y.reason).toBe('fails to load on 10.9.0');
  });

  it('links untested plugins to an issue template', () => {
    expect(report.untested[0]!.reason).toMatch(/github\.com\/.+\/issues\/new/);
  });

  it('renders the overrides block for a two-plugin safe list', () => {
    expect(renderOverrides(report.overrides)).toMatchInlineSnapshot(`
      "    {
            "overrides": {
              "eslint-plugin-import": {
                "eslint": "$eslint"
              },
              "eslint-plugin-promise": {
                "eslint": "$eslint"
              }
            }
          }"
    `);
  });

  it('renders all three buckets in the human report', () => {
    const text = renderReport(report, { color: false });
    expect(text).toContain('BLOCKED (2)');
    expect(text).toContain('SAFE TO FORCE (2)');
    expect(text).toContain('CLEAN (1)');
    expect(text).toContain('eslint-plugin-react@7.37.5');
    expect(text).toContain('"eslint": "$eslint"');
    expect(text).not.toContain(String.fromCharCode(27)); // no ANSI escapes when colour is off
  });

  it('does not blame the upgrade for a failure that reproduces on ESLint 9', () => {
    const preexisting: Matrix = {
      ...MATRIX,
      plugins: [
        {
          name: 'eslint-plugin-typed',
          version: '1.0.0',
          declaredPeerRange: '^9 || ^10',
          weeklyDownloads: 1,
          results: {
            '9.39.5': result('rule-crash', ['needs-type-info'], 20),
            '10.9.0': result('rule-crash', ['needs-type-info'], 20),
          },
        },
      ],
    };
    const report = buildReport(preexisting, { ...INPUT, plugins: ['eslint-plugin-typed'], unknown: [] });
    expect(report.blocked).toHaveLength(0);
    expect(report.clean.map((e) => e.name)).toEqual(['eslint-plugin-typed']);
    expect(report.clean[0]!.reason).toMatch(/reproduces on 9\.39\.5 too/);
  });

  it('blocks only on the rules that are newly broken by ESLint 10', () => {
    const mixed: Matrix = {
      ...MATRIX,
      plugins: [
        {
          name: 'eslint-plugin-mixed',
          version: '1.0.0',
          declaredPeerRange: '^9',
          weeklyDownloads: 1,
          results: {
            '9.39.5': result('rule-crash', ['always-broken'], 20),
            '10.9.0': result('rule-crash', ['always-broken', 'broke-in-ten'], 20),
          },
        },
      ],
    };
    const report = buildReport(mixed, { ...INPUT, plugins: ['eslint-plugin-mixed'], unknown: [] });
    expect(report.blocked).toHaveLength(1);
    expect(report.blocked[0]!.reason).toBe('1 rule crashes on 10.9.0: broke-in-ten');
    expect(report.blocked[0]!.result!.crashingRules.map((r) => r.rule)).toEqual(['broke-in-ten']);
  });

  it('blocks a plugin that loads on 9 but not on 10', () => {
    const loadFail: Matrix = {
      ...MATRIX,
      plugins: [
        {
          name: 'eslint-plugin-vitest',
          version: '0.5.4',
          declaredPeerRange: '^8.0.0 || ^9.0.0',
          weeklyDownloads: 1,
          results: { '9.39.5': result('clean', [], 52), '10.9.0': result('load-fail', [], 0) },
        },
      ],
    };
    const report = buildReport(loadFail, { ...INPUT, plugins: ['eslint-plugin-vitest'], unknown: [] });
    expect(report.blocked.map((e) => e.reason)).toEqual(['fails to load on 10.9.0']);
  });

  it('does not call a bounded range that excludes 10 "already declares ^10"', () => {
    // The site build once had its own looser range check and rendered this as ready.
    const bounded: Matrix = {
      ...MATRIX,
      plugins: [
        {
          name: 'eslint-plugin-bounded',
          version: '1.0.0',
          declaredPeerRange: '>=9 <10',
          weeklyDownloads: 1,
          results: { '9.39.5': result('clean', [], 5), '10.9.0': result('clean', [], 5) },
        },
      ],
    };
    expect(verdictFor(bounded.plugins[0]!, bounded.eslintVersions).verdict).toBe('force');
    const report = buildReport(bounded, { ...INPUT, plugins: ['eslint-plugin-bounded'], unknown: [] });
    expect(report.clean).toHaveLength(0);
    expect(report.safeToForce.map((e) => e.name)).toEqual(['eslint-plugin-bounded']);
  });

  it('says nothing blocks the upgrade when the blocked bucket is empty', () => {
    const clear = buildReport(MATRIX, { ...INPUT, plugins: ['eslint-plugin-import'], unknown: [] });
    expect(clear.blocked).toHaveLength(0);
    expect(renderReport(clear)).toContain('Nothing blocks the upgrade');
  });
});

describe('matrix loading', () => {
  it('reads a matrix from a local path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'e10m-mx-'));
    try {
      const file = join(dir, 'matrix.json');
      await writeFile(file, JSON.stringify(MATRIX));
      const load = await loadMatrix({ file });
      expect(load.source).toBe('file');
      expect(load.matrix.plugins).toHaveLength(5);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('gives a clear error for a missing matrix file', async () => {
    await expect(loadMatrix({ file: resolve('definitely-not-here.json') })).rejects.toThrow(/matrix file not found/);
  });

  it('rejects a future schema version with an upgrade hint', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'e10m-mx2-'));
    try {
      const file = join(dir, 'matrix.json');
      await writeFile(file, JSON.stringify({ ...MATRIX, schemaVersion: 99 }));
      await expect(loadMatrix({ file })).rejects.toThrowError(MatrixError);
      await expect(loadMatrix({ file })).rejects.toThrow(/unsupported matrix schemaVersion/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('falls back to an error rather than a stack trace when the network is unreachable', async () => {
    await expect(
      loadMatrix({ url: 'https://127.0.0.1:9/matrix.json', noCache: true, timeoutMs: 1500 })
    ).rejects.toThrowError(MatrixError);
  });
});
