import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { main } from '../packages/cli/src/index.js';

interface Attempt {
  code: number;
  stderr: string;
  stdout: string;
}

async function runCli(argv: string[]): Promise<Attempt> {
  let stderr = '';
  let stdout = '';
  const err = vi.spyOn(console, 'error').mockImplementation((...args) => {
    stderr += `${args.join(' ')}\n`;
  });
  const out = vi.spyOn(console, 'log').mockImplementation((...args) => {
    stdout += `${args.join(' ')}\n`;
  });
  try {
    return { code: await main(argv), stderr, stdout };
  } finally {
    err.mockRestore();
    out.mockRestore();
  }
}

async function repo(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'e10m-scan-'));
  for (const [name, body] of Object.entries(files)) {
    const path = join(dir, name);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, body);
  }
  return dir;
}

const FLAT_CONFIG = 'export default [];\n';
const MANIFEST = JSON.stringify({ name: 'guard-fixture', private: true, type: 'module' });

describe('scan refuses to guess', () => {
  it('exits non-zero when the repo has never been installed', async () => {
    const dir = await repo({ 'package.json': MANIFEST, 'eslint.config.js': FLAT_CONFIG });
    const attempt = await runCli(['scan', dir]);
    expect(attempt.code).toBe(2);
    expect(attempt.stderr).toContain('no node_modules');
    expect(attempt.stderr).toContain('will not fall back to whatever npm publishes as latest');
    expect(attempt.stderr).not.toContain('at ');
  });

  it('names the missing install rather than the config import that failed because of it', async () => {
    const dir = await repo({
      'package.json': MANIFEST,
      'eslint.config.js': "import react from 'eslint-plugin-react';\nexport default [{ plugins: { react } }];\n",
    });
    const attempt = await runCli(['scan', dir]);
    expect(attempt.code).toBe(2);
    expect(attempt.stderr).toContain('no node_modules');
    expect(attempt.stderr).not.toContain('could not import');
  });

  it('takes --plugins past a config it cannot read', async () => {
    const dir = await repo({
      'package.json': MANIFEST,
      'eslint.config.js': 'export default () => [];\n',
    });
    const attempt = await runCli(['scan', dir, '--plugins', 'eslint-plugin-react']);
    expect(attempt.code).toBe(2);
    expect(attempt.stderr).toContain('no node_modules');
    expect(attempt.stderr).not.toContain('default-exports a function');
  });

  it('still needs an install when --plugins names the plugins and there is no config', async () => {
    const dir = await repo({ 'package.json': MANIFEST });
    const attempt = await runCli(['scan', dir, '--plugins', 'eslint-plugin-react']);
    expect(attempt.code).toBe(2);
    expect(attempt.stderr).toContain('no node_modules');
    expect(attempt.stderr).not.toContain('no ESLint flat config found');
  });

  it('tells an eslintrc repo that ESLint 10 removed eslintrc', async () => {
    const dir = await repo({ 'package.json': MANIFEST, '.eslintrc.json': '{ "extends": "eslint:recommended" }' });
    const attempt = await runCli(['scan', dir]);
    expect(attempt.code).toBe(2);
    expect(attempt.stderr).toContain('legacy eslintrc config');
    expect(attempt.stderr).toContain('@eslint/migrate-config');
  });

  it('says so when every file is ignored', async () => {
    const dir = await repo({
      'package.json': MANIFEST,
      'eslint.config.js': 'export default [{ ignores: ["**/*"] }];\n',
      'node_modules/.keep': '',
    });
    const attempt = await runCli(['scan', dir]);
    expect(attempt.code).toBe(2);
    expect(attempt.stderr).toContain('found no JavaScript or TypeScript files');
  });

  it('names the directory in the workspace note, not the --plugins placeholder', async () => {
    const dir = await repo({
      'package.json': JSON.stringify({ name: 'monorepo', private: true, workspaces: ['packages/*'] }),
      'src/index.js': 'export const x = 1;\n',
      'node_modules/.keep': '',
    });
    const attempt = await runCli(['scan', dir, '--plugins', 'eslint-plugin-react', '--json']);
    expect(attempt.code).toBe(0);
    const notes = (JSON.parse(attempt.stdout) as { notes: string[] }).notes;
    expect(notes).toContain(
      `${dir} is a workspace root (packages/*); scan measures the config here only and does not walk into the packages`
    );
    expect(notes).toContain('eslint-plugin-react is used by the config but has no installed version here, so it was not scanned');
  });

  it('rejects nonsense flag values before doing any work', async () => {
    expect((await runCli(['scan', '--max-files', '0'])).code).toBe(2);
    expect((await runCli(['scan', '--concurrency', 'many'])).code).toBe(2);
    expect((await runCli(['fly'])).code).toBe(2);
  });
});
