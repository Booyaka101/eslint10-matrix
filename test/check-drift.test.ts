import { mkdtemp, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Matrix } from '../packages/cli/src/matrix.js';
import { FIXTURES, runScript } from './run-script.js';

const BEFORE = join(FIXTURES, 'drift-before.json');
const AFTER = join(FIXTURES, 'drift-after.json');

/**
 * Always given both boards. The published one defaults to a URL, and a guard
 * test that reaches the network is a test that fails on a train.
 */
const guard = (fresh: string, published = BEFORE) => runScript('check-drift.mjs', [fresh, published]);

/** The fresh board, edited, as a file the guard can be pointed at. */
async function boardFile(edit: (matrix: Matrix) => void): Promise<string> {
  const matrix = JSON.parse(readFileSync(AFTER, 'utf8')) as Matrix;
  edit(matrix);
  const dir = await mkdtemp(join(tmpdir(), 'drift-guard-'));
  const path = join(dir, 'matrix.json');
  await writeFile(path, JSON.stringify(matrix));
  return path;
}

describe('the nightly drift guard', () => {
  it('passes a board that did not move', async () => {
    const { code, out } = await guard(BEFORE);
    expect(code).toBe(0);
    expect(out).toContain('No row changed status or rescue verdict.');
  });

  /**
   * Both rows moved, one with a dependency that moved under it. The guard is
   * about whether a change can be accounted for, not about whether it happened.
   */
  it('prints every change with its cause', async () => {
    const { out } = await guard(AFTER);
    expect(out).toContain('eslint-plugin-jest     clean -> rule-crash on 10.10.0');
    expect(out).toContain('env: jest 30.5.1 -> 31.0.0');
    expect(out).toContain('unexplained: no recorded version changed');
  });

  it('fails a board whose verdict moved with nothing behind it', async () => {
    const { code, out } = await guard(AFTER);
    expect(code).toBe(1);
    expect(out).toContain('Re-run the shard before publishing');
    expect(out).toContain('--only <plugin>');
  });

  it('passes when every change has a version behind it', async () => {
    const explained = await boardFile((matrix) => {
      matrix.plugins = matrix.plugins.filter((row) => row.name === 'eslint-plugin-jest');
    });
    const { code, out } = await guard(explained);
    expect(code).toBe(0);
    expect(out).toContain('no verdict moved without a recorded reason');
  });

  /**
   * A shard that died leaves exactly this shape, and a maintainer reading
   * "nothing unexplained" deserves to be told the board also got shorter.
   */
  it('says out loud when rows left the board', async () => {
    const shorter = await boardFile((matrix) => {
      matrix.plugins = matrix.plugins.filter((row) => row.name === 'eslint-plugin-jest');
    });
    expect((await guard(shorter)).out).toContain('on the published board and not in this one');
  });

  it('exits 2 on a board it cannot read', async () => {
    const { code, out } = await guard(join(FIXTURES, 'no-such-board.json'));
    expect(code).toBe(2);
    expect(out).toContain('cannot read');
  });

  /**
   * The guard gates the nightly deploy, so a CDN hiccup on the published board
   * must not read as drift. There is simply no baseline to compare against.
   */
  it('passes, loudly, when the published board cannot be fetched', async () => {
    const { code, out } = await guard(AFTER, join(FIXTURES, 'no-such-board.json'));
    expect(code).toBe(0);
    expect(out).toContain('no published board to compare against');
  });

  it('exits 2 on something that is not a v1 matrix', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'drift-guard-'));
    const board = join(dir, 'matrix.json');
    await writeFile(board, JSON.stringify({ schemaVersion: 2, plugins: [] }));
    const { code, out } = await guard(board);
    expect(code).toBe(2);
    expect(out).toContain('unsupported matrix schemaVersion: 2');
  });
});
