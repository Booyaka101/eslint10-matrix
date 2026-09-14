import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { detectHarness, partitionHarness, type HarnessContext } from '../packages/cli/src/harness.js';
import type { Matrix, PluginRow, PluginRunResult } from '../packages/cli/src/matrix.js';
import { buildReport, regressionOnTen, renderReport, verdictFor } from '../packages/cli/src/report.js';
import { validateMatrix } from '../packages/runner/src/emit.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

/**
 * Both fixtures come out of the nightly board committed as 0eabb76, the last one
 * published before issue #12 repaired the environment. Nothing here is written
 * by hand: matrix-harness-raw.json is three of that board's rows verbatim, and
 * matrix-harness.json is the same three after partitionHarness, which is what
 * the runner would write today. `reproduces the committed fixture` keeps them
 * in step.
 */
async function readJson<T>(name: string): Promise<T> {
  return JSON.parse(await readFile(join(FIXTURES, name), 'utf8')) as T;
}

function rowFor(matrix: Matrix, name: string): PluginRow {
  const row = matrix.plugins.find((p) => p.name === name);
  if (!row) throw new Error(`fixture is missing ${name}`);
  return row;
}

function results(matrix: Matrix, name: string): [PluginRunResult, PluginRunResult] {
  const row = rowFor(matrix, name);
  const { v9, v10 } = matrix.eslintVersions;
  return [row.results[v9]!, row.results[v10]!];
}

const CORPUS: Omit<HarnessContext, 'plugin'> = { recordFiles: false };

function partition(matrix: Matrix, name: string) {
  const [onNine, onTen] = results(matrix, name);
  return partitionHarness(onNine, onTen, { plugin: name, ...CORPUS });
}

describe('harness attribution on the rows that caused issues #10 and #11', () => {
  it('(a) calls the jest version crash a missing peer and names the package to install', async () => {
    const raw = await readJson<Matrix>('matrix-harness-raw.json');
    const [onNine] = results(raw, 'eslint-plugin-jest');
    expect(onNine.crashingRules[0]!.message).toMatch(/Unable to detect Jest version/);

    const { onNine: nine, onTen: ten } = partition(raw, 'eslint-plugin-jest');
    for (const result of [nine!, ten]) {
      expect(result.status).toBe('harness-misconfig');
      expect(result.crashingRules).toEqual([]);
      const [finding] = result.harness!.rules;
      expect(finding!.rule).toBe('no-deprecated-functions');
      expect(finding!.cause).toBe('missing-peer');
      expect(finding!.subject).toBe('jest');
      expect(finding!.detail).toContain('jest');
      expect(finding!.fix).toBe('add "jest" to extraDeps for eslint-plugin-jest in packages/runner/src/plugins.json');
    }
  });

  it('(b) calls the four typescript-eslint rules an AST shape problem', async () => {
    const raw = await readJson<Matrix>('matrix-harness-raw.json');
    const [onNine, onTen] = results(raw, '@typescript-eslint/eslint-plugin');
    for (const result of [onNine, onTen]) {
      expect(result.crashingRules).toHaveLength(4);
      for (const rule of result.crashingRules) {
        expect(rule.message).toBe("Cannot read properties of undefined (reading 'length')");
      }
    }

    const { onNine: nine, onTen: ten } = partition(raw, '@typescript-eslint/eslint-plugin');
    for (const result of [nine!, ten]) {
      expect(result.status).toBe('harness-misconfig');
      expect(result.crashingRules).toEqual([]);
      expect(result.harness!.rules.map((r) => r.rule)).toEqual([
        'explicit-function-return-type',
        'explicit-member-accessibility',
        'explicit-module-boundary-types',
        'no-useless-constructor',
      ]);
      for (const rule of result.harness!.rules) expect(rule.cause).toBe('ast-shape');
    }
  });

  it('(c) leaves eslint-plugin-react alone: the same message, but only on ESLint 10', async () => {
    const raw = await readJson<Matrix>('matrix-harness-raw.json');
    const [onNine, onTen] = results(raw, 'eslint-plugin-react');
    expect(onNine.status).toBe('clean');
    expect(onTen.crashingRules.some((r) => /getFilename is not a function/.test(r.message))).toBe(true);

    const { onNine: nine, onTen: ten } = partition(raw, 'eslint-plugin-react');
    expect(nine).toBe(onNine);
    expect(ten).toBe(onTen);
    expect(ten.status).toBe('rule-crash');
    expect(ten.crashingRules).toHaveLength(38);
    expect(ten.harness).toBeUndefined();

    const row = rowFor(raw, 'eslint-plugin-react');
    expect(verdictFor(row, raw.eslintVersions).verdict).toBe('rescuable');
  });

  it('(d) keeps a row a rule-crash when one genuine ESLint 10 crash survives', async () => {
    const raw = await readJson<Matrix>('matrix-harness-raw.json');
    const [onNine, onTen] = results(raw, 'eslint-plugin-jest');
    const genuine = { rule: 'no-large-snapshots', message: 'context.sourceCode.getScope is not a function' };
    const { onNine: nine, onTen: ten } = partitionHarness(
      onNine,
      { ...onTen, crashingRules: [...onTen.crashingRules, genuine] },
      { plugin: 'eslint-plugin-jest', ...CORPUS }
    );

    expect(ten.status).toBe('rule-crash');
    expect(ten.crashingRules).toEqual([genuine]);
    expect(ten.harness!.rules.map((r) => r.rule)).toEqual(['no-deprecated-functions']);
    // The v9 side lost its only crash, so it is clean rather than a misconfiguration.
    expect(nine!.status).toBe('clean');
    expect(nine!.harness!.rules).toHaveLength(1);

    const row: PluginRow = { ...rowFor(raw, 'eslint-plugin-jest'), results: {} };
    row.results[raw.eslintVersions.v9] = nine!;
    row.results[raw.eslintVersions.v10] = ten;
    const report = buildReport(
      { ...raw, plugins: [row] },
      { plugins: [row.name], unknown: [], projectDir: '/d', configPath: '/d/eslint.config.js' }
    );
    expect(report.harnessMisconfig).toHaveLength(0);
    expect(renderReport(report, { color: false })).toContain(
      '1 rule excluded as harness misconfiguration (missing-peer: jest)'
    );
  });
});

