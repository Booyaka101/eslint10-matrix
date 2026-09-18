import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { diffBlocks, diffMatrices, renderDiff, type DiffResult } from '../packages/cli/src/diff.js';
import { main } from '../packages/cli/src/index.js';
import { cacheDir, cachePath, type Matrix, type MeasuredEnv, type PluginRunResult, type Status } from '../packages/cli/src/matrix.js';

const V9 = '9.39.5';
const V10 = '10.10.0';

function env(deps: Record<string, string | null>): MeasuredEnv {
  return { node: '22.18.0', npm: '11.6.2', deps };
}

function result(status: Status, measuredWith?: MeasuredEnv): PluginRunResult {
  return {
    status,
    crashingRules: status === 'rule-crash' ? [{ rule: 'no-setup-in-describe', message: 'boom' }] : [],
    totalRules: 12,
    ...(measuredWith ? { measuredWith } : {}),
  };
}

interface RowInput {
  name?: string;
  version?: string | null;
  nine?: PluginRunResult;
  ten?: PluginRunResult;
  rescue?: 'rescuable' | 'partial-rescue' | 'blocked';
}

function board(rows: RowInput[], versions: { v9: string; v10: string } = { v9: V9, v10: V10 }): Matrix {
  return {
    schemaVersion: 1,
    generatedAt: '2026-09-17T03:31:19.232Z',
    eslintVersions: versions,
    plugins: rows.map((row) => ({
      name: row.name ?? 'eslint-plugin-vue',
      version: row.version === undefined ? '10.6.0' : row.version,
      declaredPeerRange: '^9.0.0 || ^10.0.0',
      weeklyDownloads: 1_000_000,
      results: {
        [versions.v9]: row.nine ?? result('clean'),
        [versions.v10]: row.ten ?? result('clean'),
      },
      ...(row.rescue
        ? {
            rescue: {
              eslintVersion: versions.v10,
              compatVersion: '2.1.1',
              attempted: true,
              verdict: row.rescue,
            },
          }
        : {}),
    })),
  };
}

function diff(before: Matrix, after: Matrix): DiffResult {
  return diffMatrices({ matrix: before, source: 'before.json' }, { matrix: after, source: 'after.json' });
}

/** The board of the brief's worked example, with the parser version as the variable. */
function vueBoards(parserBefore: string, parserAfter: string): [Matrix, Matrix] {
  return [
    board([{ ten: result('clean', env({ eslint: V10, 'vue-eslint-parser': parserBefore })) }]),
    board([{ ten: result('rule-crash', env({ eslint: V10, 'vue-eslint-parser': parserAfter })) }]),
  ];
}

