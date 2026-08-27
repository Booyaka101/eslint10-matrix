import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { classify } from '../packages/runner/src/classify.js';
import { validateMatrix } from '../packages/runner/src/emit.js';
import { deriveRescue, rescueEligibility, skippedRescue } from '../packages/runner/src/rescue.js';
import type { PluginRunResult, RescueResult } from '../packages/runner/src/types.js';
import type { Matrix, PluginRow } from '../packages/cli/src/matrix.js';
import { buildReport, renderReport, verdictFor } from '../packages/cli/src/report.js';
import { importBinding, rescueSnippet } from '../packages/cli/src/snippet.js';
import { PLUGINS, probeFixturePlugin, REPO_ROOT, SANDBOX } from './probe-sandbox.js';

function result(status: 'clean' | 'rule-crash' | 'load-fail' | 'install-fail', rules: string[] = [], totalRules = 10, message?: string): PluginRunResult {
  return {
    status,
    totalRules,
    crashingRules: rules.map((rule) => ({
      rule,
      message: message ?? `Error while loading rule '${rule}': contextOrFilename.getFilename is not a function`,
    })),
    ...(status === 'load-fail' || status === 'install-fail' ? { detail: message ?? 'boom' } : {}),
  };
}

const V = { v9: '9.39.5', v10: '10.9.0' };

function rowWith(results: PluginRow['results'], rescue?: RescueResult): PluginRow {
  return {
    name: 'eslint-plugin-react',
    version: '7.37.5',
    declaredPeerRange: '^9.7',
    weeklyDownloads: 1,
    results,
    ...(rescue ? { rescue } : {}),
  };
}

const E2E_CASES = ['rescue-bare', 'rescue-wrapped', 'rescue-partial', 'rescue-unaffected', 'e2e-rescue'];

// File-level: probe.test.ts shares the sandbox root in a parallel worker, so
// each file only ever touches its own case dirs.
beforeAll(async () => {
  await mkdir(SANDBOX, { recursive: true });
});

afterAll(async () => {
  for (const dir of E2E_CASES) {
    await rm(join(SANDBOX, dir), { recursive: true, force: true });
  }
});

describe('rescue eligibility', () => {
  it('never runs on clean or safe-to-force plugins', () => {
    expect(rescueEligibility(result('clean'), result('clean')).kind).toBe('not-blocked');
  });

  it('keeps pre-existing breakage out of the rescue pass', () => {
    const same9 = result('rule-crash', ['broken-everywhere']);
    const same10 = result('rule-crash', ['broken-everywhere']);
    expect(rescueEligibility(same9, same10).kind).toBe('not-blocked');
    expect(rescueEligibility(result('load-fail'), result('load-fail')).kind).toBe('not-blocked');
  });

  it('attempts a crash caused by a removed context API', () => {
    const eligibility = rescueEligibility(result('clean'), result('rule-crash', ['display-name']));
    expect(eligibility.kind).toBe('attempt');
    if (eligibility.kind === 'attempt') expect(eligibility.newlyBroken).toEqual(['display-name']);
  });

  it('attempts a load failure through a removed API such as LegacyESLint', () => {
    const onTen = result('load-fail', [], 0, 'eslint.LegacyESLint is not a constructor');
    expect(rescueEligibility(result('clean'), onTen).kind).toBe('attempt');
  });

  it('skips crash causes @eslint/compat cannot touch, each with a short classification', () => {
    const cases: Array<[PluginRunResult, string]> = [
      [result('install-fail', [], 0, 'npm ERR! code EBADENGINE'), 'install failure, and @eslint/compat wraps rules rather than installs'],
      [result('load-fail', [], 0, "Cannot find module 'missing-peer'"), 'missing dependency'],
      [result('load-fail', [], 0, 'Error while loading parser some-parser'), 'parser failure'],
      [
        result('rule-crash', ['no-default-export'], 46, "Cannot use 'in' operator to search for 'sourceType' in undefined"),
        'not a removed context API',
      ],
    ];
    for (const [onTen, reason] of cases) {
      const eligibility = rescueEligibility(result('clean'), onTen);
      expect(eligibility.kind).toBe('skip');
      // The failing message stays on the row itself, so the reason does not echo it.
      if (eligibility.kind === 'skip') expect(eligibility.reason).toBe(reason);
    }
  });

  it('still attempts when only some crashes are a removed API', () => {
    // The mixed plugin is exactly what PARTIAL-RESCUE is for, so one rescuable
    // crash outweighs a sibling the wrapper cannot touch.
    const onTen: PluginRunResult = {
      status: 'rule-crash',
      totalRules: 20,
      crashingRules: [
        { rule: 'uses-filename', message: 'context.getFilename is not a function' },
        { rule: 'needs-peer', message: "Cannot find module 'some-peer'" },
      ],
    };
    const eligibility = rescueEligibility(result('clean'), onTen);
    expect(eligibility.kind).toBe('attempt');
    if (eligibility.kind === 'attempt') expect(eligibility.newlyBroken).toEqual(['uses-filename', 'needs-peer']);
  });

  it('enters the rescue pass for exactly the rows the CLI calls BLOCKED', () => {
    // The runner decides eligibility with the CLI's own regressionOnTen, so this
    // checks the wiring across every status pair rather than two copies agreeing.
    const pairs: Array<[PluginRunResult | undefined, PluginRunResult]> = [
      [result('clean'), result('clean')],
      [result('clean'), result('rule-crash', ['a'])],
      [result('clean'), result('load-fail')],
      [result('clean'), result('install-fail')],
      [result('rule-crash', ['a']), result('rule-crash', ['a'])],
      [result('rule-crash', ['a']), result('rule-crash', ['a', 'b'])],
      [result('load-fail'), result('load-fail')],
      [result('load-fail'), result('rule-crash', ['a'])],
      [result('install-fail'), result('load-fail')],
      [undefined, result('rule-crash', ['a'])],
      [undefined, result('clean')],
    ];
    for (const [onNine, onTen] of pairs) {
      const row = rowWith({ ...(onNine ? { [V.v9]: onNine } : {}), [V.v10]: onTen });
      const cliBlocked = verdictFor(row, V).verdict === 'blocked';
      const considered = rescueEligibility(onNine, onTen).kind !== 'not-blocked';
      expect(considered, `disagreement for v9=${onNine?.status} v10=${onTen.status}`).toBe(cliBlocked);
    }
  });
});

