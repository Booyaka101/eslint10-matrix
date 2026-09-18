import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FIXTURES, runScript } from './run-script.js';

/**
 * Chrome that starts and immediately exits. Node rejects `--headless=new` and is
 * gone within milliseconds, which is what a missing shared library or a killed
 * browser looks like to this script.
 */
const DEAD_CHROME = process.execPath;

const PROFILES = 'e10m-shot-';

async function shotProfiles(): Promise<string[]> {
  return (await readdir(tmpdir())).filter((name) => name.startsWith(PROFILES));
}

describe('site-shot when Chrome does not come up', () => {
  const run = () =>
    runScript('site-shot.mjs', [
      '--in',
      join(FIXTURES, 'no-such-page.html'),
      '--out',
      join(tmpdir(), 'e10m-shot-never-written.png'),
      '--clip',
      'table',
      '--chrome',
      DEAD_CHROME,
    ]);

  /**
   * The wait for the browser to exit used to be unconditional, and a child that
   * has already exited never emits `exit` again. The await never settled, node
   * bailed with "unsettled top-level await", and the real reason was never
   * printed: a failing screenshot said nothing about Chrome at all.
   */
  it('says Chrome exited, and exits non-zero rather than stranding the await', async () => {
    const { code, out } = await run();
    expect(out).toContain('chrome exited');
    expect(out).not.toContain('unsettled top-level await');
    expect(code).toBe(1);
  });

  /** The profile is tens of megabytes, and a failing run used to leave one behind. */
  it('takes its temporary profile with it', async () => {
    const before = await shotProfiles();
    await run();
    expect((await shotProfiles()).filter((name) => !before.includes(name))).toEqual([]);
  });

  it('refuses to start without something to clip', async () => {
    const { code, out } = await runScript('site-shot.mjs', ['--in', 'x.html', '--out', 'y.png']);
    expect(code).not.toBe(0);
    expect(out).toContain('usage: site-shot.mjs');
  });
});