describe('attributing a changed row', () => {
  it('blames the eslint version when the boards were built against different releases', () => {
    const before = board([{ ten: result('clean', env({ eslint: V10 })) }]);
    const after = board([{ ten: result('rule-crash', env({ eslint: '10.11.0' })) }], {
      v9: V9,
      v10: '10.11.0',
    });
    const [change] = diff(before, after).changes;
    expect(change?.cause).toBe('eslint');
    expect(change?.causeDetail).toBe('eslint 10.10.0 -> 10.11.0');
  });

  it('blames the plugin version next', () => {
    const before = board([{ version: '10.6.0', ten: result('clean', env({ eslint: V10 })) }]);
    const after = board([{ version: '10.7.0', ten: result('rule-crash', env({ eslint: V10 })) }]);
    const [change] = diff(before, after).changes;
    expect(change?.cause).toBe('plugin');
    expect(change?.causeDetail).toBe('eslint-plugin-vue 10.6.0 -> 10.7.0');
  });

  /** A null version is a failed registry lookup, and two of them are not a change. */
  it('never blames the plugin version when the board did not record one', () => {
    const before = board([{ version: null, ten: result('clean', env({ eslint: V10 })) }]);
    const after = board([{ version: null, ten: result('rule-crash', env({ eslint: V10 })) }]);
    expect(diff(before, after).changes[0]?.cause).toBe('unexplained');
  });

  it('blames an installed dependency, naming it and both versions', () => {
    const [before, after] = vueBoards('10.2.0', '10.3.0');
    const rendered = renderDiff(diff(before, after));
    expect(rendered).toContain('eslint-plugin-vue  clean -> rule-crash on 10.10.0');
    expect(rendered).toContain('  env: vue-eslint-parser 10.2.0 -> 10.3.0');
    expect(diff(before, after).changes[0]?.envChanges).toEqual([
      { package: 'vue-eslint-parser', before: '10.2.0', after: '10.3.0' },
    ]);
  });

  it('says so plainly when nothing recorded moved', () => {
    const [before, after] = vueBoards('10.2.0', '10.2.0');
    const rendered = renderDiff(diff(before, after));
    expect(rendered).toContain('eslint-plugin-vue  clean -> rule-crash on 10.10.0');
    expect(rendered).toContain('  unexplained: no recorded version changed');
    expect(diff(before, after).counts.unexplained).toBe(1);
  });

  /**
   * Every board published before 1.4.0 is this case. Calling it unexplained
   * would make a diff against the live board read as an alarm on every row.
   */
  it('calls a board with no recorded environment unknown-env, not unexplained', () => {
    const before = board([{ ten: result('clean') }]);
    const after = board([{ ten: result('rule-crash', env({ eslint: V10 })) }]);
    const changed = diff(before, after);
    expect(changed.changes[0]?.cause).toBe('unknown-env');
    expect(changed.counts.unexplained).toBe(0);
    expect(renderDiff(changed)).toContain('recorded no environment');
  });

  it('reports a moved rescue verdict even when both statuses held', () => {
    const before = board([{ ten: result('rule-crash', env({ eslint: V10 })), rescue: 'blocked' }]);
    const after = board([{ ten: result('rule-crash', env({ eslint: V10 })), rescue: 'rescuable' }]);
    const [change] = diff(before, after).changes;
    expect(change?.statuses).toEqual([]);
    expect(change?.rescue).toEqual({ before: 'blocked', after: 'rescuable' });
    expect(renderDiff(diff(before, after))).toContain('rescue blocked -> rescuable');
  });

  it('reports added and removed rows', () => {
    const before = board([{ name: 'eslint-plugin-gone' }]);
    const after = board([{ name: 'eslint-plugin-new' }]);
    const changed = diff(before, after);
    expect(changed.changes.map((c) => [c.name, c.kind])).toEqual([
      ['eslint-plugin-gone', 'removed'],
      ['eslint-plugin-new', 'added'],
    ]);
    expect(changed.counts).toMatchObject({ added: 1, removed: 1, changed: 0 });
  });

  it('is silent on two identical boards', () => {
    const [before] = vueBoards('10.2.0', '10.2.0');
    const changed = diff(before, before);
    expect(changed.changes).toEqual([]);
    expect(renderDiff(changed)).toContain('No row changed status or rescue verdict.');
  });

  /**
   * Each major installs separately, so a row's two environments differ in eslint
   * by construction. That is not drift, and must not be reported against a board
   * whose own eslint versions held.
   */
  it('does not invent an env change out of the per-major eslint difference', () => {
    const rows: RowInput[] = [
      {
        nine: result('clean', env({ eslint: V9, 'vue-eslint-parser': '10.2.0' })),
        ten: result('clean', env({ eslint: V10, 'vue-eslint-parser': '10.2.0' })),
      },
    ];
    expect(diff(board(rows), board(rows)).changes).toEqual([]);
  });

  it('attributes a change seen only on eslint 9', () => {
    const before = board([{ nine: result('clean', env({ eslint: V9, jest: '30.5.0' })) }]);
    const after = board([{ nine: result('rule-crash', env({ eslint: V9, jest: '30.5.1' })) }]);
    const [change] = diff(before, after).changes;
    expect(change?.statuses).toEqual([{ eslintVersion: V9, before: 'clean', after: 'rule-crash' }]);
    expect(change?.cause).toBe('env');
    expect(change?.causeDetail).toBe('jest 30.5.0 -> 30.5.1');
  });

  /**
   * An install that left no node_modules records no environment, which is normal
   * and must not cost the other major its attribution.
   */
  it('still attributes a change on one major when the other recorded nothing', () => {
    const before = board([
      { nine: result('install-fail'), ten: result('clean', env({ eslint: V10, jest: '30.5.0' })) },
    ]);
    const after = board([
      { nine: result('install-fail'), ten: result('rule-crash', env({ eslint: V10, jest: '30.5.1' })) },
    ]);
    expect(diff(before, after).changes[0]?.cause).toBe('env');
  });

  /** What happened around ESLint 9 does not explain a row that moved on ESLint 10. */
  it('does not borrow an env change from a major that held', () => {
    const before = board([
      {
        nine: result('clean', env({ eslint: V9, jest: '30.5.0' })),
        ten: result('clean', env({ eslint: V10, jest: '30.5.0' })),
      },
    ]);
    const after = board([
      {
        nine: result('clean', env({ eslint: V9, jest: '30.5.1' })),
        ten: result('rule-crash', env({ eslint: V10, jest: '30.5.0' })),
      },
    ]);
    expect(diff(before, after).changes[0]?.cause).toBe('unexplained');
  });

  /**
   * A row the before board never measured on this major has no environment to
   * have changed, which is the same position as a pre-1.4.0 board. Calling it
   * unexplained would fail the nightly the first time a plugin joins the board.
   */
  it('calls a major the before board never measured unknown-env, not unexplained', () => {
    const before = board([{ ten: result('clean', env({ eslint: V10 })) }]);
    delete before.plugins[0].results[V10];
    const after = board([{ ten: result('rule-crash', env({ eslint: V10 })) }]);

    const [change] = diff(before, after).changes;
    expect(change.statuses).toEqual([{ eslintVersion: V10, before: 'untested', after: 'rule-crash' }]);
    expect(change.cause).toBe('unknown-env');
    expect(diffBlocks(diff(before, after))).toBe(false);
  });

  it('names a dependency that stopped installing', () => {
    const before = board([{ ten: result('clean', env({ eslint: V10, jest: '30.5.1' })) }]);
    const after = board([{ ten: result('load-fail', env({ eslint: V10, jest: null })) }]);
    expect(diff(before, after).changes[0]?.causeDetail).toBe('jest 30.5.1 -> (missing)');
  });
});

