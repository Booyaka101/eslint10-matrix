import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { loadMatrix, MatrixError, type Matrix } from '../packages/cli/src/matrix.js';

const exec = promisify(execFile);

function board(generatedAt: string, names: string[]): Matrix {
  return {
    schemaVersion: 1,
    generatedAt,
    eslintVersions: { v9: '9.39.5', v10: '10.10.0' },
    plugins: names.map((name) => ({
      name,
      version: '1.0.0',
      declaredPeerRange: '^9',
      weeklyDownloads: 1,
      results: {},
    })),
  } as Matrix;
}

/**
 * `git show` reads relative to wherever it is run, so the repository has to be the
 * working directory. Vitest gives each test file its own process, so this cannot
 * reach another file's tests.
 */
const WAS = process.cwd();
let repo: string;

beforeAll(async () => {
  repo = await mkdtemp(join(tmpdir(), 'e10m-git-'));
  const git = (...args: string[]) => exec('git', args, { cwd: repo });
  await git('init', '-q');
  await git('config', 'user.email', 'test@example.com');
  await git('config', 'user.name', 'test');
  await writeFile(join(repo, 'matrix.json'), JSON.stringify(board('2026-09-01T00:00:00.000Z', ['eslint-plugin-jest'])));
  await git('add', 'matrix.json');
  await git('commit', '-qm', 'first board');
  await writeFile(
    join(repo, 'matrix.json'),
    JSON.stringify(board('2026-09-08T00:00:00.000Z', ['eslint-plugin-jest', 'eslint-plugin-vue']))
  );
  await git('commit', '-qam', 'second board');
});

afterEach(() => process.chdir(WAS));

describe('a board addressed as a git revision', () => {
  it('reads the board out of history rather than off disk', async () => {
    process.chdir(repo);
    const load = await loadMatrix({ url: 'HEAD~1:matrix.json' });

    expect(load.source).toBe('git');
    expect(load.matrix.generatedAt).toBe('2026-09-01T00:00:00.000Z');
    expect(load.matrix.plugins).toHaveLength(1);
  });

  it('still reads the working copy when no revision is named', async () => {
    process.chdir(repo);
    const load = await loadMatrix({ url: 'matrix.json' });

    expect(load.source).toBe('file');
    expect(load.matrix.plugins).toHaveLength(2);
  });

  it('names the revision it could not read, and where git looked', async () => {
    process.chdir(repo);
    const err = await loadMatrix({ url: 'v9.9.9:matrix.json' }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MatrixError);
    expect((err as MatrixError).message).toContain('git could not read v9.9.9:matrix.json');
    expect((err as MatrixError).hint).toContain('relative to the repository root');
  });

  /**
   * `git show --output=some:file` writes a file. The CLI's own parser would take
   * that for a flag long before here, but loadMatrix is called from the scripts too.
   */
  it('does not hand git anything shaped like an option', async () => {
    process.chdir(repo);
    const err = await loadMatrix({ url: '--output=written:matrix.json' }).catch((e: unknown) => e);

    expect((err as MatrixError).message).toContain('matrix file not found');
    expect(existsSync(join(repo, 'written:matrix.json'))).toBe(false);
  });

  it('names a path that revision does not have', async () => {
    process.chdir(repo);
    const err = await loadMatrix({ url: 'HEAD:nope.json' }).catch((e: unknown) => e);

    expect((err as MatrixError).message).toContain('git could not read HEAD:nope.json');
  });

  /**
   * Only reachable where a filename may hold a colon, which rules out Windows. The
   * guard exists so a directory with one in its name is not read as a revision.
   */
  it.skipIf(process.platform === 'win32')('prefers a file that is really there', async () => {
    const odd = join(repo, 'boards:2026', 'matrix.json');
    await mkdir(join(repo, 'boards:2026'), { recursive: true });
    await writeFile(odd, JSON.stringify(board('2026-09-30T00:00:00.000Z', ['eslint-plugin-n'])));

    const load = await loadMatrix({ url: odd });
    expect(load.source).toBe('file');
    expect(load.matrix.generatedAt).toBe('2026-09-30T00:00:00.000Z');
  });
});
