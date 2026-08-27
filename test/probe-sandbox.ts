import { spawn } from 'node:child_process';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { ProbeResult } from '../packages/runner/src/types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '..');
const PROBE = join(REPO_ROOT, 'packages', 'runner', 'probe', 'probe.mjs');
const FIXTURES = join(REPO_ROOT, 'packages', 'runner', 'fixtures');
export const PLUGINS = join(HERE, 'fixtures', 'plugins');

// Kept inside the repo so the probe's bare `import('eslint')` resolves against
// the workspace node_modules, exactly as it resolves against a temp install in production.
export const SANDBOX = join(REPO_ROOT, 'test', '.tmp');

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

export async function probeFixturePlugin(
  caseName: string,
  pluginFile: string,
  namespace: string,
  options: { fixup?: boolean } = {}
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
      fixup: options.fixup ?? false,
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
