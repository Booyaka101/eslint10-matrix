import { spawn } from 'node:child_process';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { classify } from '../packages/runner/src/classify.js';
import type { ProbeResult } from '../packages/runner/src/types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const PROBE = join(REPO_ROOT, 'packages', 'runner', 'probe', 'probe.mjs');
const FIXTURES = join(REPO_ROOT, 'packages', 'runner', 'fixtures');
const PLUGINS = join(HERE, 'fixtures', 'plugins');

// Kept inside the repo so the probe's bare `import('eslint')` resolves against
// the workspace node_modules, exactly as it resolves against a temp install in production.
const SANDBOX = join(REPO_ROOT, 'test', '.tmp');

function runNode(cwd: string): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, ['probe.mjs'], { cwd, shell: false });
    let stderr = '';
    child.stderr.on('data', (c) => {
      stderr += c;
    });
    child.on('close', (code) => resolvePromise({ code, stderr }));
  });
}

async function probeFixturePlugin(
  caseName: string,
  pluginFile: string,
  namespace: string
): Promise<{ probe: ProbeResult | null; stderr: string }> {
  const dir = join(SANDBOX, caseName);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'probe-case', private: true, type: 'module' }));
  await cp(PROBE, join(dir, 'probe.mjs'));
  await cp(FIXTURES, join(dir, 'fixtures'), { recursive: true });
  await writeFile(
    join(dir, 'probe-input.json'),
    JSON.stringify({
      specifier: pathToFileURL(join(PLUGINS, pluginFile)).href,
      namespace,
      settings: null,
      parserSpecifier: null,
      fixturesDir: 'fixtures',
    })
  );

  const { stderr } = await runNode(dir);
  let probe: ProbeResult | null;
  try {
    probe = JSON.parse(await readFile(join(dir, 'probe-result.json'), 'utf8')) as ProbeResult;
  } catch {
    probe = null;
  }
  return { probe, stderr };
}

describe('probe + classify against real ESLint', () => {
  beforeAll(async () => {
    await mkdir(SANDBOX, { recursive: true });
  });

  afterAll(async () => {
    await rm(SANDBOX, { recursive: true, force: true });
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
