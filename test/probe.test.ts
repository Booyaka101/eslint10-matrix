import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { classify } from '../packages/cli/src/classify.js';
import { probeFixturePlugin, REPO_ROOT, SANDBOX } from './probe-sandbox.js';

describe('probe + classify against real ESLint', () => {
  beforeAll(async () => {
    await mkdir(SANDBOX, { recursive: true });
  });

  // Only this file's case dirs: rescue.test.ts shares the sandbox root and the
  // two files run in parallel workers.
  afterAll(async () => {
    for (const dir of ['crashing', 'reporting', 'import-throws']) {
      await rm(`${SANDBOX}/${dir}`, { recursive: true, force: true });
    }
  });

  it('classifies a rule that throws as rule-crash and names the rule', async () => {
    const { probe, stderr } = await probeFixturePlugin('crashing', 'crashing-plugin.mjs', 'fixture');
    expect(probe, 'probe should still produce a result when a rule throws').not.toBeNull();

    const result = classify(probe, stderr);
    expect(result.status).toBe('rule-crash');
    expect(result.crashingRules.map((r) => r.rule)).toContain('explodes-on-program');
    expect(result.crashingRules[0]!.message).toMatch(/getSourceCodeThatNoLongerExists is not a function/);
  });

  it('classifies a plugin that reports on every file as clean, not as a crash', async () => {
    const { probe, stderr } = await probeFixturePlugin('reporting', 'reporting-plugin.mjs', 'fixture');
    expect(probe).not.toBeNull();
    expect(probe!.totalRules).toBe(2);
    // The point of the assertion: it produced a lot of lint output and is still clean.
    expect(probe!.totalMessages).toBeGreaterThan(100);

    const result = classify(probe, stderr);
    expect(result.status).toBe('clean');
    expect(result.crashingRules).toEqual([]);
  });

  it('classifies a plugin that throws at import time as load-fail', async () => {
    const { probe, stderr } = await probeFixturePlugin('import-throws', 'import-throws-plugin.mjs', 'fixture');
    expect(probe).not.toBeNull();
    expect(probe!.phase).toBe('load');

    const result = classify(probe, stderr);
    expect(result.status).toBe('load-fail');
    expect(result.detail).toMatch(/removed-in-10/);
    expect(result.crashingRules).toEqual([]);
  });
});

describe('the attribution budget', () => {
  const literal = (expr: string): number =>
    expr.split('*').reduce((total, part) => total * Number(part.replace(/_/g, '').trim()), 1);

  it('is one deadline for the whole process, and stays under the timeout that kills it', async () => {
    // A rescue probe measures two wrapped candidates in one process. A budget
    // per measure() call, or one above the kill, means the probe is SIGKILLed
    // with no result file and the plugin reads as a load failure.
    const probeSource = await readFile(join(REPO_ROOT, 'packages', 'cli', 'probe', 'probe.mjs'), 'utf8');
    const runSource = await readFile(join(REPO_ROOT, 'packages', 'cli', 'src', 'probe-run.ts'), 'utf8');
    expect(probeSource).toMatch(/^const DEADLINE = Date[.]now[(][)] [+] ATTRIBUTE_BUDGET_MS;$/m);
    const budget = /ATTRIBUTE_BUDGET_MS = ([\d *_]+);/.exec(probeSource)?.[1];
    const kill = /PROBE_TIMEOUT_MS = ([\d *_]+);/.exec(runSource)?.[1];
    expect(budget).toBeDefined();
    expect(kill).toBeDefined();
    expect(literal(budget!)).toBeLessThan(literal(kill!));
  });
});
