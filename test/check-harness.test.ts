import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const run = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GUARD = join(ROOT, 'scripts', 'check-harness.mjs');
const FIXTURES = join(ROOT, 'test', 'fixtures');

/**
 * The guard is a CI job, so it is tested the way CI runs it: as a process, on
 * its exit code and its real output. Every board here is a captured one.
 */
async function guard(board: string): Promise<{ code: number; out: string }> {
  try {
    const { stdout, stderr } = await run(process.execPath, [GUARD, board]);
    return { code: 0, out: stdout + stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? -1, out: (e.stdout ?? '') + (e.stderr ?? '') };
  }
}

describe('the nightly harness guard', () => {
  /**
   * A captured board rather than the repo's own `matrix.json`: the nightly
   * rewrites that file, so asserting on it here would make `npm test` fail for
   * whatever last night's run measured. The live board is the `harness-guard`
   * job's business, and that job is where a real one gets caught.
   */
  it('passes a board nothing is wrong with', async () => {
    const { code, out } = await guard(join(FIXTURES, 'matrix-measured.json'));
    expect(code).toBe(0);
    expect(out).toContain('none measured with a broken environment');
  });

  /**
   * Both of these rows are real: vue's parser rejects 2 of the 6 shared
   * fixtures, and svelte reads only the one file it brought. Partial is normal
   * and must stay quiet, or the guard cries wolf every night.
   */
  it('stays quiet on rows where some fixtures parsed and some did not', async () => {
    const { code, out } = await guard(join(FIXTURES, 'matrix-measured.json'));
    expect(code).toBe(0);
    expect(out).not.toContain('eslint-plugin-vue');
    expect(out).not.toContain('eslint-plugin-svelte');
  });

  it('fails a board carrying harness rules, naming the edit for each', async () => {
    const { code, out } = await guard(join(FIXTURES, 'matrix-harness.json'));
    expect(code).toBe(1);
    expect(out).toContain('add "jest" to extraDeps for eslint-plugin-jest in packages/runner/src/plugins.json');
    expect(out).toContain('@typescript-eslint/eslint-plugin likely needs a non-espree "parser"');
    expect(out).toContain('(not measured)');
  });

  /**
   * eslint-plugin-svelte as the runner really measures it: svelte-eslint-parser
   * reads none of the six JavaScript and TypeScript fixtures, so the row is
   * published CLEAN on a run in which no rule ever saw a line of code. The
   * status is left alone deliberately; the guard is what says so.
   */
  it('fails a row whose fixtures never parsed, even though it reads clean', async () => {
    const { code, out } = await guard(join(FIXTURES, 'matrix-unparsed.json'));
    expect(code).toBe(1);
    expect(out).toContain('measured on nothing');
    expect(out).toContain('none of the 6 fixture files parsed');
    expect(out).toContain('without the rules having seen any code');
    // The fix names the literal edit, as every other harness finding does.
    expect(out).toContain('"corpusExtensions" for eslint-plugin-svelte in packages/runner/src/plugins.json');
  });

  it('does not report the same corpus twice when the CLI already attributed it', async () => {
    const { out } = await guard(join(FIXTURES, 'matrix-harness.json'));
    expect(out.match(/corpus-unparsed/g)).toBeNull();
  });

  it('exits 2 on a file it cannot read', async () => {
    const { code, out } = await guard(join(FIXTURES, 'no-such-board.json'));
    expect(code).toBe(2);
    expect(out).toContain('cannot read');
  });

  it('exits 2 on something that is not a v1 matrix', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'harness-guard-'));
    const board = join(dir, 'matrix.json');
    await writeFile(board, JSON.stringify({ schemaVersion: 2, plugins: [] }));
    const { code, out } = await guard(board);
    expect(code).toBe(2);
    expect(out).toContain('is not a v1 matrix');
  });
});