describe('the gate', () => {
  it('refuses to attribute a crash that only one major produces', () => {
    const crash = { rule: 'x', message: "Cannot read properties of undefined (reading 'length')" };
    const clean: PluginRunResult = { status: 'clean', crashingRules: [], totalRules: 5 };
    const crashed: PluginRunResult = { status: 'rule-crash', crashingRules: [crash], totalRules: 5 };
    const { onNine, onTen } = partitionHarness(clean, crashed, { plugin: 'p', ...CORPUS });
    expect(onNine).toBe(clean);
    expect(onTen).toBe(crashed);
  });

  it('refuses when the two majors crash the same rule for different causes', () => {
    const nine: PluginRunResult = {
      status: 'rule-crash',
      crashingRules: [{ rule: 'x', message: "Cannot find module 'jest'" }],
      totalRules: 5,
    };
    const ten: PluginRunResult = {
      status: 'rule-crash',
      crashingRules: [{ rule: 'x', message: "Cannot read properties of undefined (reading 'length')" }],
      totalRules: 5,
    };
    const partitioned = partitionHarness(nine, ten, { plugin: 'p', ...CORPUS });
    expect(partitioned.onNine).toBe(nine);
    expect(partitioned.onTen).toBe(ten);
  });

  it('attributes a missing parser from one side alone, because it is environment-wide', () => {
    const withoutParser: PluginRunResult = {
      status: 'rule-crash',
      crashingRules: [{ rule: 'x', message: 'boom' }],
      totalRules: 5,
      parserRequested: true,
      parserLoaded: false,
    };
    const { onNine, onTen } = partitionHarness(withoutParser, { ...withoutParser }, { plugin: 'p', ...CORPUS });
    expect(onNine!.status).toBe('harness-misconfig');
    expect(onTen.status).toBe('harness-misconfig');
    expect(onTen.harness!.rules[0]!.cause).toBe('parser-unavailable');
  });
});

