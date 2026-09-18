import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { envKey, envsDir, measureEnvironment, probe, specName } from '../packages/cli/src/probe-run.js';

async function tempDir(prefix = 'e10m-measured-'): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

/** A node_modules the way npm leaves one, with a manifest per installed package. */
async function fakeInstall(dir: string, packages: Record<string, string>): Promise<void> {
  for (const [name, version] of Object.entries(packages)) {
    const pkgDir = join(dir, 'node_modules', ...name.split('/'));
    await mkdir(pkgDir, { recursive: true });
    await writeFile(join(pkgDir, 'package.json'), JSON.stringify({ name, version }));
  }
}

describe('specName', () => {
  it('takes the range off a plain name', () => {
    expect(specName('typescript@^6')).toBe('typescript');
    expect(specName('eslint@10.10.0')).toBe('eslint');
  });

  it('leaves a scoped name with no range alone', () => {
    expect(specName('@typescript-eslint/parser')).toBe('@typescript-eslint/parser');
  });

  it('takes the range off a scoped name', () => {
    expect(specName('@typescript-eslint/parser@^8.70.0')).toBe('@typescript-eslint/parser');
  });

  it('survives a range containing spaces or alternatives', () => {
    expect(specName('typescript@>=4.8.4 <6.1.0')).toBe('typescript');
    expect(specName('eslint@^8.57.0 || ^9.0.0 || ^10.0.0')).toBe('eslint');
  });
});

describe('measureEnvironment', () => {
  it('reads the resolved version of every dep out of node_modules', async () => {
    const dir = await tempDir();
    await fakeInstall(dir, {
      eslint: '10.10.0',
      jest: '30.5.1',
      '@typescript-eslint/parser': '8.70.0',
    });

    const env = await measureEnvironment(dir, ['eslint@10.10.0', 'jest@^30.0.0', '@typescript-eslint/parser']);
    expect(env.deps).toEqual({
      eslint: '10.10.0',
      jest: '30.5.1',
      '@typescript-eslint/parser': '8.70.0',
    });
    expect(env.node).toBe(process.versions.node);
    expect(env.npm === null || /^\d+\.\d+\.\d+/.test(env.npm)).toBe(true);
  });

  /** "We asked for it and it is not there" is the case worth publishing. */
  it('records a dep that did not install as null rather than dropping it', async () => {
    const dir = await tempDir();
    await fakeInstall(dir, { eslint: '10.10.0' });
    const env = await measureEnvironment(dir, ['eslint@10.10.0', 'eslint-plugin-absent@^1']);
    expect(env.deps).toEqual({ eslint: '10.10.0', 'eslint-plugin-absent': null });
  });

  it('records an unreadable manifest as null too', async () => {
    const dir = await tempDir();
    await mkdir(join(dir, 'node_modules', 'eslint-plugin-broken'), { recursive: true });
    await writeFile(join(dir, 'node_modules', 'eslint-plugin-broken', 'package.json'), '{ not json');
    expect((await measureEnvironment(dir, ['eslint-plugin-broken'])).deps).toEqual({
      'eslint-plugin-broken': null,
    });
  });

  it('resolves a duplicated name once, taking the last spec', async () => {
    const dir = await tempDir();
    await fakeInstall(dir, { eslint: '9.39.5' });
    const env = await measureEnvironment(dir, ['eslint@9.39.5', 'eslint@10.10.0']);
    expect(Object.keys(env.deps)).toEqual(['eslint']);
  });

  /**
   * The probe environment sits under ~/.cache/eslint10-matrix/envs, so a reader
   * that walked upwards could report a package from an enclosing install that
   * this run never had.
   */
  it('does not walk up out of the environment', async () => {
    const parent = await tempDir();
    await fakeInstall(parent, { eslint: '9.39.5' });
    const child = join(parent, 'env');
    await mkdir(child, { recursive: true });
    expect((await measureEnvironment(child, ['eslint@10.10.0'])).deps).toEqual({ eslint: null });
  });
});

describe('probe attaches the environment it measured in', () => {
  const previousCacheHome = process.env.XDG_CACHE_HOME;
  let cacheHome: string;

  beforeEach(async () => {
    cacheHome = await tempDir('e10m-cache-');
    process.env.XDG_CACHE_HOME = cacheHome;
  });

  afterEach(() => {
    if (previousCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = previousCacheHome;
  });

  /**
   * A cache hit installs nothing, and the environment it hands back can be a
   * fortnight old, so this is exactly the case where the specs are not evidence
   * of what ran.
   */
  it('measures a reused environment rather than trusting its specs', async () => {
    const deps = ['eslint@10.10.0', 'eslint-plugin-nothing@^1.0.0'];
    const dir = join(envsDir(), envKey(deps));
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'probe-env', private: true, type: 'module' }));
    // The versions on disk deliberately disagree with the specs above.
    await fakeInstall(dir, { eslint: '10.9.0', 'eslint-plugin-nothing': '1.4.2' });

    const result = await probe(
      { deps, specifier: 'eslint-plugin-nothing', namespace: 'nothing', files: [] },
      { cache: true }
    );

    expect(result.measuredWith?.deps).toEqual({ eslint: '10.9.0', 'eslint-plugin-nothing': '1.4.2' });
    expect(result.measuredWith?.node).toBe(process.versions.node);
  });

  /** An empty object would claim a measurement; absence says there was none. */
  it('leaves measuredWith off when nothing was installed', async () => {
    const result = await probe(
      { deps: ['eslint@$(boom)'], specifier: 'eslint-plugin-nothing', namespace: 'nothing', files: [] },
      { cache: false }
    );
    expect(result.status).toBe('install-fail');
    expect(result.measuredWith).toBeUndefined();
    expect('measuredWith' in result).toBe(false);
  });
});
