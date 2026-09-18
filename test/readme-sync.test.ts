import { describe, expect, it } from 'vitest';
import { runScript } from './run-script.js';

describe('the npm README', () => {
  /**
   * It is generated from the repo README with the relative links made absolute.
   * The hand-kept copy silently missed the whole 1.3.0 release, and npmjs.com
   * served the stale one until somebody noticed.
   */
  it('is in sync with the repo README', async () => {
    const { code, out } = await runScript('sync-readme.mjs', ['--check']);
    expect(out.trim()).toBe('readme: packages/cli/README.md matches the repo README');
    expect(code).toBe(0);
  });
});