describe('rescue verdicts', () => {
  const onNine = result('clean', [], 101);
  const onTen = result('rule-crash', ['display-name', 'prop-types'], 101);
  const broken = ['display-name', 'prop-types'];

  it('derives RESCUABLE when the wrap removes every crash', () => {
    const wrapped: PluginRunResult = { ...result('clean', [], 101), fixupFunction: 'fixupPluginRules' };
    const rescue = deriveRescue(onNine, onTen, wrapped, V.v10, broken);
    expect(rescue.verdict).toBe('rescuable');
    expect(rescue.fixupFunction).toBe('fixupPluginRules');
    expect(rescue.crashingRulesBefore).toBe(2);
    expect(rescue.crashingRulesAfter).toBe(0);
  });

  it('derives PARTIAL-RESCUE with the exact residual rule names', () => {
    const wrapped: PluginRunResult = { ...result('rule-crash', ['prop-types'], 101), fixupFunction: 'fixupPluginRules' };
    const rescue = deriveRescue(onNine, onTen, wrapped, V.v10, broken);
    expect(rescue.verdict).toBe('partial-rescue');
    expect(rescue.residualRules!.map((r) => r.rule)).toEqual(['prop-types']);
  });

  it('stays blocked when the wrap changes nothing', () => {
    const wrapped: PluginRunResult = { ...onTen, fixupFunction: 'fixupPluginRules' };
    const rescue = deriveRescue(onNine, onTen, wrapped, V.v10, broken);
    expect(rescue.verdict).toBe('blocked');
    expect(rescue.detail).toMatch(/did not reduce/);
  });

  it('degrades to blocked with a note when @eslint/compat cannot install', () => {
    const rescue = deriveRescue(onNine, onTen, result('install-fail', [], 0, 'ERESOLVE'), V.v10, broken);
    expect(rescue.verdict).toBe('blocked');
    expect(rescue.attempted).toBe(true);
    expect(rescue.detail).toMatch(/could not install @eslint\/compat/);
  });

  it('treats a load failure that starts loading under the wrap as an improvement', () => {
    const nine = result('clean', [], 52);
    const ten = result('load-fail', [], 0, 'eslint.LegacyESLint is not a constructor');
    expect(deriveRescue(nine, ten, result('clean', [], 52), V.v10, []).verdict).toBe('rescuable');
    const partial = deriveRescue(nine, ten, result('rule-crash', ['one-left'], 52), V.v10, []);
    expect(partial.verdict).toBe('partial-rescue');
    expect(partial.residualRules!.map((r) => r.rule)).toEqual(['one-left']);
  });

  it('keeps rules already broken on ESLint 9 out of the residual set but still counts them', () => {
    // eslint-plugin-node is the live case: 12 rules crash on both versions and 8
    // more only on 10. The verdict is about the 8; the 12 still meet the reader.
    const nine = result('rule-crash', ['always-broken'], 10);
    const ten = result('rule-crash', ['always-broken', 'broke-in-ten'], 10);
    const wrapped = result('rule-crash', ['always-broken'], 10);
    const rescue = deriveRescue(nine, ten, wrapped, V.v10, ['broke-in-ten']);
    expect(rescue.verdict).toBe('rescuable');
    expect(rescue.crashingRulesAfter).toBe(0);
    expect(rescue.preexistingRulesAfter).toBe(1);

    const matrix: Matrix = {
      schemaVersion: 1,
      generatedAt: 'now',
      eslintVersions: V,
      plugins: [{ ...rowWith({ [V.v9]: nine, [V.v10]: ten }, rescue), name: 'eslint-plugin-node' }],
    };
    const report = buildReport(matrix, { plugins: ['eslint-plugin-node'], unknown: [], projectDir: '.', configPath: 'x' });
    expect(renderReport(report)).toContain('all recover wrapped in fixupPluginRules() (1 more crash on ESLint 9 too and still do)');
  });

  it('emits a valid matrix row for every rescue shape', () => {
    const matrix = (rescue: RescueResult) => ({
      schemaVersion: 1,
      generatedAt: '2026-08-27T00:00:00.000Z',
      eslintVersions: V,
      plugins: [rowWith({ [V.v9]: onNine, [V.v10]: onTen }, rescue)],
    });
    expect(validateMatrix(matrix(skippedRescue(V.v10, 'missing dependency: x')))).toEqual([]);
    expect(validateMatrix(matrix(deriveRescue(onNine, onTen, result('clean', [], 101), V.v10, broken)))).toEqual([]);
    const bad = matrix(skippedRescue(V.v10, 'x'));
    (bad.plugins[0]!.rescue as { verdict: string }).verdict = 'exploded';
    expect(validateMatrix(bad).join(' ')).toMatch(/rescue\.verdict invalid/);
  });
});

