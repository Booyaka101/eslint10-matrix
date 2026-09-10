import { spawn } from 'node:child_process';
import { cp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { ProbeResult } from '../packages/cli/src/classify.js';
import { corpusFiles, CORPUS_DIR } from '../packages/runner/src/corpus.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '..');
const PROBE = join(REPO_ROOT, 'packages', 'cli', 'probe', 'probe.mjs');
export const PLUGINS = join(HERE, 'fixtures', 'plugins');

/** The 9.x line, installed under an alias so both majors are testable offline. */
export const ESLINT_9 = join(REPO_ROOT, 'node_modules', 'eslint9');

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

export interface SandboxOptions {
  fixup?: boolean;
  recordFiles?: boolean;
  /** Linked in as the case's own eslint. Defaults to whatever the workspace has. */
  eslintDir?: string;
  /** Where `files` are relative to. Defaults to the corpus copied into the case. */
  cwd?: string;
  files?: string[];
}

/**
 * A package directory is copied into the case's node_modules so that the
 * plugin's own bare imports resolve there too; a bare file name is imported
 * from test/fixtures/plugins by URL, as the single-file fixtures always were.
 */
async function installPlugin(dir: string, plugin: string): Promise<string> {
  if (!isAbsolute(plugin)) return pathToFileURL(join(PLUGINS, plugin)).href;
  const manifest = JSON.parse(await readFile(join(plugin, 'package.json'), 'utf8')) as { name: string };
  await cp(plugin, join(dir, 'node_modules', ...manifest.name.split('/')), { recursive: true });
  return manifest.name;
}

export async function probeFixturePlugin(
  caseName: string,
  plugin: string,
  namespace: string,
  options: SandboxOptions = {}
): Promise<{ probe: ProbeResult | null; stderr: string }> {
  const dir = join(SANDBOX, caseName);
  await rm(dir, { recursive: true, force: true });
  await mkdir(join(dir, 'node_modules'), { recursive: true });
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'probe-case', private: true, type: 'module' }));
  await cp(PROBE, join(dir, 'probe.mjs'));
  if (options.eslintDir) await symlink(options.eslintDir, join(dir, 'node_modules', 'eslint'), 'junction');
  const specifier = await installPlugin(dir, plugin);
  if (!options.files) await cp(CORPUS_DIR, join(dir, 'fixtures'), { recursive: true });

  await writeFile(
    join(dir, 'probe-input.json'),
    JSON.stringify({
      specifier,
      namespace,
      settings: null,
      parserSpecifier: null,
      cwd: options.cwd ?? dir,
      files: options.files ?? (await corpusFiles()),
      recordFiles: options.recordFiles ?? false,
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
