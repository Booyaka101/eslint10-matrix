import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { buildIgnorer, collectFiles, globToRegExp } from '../packages/cli/src/collect-files.js';
import { REPO_ROOT } from './probe-sandbox.js';

const SCAN_REPO = join(REPO_ROOT, 'test', 'fixtures', 'scan-repo');

describe('flat config ignore globs', () => {
  const matches = (pattern: string, path: string): boolean => globToRegExp(pattern).test(path);

  it('matches the shapes real configs use', () => {
    expect(matches('**/*.js', 'index.js')).toBe(true);
    expect(matches('**/*.js', 'src/deep/index.js')).toBe(true);
    expect(matches('**/*.js', 'src/index.jsx')).toBe(false);
    expect(matches('src/*.js', 'src/index.js')).toBe(true);
    expect(matches('src/*.js', 'src/deep/index.js')).toBe(false);
    expect(matches('*.config.?s', 'eslint.config.js')).toBe(true);
    expect(matches('**/*.{spec,test}.ts', 'src/a.spec.ts')).toBe(true);
    expect(matches('**/*.{spec,test}.ts', 'src/a.ts')).toBe(false);
    expect(matches('src/[!_]*.js', 'src/a.js')).toBe(true);
    expect(matches('src/[!_]*.js', 'src/_a.js')).toBe(false);
  });

  it('treats a directory name as everything under it', () => {
    expect(matches('dist', 'dist')).toBe(true);
    expect(matches('dist', 'dist/main.js')).toBe(true);
    expect(matches('dist/', 'dist/nested/main.js')).toBe(true);
    expect(matches('dist', 'distant/main.js')).toBe(false);
  });

  it('escapes regex punctuation in a literal segment', () => {
    expect(matches('vendor+lib/a.js', 'vendor+lib/a.js')).toBe(true);
    expect(matches('a.js', 'axjs')).toBe(false);
    expect(() => globToRegExp('src/[unterminated')).not.toThrow();
  });

  it('lets a later negation win, which is how a subtree is unignored', () => {
    const ignorer = buildIgnorer(['dist/**', '!dist/keep.js']);
    expect(ignorer.ignores('dist/main.js')).toBe(true);
    expect(ignorer.ignores('dist/keep.js')).toBe(false);
    expect(buildIgnorer([]).ignores('anything.js')).toBe(false);
  });
});

describe('collecting the repo\'s own files', () => {
  it('walks the repo, honours the config ignores and skips node_modules', async () => {
    const collected = await collectFiles(SCAN_REPO, { ignores: ['build/**'] });
    expect(collected.files).toEqual([
      'eslint.config.js',
      join('src', 'Card.jsx'),
      join('src', 'routes.js'),
      join('src', 'util.js'),
    ]);
    expect(collected.skipped).toBe(0);
  });

  it('caps the list and says how many were left out', async () => {
    const collected = await collectFiles(SCAN_REPO, { ignores: ['build/**'], max: 2 });
    expect(collected.files).toEqual(['eslint.config.js', join('src', 'Card.jsx')]);
    expect(collected.skipped).toBe(2);
  });

  it('filters by extension', async () => {
    const collected = await collectFiles(SCAN_REPO, { ignores: ['build/**'], extensions: ['.jsx'] });
    expect(collected.files).toEqual([join('src', 'Card.jsx')]);
  });

  it('returns nothing for a directory that does not exist', async () => {
    expect(await collectFiles(join(SCAN_REPO, 'no-such-dir'))).toEqual({ files: [], skipped: 0 });
  });
});
