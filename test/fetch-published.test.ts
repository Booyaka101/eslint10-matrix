import { mkdtemp, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Matrix } from '../packages/cli/src/matrix.js';
import { FIXTURES, runScript } from './run-script.js';

const PUBLISHED = join(FIXTURES, 'drift-before.json');
/** Port 1 refuses immediately, so no test here waits on a real network. */
const DEAD = 'http://127.0.0.1:1/matrix.json';

async function out(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'e10m-published-'));
  return join(dir, 'published-matrix.json');
}

describe('capturing the board a nightly is about to replace', () => {
  it('saves the published board where the drift guard will look for it', async () => {
    const path = await out();
    const { code, out: said } = await runScript('fetch-published.mjs', [path, PUBLISHED]);

    expect(code).toBe(0);
    expect(said).toContain('published: saved 2 rows');
    const saved = JSON.parse(await readFile(path, 'utf8')) as Matrix;
    expect(saved.plugins.map((row) => row.name)).toEqual(
      (JSON.parse(await readFile(PUBLISHED, 'utf8')) as Matrix).plugins.map((row) => row.name)
    );
  });

  /**
   * A CDN hiccup at capture time must not fail the nightly. It writes nothing and
   * the guard downstream reads that absence as "no baseline" rather than as drift.
   */
  it('writes nothing and still passes when the board cannot be fetched', async () => {
    const path = await out();
    const { code, out: said } = await runScript('fetch-published.mjs', [path, DEAD]);

    expect(code).toBe(0);
    expect(said).toContain(`published: could not read ${DEAD}`);
    expect(said).toContain('the drift guard will skip this run');
    expect(existsSync(path)).toBe(false);
  });

  it('leaves the drift guard something it treats as no baseline', async () => {
    const path = await out();
    await runScript('fetch-published.mjs', [path, DEAD]);

    const { code, out: said } = await runScript('check-drift.mjs', [PUBLISHED, path]);
    expect(code).toBe(0);
    expect(said).toContain('no published board to compare against');
  });
});