describe('rescue pass against real ESLint', () => {
  it('recovers a plugin whose only failures are removed context methods', async () => {
    const bare = await probeFixturePlugin('rescue-bare', 'removed-api-plugin.mjs', 'rescuable');
    const bareResult = classify(bare.probe, bare.stderr);
    expect(bareResult.status).toBe('rule-crash');
    expect(bareResult.crashingRules.map((r) => r.rule).sort()).toEqual(['uses-filename', 'uses-physical-filename']);

    const wrapped = await probeFixturePlugin('rescue-wrapped', 'removed-api-plugin.mjs', 'rescuable', { fixup: true });
    const wrappedResult = classify(wrapped.probe, wrapped.stderr);
    expect(wrappedResult.status).toBe('clean');
    expect(wrappedResult.fixupFunction).toBe('fixupPluginRules');

    const onNine = result('clean', [], 2);
    const eligibility = rescueEligibility(onNine, bareResult);
    expect(eligibility.kind).toBe('attempt');
    const rescue = deriveRescue(onNine, bareResult, wrappedResult, V.v10, bareResult.crashingRules.map((r) => r.rule));
    expect(rescue.verdict).toBe('rescuable');
  });

  it('reports a partial recovery with the exact residual rule', async () => {
    const wrapped = await probeFixturePlugin('rescue-partial', 'partial-rescue-plugin.mjs', 'partial', { fixup: true });
    const wrappedResult = classify(wrapped.probe, wrapped.stderr);
    expect(wrappedResult.status).toBe('rule-crash');
    expect(wrappedResult.crashingRules.map((r) => r.rule)).toEqual(['beyond-compat']);

    const onNine = result('clean', [], 2);
    const onTen = result('rule-crash', ['fixable-filename', 'beyond-compat'], 2);
    const rescue = deriveRescue(onNine, onTen, wrappedResult, V.v10, ['fixable-filename', 'beyond-compat']);
    expect(rescue.verdict).toBe('partial-rescue');
    expect(rescue.residualRules!.map((r) => r.rule)).toEqual(['beyond-compat']);
  });

  it('leaves a plugin the wrap cannot help as blocked', async () => {
    const wrapped = await probeFixturePlugin('rescue-unaffected', 'crashing-plugin.mjs', 'fixture', { fixup: true });
    const wrappedResult = classify(wrapped.probe, wrapped.stderr);
    expect(wrappedResult.status).toBe('rule-crash');

    const onNine = result('clean', [], 1);
    const onTen = classifyLike(wrappedResult);
    const rescue = deriveRescue(onNine, onTen, wrappedResult, V.v10, ['explodes-on-program']);
    expect(rescue.verdict).toBe('blocked');

    const report = buildReport(
      { schemaVersion: 1, generatedAt: 'now', eslintVersions: V, plugins: [{ ...rowWith({ [V.v9]: onNine, [V.v10]: onTen }, rescue), name: 'eslint-plugin-fixture' }] },
      { plugins: ['eslint-plugin-fixture'], unknown: [], projectDir: '.', configPath: 'eslint.config.js' }
    );
    expect(report.blocked).toHaveLength(1);
    expect(report.rescuable).toHaveLength(0);
    expect(report.blocked[0]!.snippet).toBeUndefined();
  });

  function classifyLike(wrapped: PluginRunResult): PluginRunResult {
    const { fixupFunction: _fixupFunction, ...bare } = wrapped;
    return bare;
  }
});