describe('detectHarness', () => {
  const result: PluginRunResult = { status: 'rule-crash', crashingRules: [], totalRules: 1 };
  const ctx: HarnessContext = { plugin: 'eslint-plugin-x', recordFiles: false };

  /**
   * Every `is not a function` crash on the published board so far has been an
   * ESLint API the plugin still calls, which is the plugin's problem and the one
   * the rescue pass fixes. eslint-plugin-node fails this way on both majors, so
   * only the receiver test keeps it out of the harness bucket.
   */
  it.each([
    'context.getScope is not a function',
    "Error while loading rule 'node/shebang': context.getSourceCode is not a function",
    'contextOrFilename.getFilename is not a function',
    'sourceCode.isSpaceBetweenTokens is not a function',
    'getSourceCode(...).isSpaceBetweenTokens is not a function',
  ])('does not call a removed ESLint API an AST shape problem: %s', (message) => {
    expect(detectHarness(message, result, ctx)).toBeNull();
  });

  it('does call a missing method on an AST node an AST shape problem', () => {
    expect(detectHarness('node.getTypeAnnotation is not a function', result, ctx)?.cause).toBe('ast-shape');
  });

  it('will not name a missing module that is the plugin itself', () => {
    expect(detectHarness(`Cannot find module 'eslint-plugin-x'`, result, ctx)).toBeNull();
    expect(detectHarness(`Cannot find module 'eslint-plugin-x/lib/rules'`, result, ctx)).toBeNull();
  });

  it('will not guess a package name it cannot read', () => {
    expect(detectHarness('ERR_MODULE_NOT_FOUND', result, ctx)).toBeNull();
  });

  it('reports unparsed fixtures only for the corpus, never for a scanned repo', () => {
    const unparsed: PluginRunResult = { ...result, parseErrors: 3, lintedFiles: 3 };
    expect(detectHarness('anything', unparsed, ctx)?.cause).toBe('corpus-unparsed');
    expect(detectHarness('anything', unparsed, { ...ctx, recordFiles: true })).toBeNull();
  });

  /**
   * eslint-plugin-vue really does leave two fixtures unparsed on every run while
   * measuring the rest of the corpus clean. Voiding a run over that would throw
   * away a genuine ESLint 10 crash the first time that plugin had one.
   */
  it('ignores a corpus that only partly failed to parse', () => {
    const partly: PluginRunResult = { ...result, parseErrors: 2, lintedFiles: 40 };
    expect(detectHarness('anything', partly, ctx)).toBeNull();
  });

  it('tells a scan user to install the package, not to edit this repository', () => {
    const finding = detectHarness('Unable to detect Jest version', result, { ...ctx, recordFiles: true });
    expect(finding?.fix).toBe('install jest here, so the probe measures eslint-plugin-x the way this repo runs it');
  });
});

describe('a harness-misconfig row never blocks an upgrade', () => {
  it('is not a regression, so it never reaches the rescue pass', async () => {
    const board = await readJson<Matrix>('matrix-harness.json');
    const [onNine, onTen] = results(board, 'eslint-plugin-jest');
    expect(onTen.status).toBe('harness-misconfig');
    expect(regressionOnTen(onNine, onTen)).toBeNull();
  });

  it('renders in its own section and stays out of the blocking count', async () => {
    const board = await readJson<Matrix>('matrix-harness.json');
    const report = buildReport(board, {
      plugins: board.plugins.map((p) => p.name),
      unknown: [],
      projectDir: '/d',
      configPath: '/d/eslint.config.js',
    });
    expect(report.harnessMisconfig.map((e) => e.name)).toEqual([
      '@typescript-eslint/eslint-plugin',
      'eslint-plugin-jest',
    ]);
    expect(report.blocked).toHaveLength(0);
    expect(report.rescuable.map((e) => e.name)).toEqual(['eslint-plugin-react']);

    const rendered = renderReport(report, { color: false });
    expect(rendered).toContain('HARNESS MISCONFIG (2)  measured with a broken environment, not a plugin failure');
    expect(rendered).toContain('add "jest" to extraDeps for eslint-plugin-jest in packages/runner/src/plugins.json');
    // The header counts every plugin measured, including the two we cannot speak for.
    expect(rendered).toContain('(3 plugins)');
  });
});

describe('the board the runner would write', () => {
  it('reproduces the committed fixture', async () => {
    const raw = await readJson<Matrix>('matrix-harness-raw.json');
    const committed = await readJson<Matrix>('matrix-harness.json');
    const { v9, v10 } = raw.eslintVersions;
    for (const row of raw.plugins) {
      const partitioned = partitionHarness(row.results[v9], row.results[v10]!, {
        plugin: row.name,
        ...CORPUS,
      });
      row.results[v9] = partitioned.onNine!;
      row.results[v10] = partitioned.onTen;
    }
    expect(raw).toEqual(committed);
  });

  it('passes the matrix validator', async () => {
    expect(validateMatrix(await readJson<Matrix>('matrix-harness.json'))).toEqual([]);
  });

  it('rejects a board that is misconfigured on ESLint 10 but not on ESLint 9', async () => {
    const board = await readJson<Matrix>('matrix-harness.json');
    const row = rowFor(board, 'eslint-plugin-jest');
    row.results[board.eslintVersions.v9] = { status: 'clean', crashingRules: [], totalRules: 71 };
    expect(validateMatrix(board)).toEqual([
      'plugins[2] is harness-misconfig on eslint 10 but clean on eslint 9',
    ]);
  });

  it('rejects a harness-misconfig status with nothing to explain it', async () => {
    const board = await readJson<Matrix>('matrix-harness.json');
    const row = rowFor(board, 'eslint-plugin-jest');
    for (const result of Object.values(row.results)) delete result.harness;
    expect(validateMatrix(board)).toContain(
      "plugins[2].results['10.10.0'].status is harness-misconfig with no harness.rules to explain it"
    );
  });
});
