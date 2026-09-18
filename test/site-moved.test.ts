import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Matrix } from '../packages/cli/src/matrix.js';
import { FIXTURES, ROOT, runNode } from './run-script.js';
import type { Run } from './run-script.js';

const BEFORE = join(FIXTURES, 'drift-before.json');
const AFTER = join(FIXTURES, 'drift-after.json');

/** Builds the page the way the nightly does and hands back what a reader would see. */
async function build(input: string, since?: string): Promise<Run & { html: string }> {
  const out = await mkdtemp(join(tmpdir(), 'e10m-site-'));
  const run = await runNode(join(ROOT, 'site', 'build.mjs'), [
    '--in',
    input,
    '--out',
    out,
    ...(since ? ['--since', since] : []),
  ]);
  return { ...run, html: await readFile(join(out, 'index.html'), 'utf8') };
}

/** The panel only, so an assertion cannot pass on text from the table below it. */
function panel(html: string): string {
  return /<(details|p) class="moved[\s\S]*?<\/\1>/.exec(html)?.[0] ?? '';
}

const HOSTILE = 'eslint-plugin-<script>alert(1)</script>';

/** A board, edited, as a file the builder can be pointed at. */
async function boardFile(edit: (matrix: Matrix) => void, source = AFTER): Promise<string> {
  const matrix = JSON.parse(await readFile(source, 'utf8')) as Matrix;
  edit(matrix);
  const path = join(await mkdtemp(join(tmpdir(), 'e10m-board-')), 'matrix.json');
  await writeFile(path, JSON.stringify(matrix));
  return path;
}

describe('the "what moved" panel on the site', () => {
  /**
   * The board carries a verdict per row and no history at all, so a reader who
   * checked it last week cannot tell which of these verdicts is new.
   */
  it('names each changed row, where it moved to, and why', async () => {
    const { html } = await build(AFTER, BEFORE);
    const moved = panel(html);
    expect(moved).toContain('eslint-plugin-jest');
    expect(moved).toContain('clean &rarr; rule crash on 10.10.0');
    expect(moved).toContain('a dependency moved: jest 30.5.1 -&gt; 31.0.0');
  });

  it('says out loud when a row moved with nothing recorded behind it', async () => {
    expect(panel((await build(AFTER, BEFORE)).html)).toContain('nothing recorded moved');
  });

  it('counts the changes in the summary line', async () => {
    expect(panel((await build(AFTER, BEFORE)).html)).toContain('2 changed');
  });

  /** Quiet nights are the normal case, and silence would read as a broken panel. */
  it('says so plainly when nothing moved', async () => {
    const moved = panel((await build(AFTER, AFTER)).html);
    expect(moved).toContain('Nothing moved since the board published');
    expect(moved).not.toContain('<li');
  });

  it('calls out a row that left the board', async () => {
    const shorter = await boardFile((matrix) => {
      matrix.plugins = matrix.plugins.filter((row) => row.name === 'eslint-plugin-jest');
    });
    expect(panel((await build(shorter, BEFORE)).html)).toContain('no longer measured');
  });

  /** A build with no baseline is the normal local one. An empty panel would be noise. */
  it('renders no panel at all without a baseline', async () => {
    const { html, code } = await build(AFTER);
    expect(code).toBe(0);
    expect(panel(html)).toBe('');
    expect(html).toContain('<table>');
  });

  /**
   * The nightly fetches the baseline over the network, and a CDN hiccup must
   * cost the panel, not the deploy.
   */
  it('still publishes the board when the baseline cannot be read', async () => {
    const { html, code, out } = await build(AFTER, join(FIXTURES, 'no-such-board.json'));
    expect(code).toBe(0);
    expect(out).toContain('no "what moved" panel');
    expect(panel(html)).toBe('');
    expect(html).toContain('<table>');
  });

  /**
   * Every string in the panel comes off a board, and a board is a JSON file
   * fetched over the network. A changed row interpolates the most of them.
   */
  it('escapes a changed row, name and recorded versions alike', async () => {
    const rename = (matrix: Matrix) => {
      const row = matrix.plugins.find((p) => p.name === 'eslint-plugin-jest')!;
      row.name = HOSTILE;
      for (const result of Object.values(row.results)) {
        if (result.measuredWith) result.measuredWith.deps = { [HOSTILE]: '1.0.0' };
      }
    };
    const before = await boardFile(rename, BEFORE);
    const after = await boardFile(rename);
    const moved = panel((await build(after, before)).html);
    expect(moved).toContain('&lt;script&gt;');
    expect(moved).not.toContain('<script>');
  });

  /** And the branch that prints a row which only exists on one of the boards. */
  it('escapes an added row too', async () => {
    const hostile = await boardFile((matrix) => {
      matrix.plugins[0]!.name = HOSTILE;
    });
    const moved = panel((await build(hostile, BEFORE)).html);
    expect(moved).toContain('&lt;script&gt;');
    expect(moved).not.toContain('<script>');
  });
});