describe('report and snippet', () => {
  const onNine = result('clean', [], 101);
  const onTen = result('rule-crash', ['display-name', 'prop-types'], 101);

  it('buckets a rescued plugin under RESCUABLE with a snippet, not under BLOCKED', () => {
    const rescue: RescueResult = {
      eslintVersion: V.v10,
      compatVersion: '2.1.0',
      attempted: true,
      verdict: 'rescuable',
      fixupFunction: 'fixupPluginRules',
      crashingRulesBefore: 2,
      crashingRulesAfter: 0,
    };
    const matrix: Matrix = { schemaVersion: 1, generatedAt: 'now', eslintVersions: V, plugins: [rowWith({ [V.v9]: onNine, [V.v10]: onTen }, rescue)] };
    const report = buildReport(matrix, { plugins: ['eslint-plugin-react'], unknown: [], projectDir: '.', configPath: 'x' });
    expect(report.blocked).toHaveLength(0);
    expect(report.rescuable).toHaveLength(1);
    expect(report.rescuable[0]!.snippet).toContain('fixupPluginRules(react)');
    const text = renderReport(report);
    expect(text).toContain('RESCUABLE (1)');
    expect(text).toContain("import { fixupPluginRules } from '@eslint/compat';");
    expect(text).toContain('1 of 1 plugin block the upgrade to ESLint 10.9.0 (1 of them rescuable with @eslint/compat).');
  });

  it('renders PARTIAL-RESCUE with the rules the user must disable', () => {
    const rescue: RescueResult = {
      eslintVersion: V.v10,
      compatVersion: '2.1.0',
      attempted: true,
      verdict: 'partial-rescue',
      fixupFunction: 'fixupPluginRules',
      crashingRulesBefore: 2,
      crashingRulesAfter: 1,
      residualRules: [{ rule: 'prop-types', message: 'still broken' }],
    };
    const matrix: Matrix = { schemaVersion: 1, generatedAt: 'now', eslintVersions: V, plugins: [rowWith({ [V.v9]: onNine, [V.v10]: onTen }, rescue)] };
    const report = buildReport(matrix, { plugins: ['eslint-plugin-react'], unknown: [], projectDir: '.', configPath: 'x' });
    expect(report.partialRescue).toHaveLength(1);
    const text = renderReport(report);
    expect(text).toContain('PARTIAL-RESCUE (1)');
    expect(text).toContain("'react/prop-types': 'off',");
  });

  it('annotates a skipped rescue on the BLOCKED line instead of emitting a snippet', () => {
    const matrix: Matrix = {
      schemaVersion: 1,
      generatedAt: 'now',
      eslintVersions: V,
      plugins: [rowWith({ [V.v9]: onNine, [V.v10]: onTen }, skippedRescue(V.v10, 'missing dependency: x'))],
    };
    const report = buildReport(matrix, { plugins: ['eslint-plugin-react'], unknown: [], projectDir: '.', configPath: 'x' });
    expect(report.blocked).toHaveLength(1);
    expect(report.blocked[0]!.snippet).toBeUndefined();
    // The reason string stays exactly what v1.0.0 emitted so --json consumers do
    // not break; the skip travels in the rescue object and prints under the row.
    expect(report.blocked[0]!.reason).toBe('2 rules crash on 10.9.0: display-name, prop-types');
    expect(report.blocked[0]!.rescue!.skipReason).toBe('missing dependency: x');
    expect(renderReport(report)).toContain('@eslint/compat not attempted: missing dependency: x');
  });

  it('ignores a rescue field on a row that is not blocked, so a no-op wrap is never a rescue', () => {
    const row = rowWith({ [V.v9]: result('clean'), [V.v10]: result('clean') }, {
      eslintVersion: V.v10,
      compatVersion: '2.1.0',
      attempted: true,
      verdict: 'rescuable',
    });
    expect(verdictFor(row, V).verdict).toBe('force');
  });

  it('snapshots the fixupPluginRules snippet', () => {
    const rescue: RescueResult = {
      eslintVersion: V.v10,
      compatVersion: '2.1.0',
      attempted: true,
      verdict: 'partial-rescue',
      fixupFunction: 'fixupPluginRules',
      residualRules: [{ rule: 'display-name', message: 'x' }, { rule: 'prop-types', message: 'y' }],
    };
    expect(rescueSnippet({ name: 'eslint-plugin-react' }, rescue, '10.9.0')).toMatchInlineSnapshot(`
      "import { fixupPluginRules } from '@eslint/compat';
      import react from 'eslint-plugin-react';

      export default [
        // ...the rest of your config
        {
          plugins: { react: fixupPluginRules(react) },
          rules: {
            // still crash on ESLint 10.9.0 even wrapped; keep them off
            'react/display-name': 'off',
            'react/prop-types': 'off',
          },
        },
      ];
      "
    `);
  });

  it('snapshots the fixupConfigRules snippet', () => {
    const rescue: RescueResult = {
      eslintVersion: V.v10,
      compatVersion: '2.1.0',
      attempted: true,
      verdict: 'rescuable',
      fixupFunction: 'fixupConfigRules',
      fixupConfigKey: 'flat/recommended',
    };
    expect(rescueSnippet({ name: 'eslint-plugin-jsx-a11y' }, rescue, '10.9.0')).toMatchInlineSnapshot(`
      "import { fixupConfigRules } from '@eslint/compat';
      import jsxA11y from 'eslint-plugin-jsx-a11y';

      export default [
        // ...the rest of your config
        ...fixupConfigRules(jsxA11y.configs['flat/recommended']),
      ];
      "
    `);
  });

  it('derives sensible import bindings', () => {
    expect(importBinding('react')).toBe('react');
    expect(importBinding('jsx-a11y')).toBe('jsxA11y');
    expect(importBinding('@typescript-eslint')).toBe('typescriptEslint');
    expect(importBinding('@next/next')).toBe('nextNext');
  });
});