describe('the diff command', () => {
  async function boardFile(matrix: Matrix): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'e10m-diff-'));
    const path = join(dir, 'matrix.json');
    await writeFile(path, JSON.stringify(matrix));
    return path;
  }

  async function runDiff(before: Matrix, after: Matrix, flags: string[] = []): Promise<{ code: number; out: string }> {
    const [a, b] = await Promise.all([boardFile(before), boardFile(after)]);
    let out = '';
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      out += String(chunk);
      return true;
    });
    const log = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      out += `${args.join(' ')}\n`;
    });
    try {
      return { code: await main(['diff', a, b, '--no-color', ...flags]), out };
    } finally {
      write.mockRestore();
      log.mockRestore();
    }
  }

  it('exits 0 when a board is diffed against itself', async () => {
    const [before] = vueBoards('10.2.0', '10.2.0');
    const { code, out } = await runDiff(before, before, ['--ci']);
    expect(code).toBe(0);
    expect(out).toContain('No row changed status or rescue verdict.');
  });

  it('exits 1 under --ci on a change with no recorded cause', async () => {
    const [before, after] = vueBoards('10.2.0', '10.2.0');
    const { code, out } = await runDiff(before, after, ['--ci']);
    expect(code).toBe(1);
    expect(out).toContain('unexplained: no recorded version changed');
  });

  it('exits 0 on the same change without --ci', async () => {
    const [before, after] = vueBoards('10.2.0', '10.2.0');
    expect((await runDiff(before, after)).code).toBe(0);
  });

  it('exits 0 under --ci on a change the boards explain', async () => {
    const [before, after] = vueBoards('10.2.0', '10.3.0');
    expect((await runDiff(before, after, ['--ci'])).code).toBe(0);
  });

  it('exits 1 under --ci on a removed row', async () => {
    const { code } = await runDiff(board([{ name: 'eslint-plugin-gone' }]), board([]), ['--ci']);
    expect(code).toBe(1);
  });

  it('exits 0 under --ci on an added row', async () => {
    const { code } = await runDiff(board([]), board([{ name: 'eslint-plugin-new' }]), ['--ci']);
    expect(code).toBe(0);
  });

  it('prints the whole result as json', async () => {
    const [before, after] = vueBoards('10.2.0', '10.3.0');
    const { out } = await runDiff(before, after, ['--json']);
    const parsed = JSON.parse(out) as DiffResult;
    expect(parsed.counts).toMatchObject({ changed: 1, env: 1, unexplained: 0 });
    expect(parsed.changes[0]?.envChanges).toEqual([
      { package: 'vue-eslint-parser', before: '10.2.0', after: '10.3.0' },
    ]);
    expect(parsed.before.eslintVersions).toEqual({ v9: V9, v10: V10 });
  });

  it('exits 2 with a usage error when given one board', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await main(['diff', 'only-one.json'])).toBe(2);
      expect(error.mock.calls.flat().join('\n')).toContain('diff needs two boards');
    } finally {
      error.mockRestore();
    }
  });

  it('exits 2 with a readable message when a board is missing', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await main(['diff', 'no-such-board.json', 'nor-this.json'])).toBe(2);
      expect(error.mock.calls.flat().join('\n')).toContain('matrix file not found');
    } finally {
      error.mockRestore();
    }
  });

  /**
   * The cached board is whatever `check` last fetched. Falling back to it here
   * would diff a board nobody asked for and label it with the URL that failed,
   * so an unreachable board has to be an error even with a warm cache.
   */
  it('does not fall back to the cached board when a URL cannot be fetched', async () => {
    const previous = process.env.XDG_CACHE_HOME;
    const home = await mkdtemp(join(tmpdir(), 'e10m-diff-cache-'));
    process.env.XDG_CACHE_HOME = home;
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await mkdir(cacheDir(), { recursive: true });
      await writeFile(cachePath(), JSON.stringify(board([{ name: 'eslint-plugin-cached' }])));

      const local = await boardFile(board([{ name: 'eslint-plugin-local' }]));
      // Port 1 refuses immediately, so this never waits on a real network.
      const code = await main(['diff', 'http://127.0.0.1:1/matrix.json', local, '--no-color']);

      expect(code).toBe(2);
      const said = error.mock.calls.flat().join('\n');
      expect(said).toContain('could not fetch the matrix from http://127.0.0.1:1/matrix.json');
      expect(said).not.toContain('cached copy');
    } finally {
      error.mockRestore();
      if (previous === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = previous;
    }
  });
});
