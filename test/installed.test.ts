import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  hasNodeModules,
  readInstalled,
  readJsonFile,
  readLockfile,
  resolveInstalled,
  stripBom,
} from '../packages/cli/src/installed.js';
import { REPO_ROOT } from './probe-sandbox.js';

const SCAN_REPO = join(REPO_ROOT, 'test', 'fixtures', 'scan-repo');
const PLUGIN = 'eslint-plugin-fixture-lazy-import';

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'e10m-test-'));
}

describe('resolving what a repo actually has installed', () => {
  it('reads the installed version rather than the range or the lockfile', async () => {
    const lockfile = await readLockfile(SCAN_REPO);
    expect(lockfile?.versions.get(PLUGIN)).toBe('1.0.0');

    const installed = await resolveInstalled(PLUGIN, SCAN_REPO, lockfile);
    expect(installed).toMatchObject({
      name: PLUGIN,
      version: '1.2.3',
      source: 'node_modules',
      peerEslintRange: '>=8',
    });
    expect(installed?.optionalPeers.has('typescript')).toBe(true);
    expect(installed?.dir).toBe(join(SCAN_REPO, 'node_modules', PLUGIN));
  });

  it('falls back to the lockfile for a package that is not unpacked', async () => {
    const lockfile = await readLockfile(SCAN_REPO);
    const installed = await resolveInstalled('eslint-plugin-fixture-lockfile-only', SCAN_REPO, lockfile);
    expect(installed).toMatchObject({ version: '4.5.6', source: 'lockfile' });
    expect(installed?.dir).toBeUndefined();
  });

  it('reports a package in neither place as not installed', async () => {
    const lockfile = await readLockfile(SCAN_REPO);
    expect(await resolveInstalled('eslint-plugin-not-here', SCAN_REPO, lockfile)).toBeNull();
  });

  it('reads a manifest written with a byte order mark', async () => {
    const dir = await tempDir();
    const pkgDir = join(dir, 'node_modules', 'eslint-plugin-bom');
    await mkdir(pkgDir, { recursive: true });
    await writeFile(join(pkgDir, 'package.json'), '﻿{"name":"eslint-plugin-bom","version":"2.0.0"}');
    expect(await readInstalled('eslint-plugin-bom', dir)).toMatchObject({ version: '2.0.0' });
    expect(stripBom('﻿{}')).toBe('{}');
  });

  it('returns null for unreadable or malformed json instead of throwing', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'broken.json'), '{ not json');
    expect(await readJsonFile(join(dir, 'broken.json'))).toBeNull();
    expect(await readJsonFile(join(dir, 'absent.json'))).toBeNull();
  });

  it('knows when a repo has never been installed', async () => {
    const dir = await tempDir();
    expect(hasNodeModules(dir)).toBe(false);
    expect(hasNodeModules(SCAN_REPO)).toBe(true);
  });
});

describe('lockfile formats', () => {
  async function lockDir(name: string, body: string): Promise<string> {
    const dir = await tempDir();
    await writeFile(join(dir, name), body);
    return dir;
  }

  it('reads npm v1 nested dependencies', async () => {
    const dir = await lockDir(
      'package-lock.json',
      JSON.stringify({
        lockfileVersion: 1,
        dependencies: {
          'eslint-plugin-react': { version: '7.37.5', dependencies: { 'array-includes': { version: '3.1.8' } } },
        },
      })
    );
    const lock = await readLockfile(dir);
    expect(lock?.versions.get('eslint-plugin-react')).toBe('7.37.5');
    expect(lock?.versions.get('array-includes')).toBe('3.1.8');
  });

  it('reads npm v3 install paths and prefers the hoisted copy', async () => {
    const dir = await lockDir(
      'package-lock.json',
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          '': { name: 'app' },
          'node_modules/eslint-plugin-react': { version: '7.37.5' },
          'node_modules/@typescript-eslint/parser': { version: '8.67.0' },
          'node_modules/other/node_modules/eslint-plugin-react': { version: '7.30.0' },
        },
      })
    );
    const lock = await readLockfile(dir);
    expect(lock?.versions.get('eslint-plugin-react')).toBe('7.37.5');
    expect(lock?.versions.get('@typescript-eslint/parser')).toBe('8.67.0');
  });

  it('reads all three pnpm key shapes and strips peer suffixes', async () => {
    const dir = await lockDir(
      'pnpm-lock.yaml',
      [
        'lockfileVersion: 6.0',
        'packages:',
        '',
        '  /eslint-plugin-react/7.37.5:',
        '    resolution: {integrity: sha512-x}',
        '',
        '  /@typescript-eslint/parser@8.67.0(eslint@10.10.0):',
        '    resolution: {integrity: sha512-y}',
        '',
        '  eslint-plugin-promise@7.3.0:',
        '    resolution: {integrity: sha512-z}',
        '',
      ].join('\n')
    );
    const lock = await readLockfile(dir);
    expect(lock?.versions.get('eslint-plugin-react')).toBe('7.37.5');
    expect(lock?.versions.get('@typescript-eslint/parser')).toBe('8.67.0');
    expect(lock?.versions.get('eslint-plugin-promise')).toBe('7.3.0');
  });

  it('reads yarn classic and berry', async () => {
    const classic = await lockDir(
      'yarn.lock',
      ['"eslint-plugin-react@^7.37.0":', '  version "7.37.5"', '  resolved "https://registry.yarnpkg.com/x"', ''].join('\n')
    );
    expect((await readLockfile(classic))?.versions.get('eslint-plugin-react')).toBe('7.37.5');

    const berry = await lockDir(
      'yarn.lock',
      ['"eslint-plugin-promise@npm:^7.3.0":', '  version: 7.3.0', '  resolution: "eslint-plugin-promise@npm:7.3.0"', ''].join('\n')
    );
    expect((await readLockfile(berry))?.versions.get('eslint-plugin-promise')).toBe('7.3.0');
  });

  it('reports no lockfile rather than an empty one', async () => {
    expect(await readLockfile(await tempDir())).toBeNull();
  });
});