describe('end to end: the printed snippet unblocks a real repo on ESLint 10', () => {
  const CLI = join(REPO_ROOT, 'packages', 'cli', 'dist', 'index.js');
  const ESLINT_BIN = join(REPO_ROOT, 'node_modules', 'eslint', 'bin', 'eslint.js');

  function run(args: string[], cwd: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((resolvePromise) => {
      const child = spawn(process.execPath, args, { cwd, shell: false, env: { ...process.env, NO_COLOR: '1' } });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (c) => (stdout += c));
      child.stderr.on('data', (c) => (stderr += c));
      child.on('close', (code) => resolvePromise({ code, stdout, stderr }));
    });
  }

  it('crashes bare, then runs clean with the snippet pasted in', { timeout: 60_000 }, async () => {
    expect(existsSync(CLI), 'run `npm run build` before `npm test`').toBe(true);

    const dir = join(SANDBOX, 'e2e-rescue');
    await rm(dir, { recursive: true, force: true });
    await mkdir(join(dir, 'node_modules', 'eslint-plugin-rescuable'), { recursive: true });
    await writeFile(
      join(dir, 'node_modules', 'eslint-plugin-rescuable', 'package.json'),
      JSON.stringify({ name: 'eslint-plugin-rescuable', version: '1.0.0', type: 'module', main: 'index.mjs' })
    );
    await cp(join(PLUGINS, 'removed-api-plugin.mjs'), join(dir, 'node_modules', 'eslint-plugin-rescuable', 'index.mjs'));
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'e2e-app',
        version: '0.0.0',
        private: true,
        type: 'module',
        devDependencies: { eslint: '^10.9.0', '@eslint/compat': '^2.1.0', 'eslint-plugin-rescuable': '1.0.0' },
      })
    );
    await writeFile(join(dir, 'index.js'), 'export const answer = 42;\n');
    const enableRules =
      "{ files: ['**/*.js'], rules: { 'rescuable/uses-filename': 'error', 'rescuable/uses-physical-filename': 'error' } }";
    await writeFile(
      join(dir, 'eslint.config.js'),
      [
        "import rescuable from 'eslint-plugin-rescuable';",
        '',
        'export default [',
        '  { plugins: { rescuable } },',
        `  ${enableRules},`,
        '];',
        '',
      ].join('\n')
    );

    // Control: without the wrap the rules crash the run.
    const bare = await run([ESLINT_BIN, '.'], dir);
    expect(bare.code).toBe(2);
    expect(bare.stdout + bare.stderr).toMatch(/not a function/);

    // Build the matrix row from the real probe runs, exactly as the runner would.
    const bareProbe = await probeFixturePlugin('rescue-bare', 'removed-api-plugin.mjs', 'rescuable');
    const wrappedProbe = await probeFixturePlugin('rescue-wrapped', 'removed-api-plugin.mjs', 'rescuable', { fixup: true });
    const onTen = classify(bareProbe.probe, bareProbe.stderr);
    const wrapped = classify(wrappedProbe.probe, wrappedProbe.stderr);
    const onNine = result('clean', [], 2);
    const rescue = deriveRescue(onNine, onTen, wrapped, V.v10, onTen.crashingRules.map((r) => r.rule));
    expect(rescue.verdict).toBe('rescuable');

    const matrixPath = join(dir, 'matrix.json');
    await writeFile(
      matrixPath,
      JSON.stringify({
        schemaVersion: 1,
        generatedAt: '2026-08-27T00:00:00.000Z',
        eslintVersions: V,
        plugins: [
          {
            name: 'eslint-plugin-rescuable',
            version: '1.0.0',
            declaredPeerRange: '^9',
            weeklyDownloads: 1,
            results: { [V.v9]: onNine, [V.v10]: onTen },
            rescue,
          },
        ],
      })
    );

    const check = await run([CLI, 'check', dir, '--matrix', matrixPath, '--json', '--no-cache'], dir);
    expect(check.code).toBe(0);
    const json = JSON.parse(check.stdout) as { counts: Record<string, number>; rescuable: Array<{ snippet: string }> };
    expect(json.counts.rescuable).toBe(1);
    const snippet = json.rescuable[0]!.snippet;
    expect(snippet).toContain('fixupPluginRules');

    const ci = await run([CLI, 'check', dir, '--matrix', matrixPath, '--ci', '--no-cache'], dir);
    expect(ci.code).toBe(1);

    // The snippet is written verbatim; the repo's config composes it the way a
    // user pastes it in, then re-enables the same rules that crashed.
    await writeFile(join(dir, 'wrapped.config.js'), snippet);
    await writeFile(
      join(dir, 'eslint.config.js'),
      ["import base from './wrapped.config.js';", '', 'export default [', '  ...base,', `  ${enableRules},`, '];', ''].join('\n')
    );

    const rescued = await run([ESLINT_BIN, '.'], dir);
    expect(rescued.stdout + rescued.stderr).not.toMatch(/not a function/);
    expect(rescued.code, `eslint output:\n${rescued.stdout}\n${rescued.stderr}`).toBe(1);
    // Exit 1 is ordinary lint findings: the wrapped rule ran and reported.
    expect(rescued.stdout).toMatch(/physical filename inspected/);
  });
});
