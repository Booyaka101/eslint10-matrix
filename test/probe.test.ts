import { mkdir, rm } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { classify } from '../packages/runner/src/classify.js';
import { probeFixturePlugin, SANDBOX } from './probe-sandbox.js';

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
