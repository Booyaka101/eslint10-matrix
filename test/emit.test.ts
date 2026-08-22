import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildMatrix, validateMatrix, writeMatrix } from '../packages/runner/src/emit.js';
import { classify, ruleIdFromError } from '../packages/runner/src/classify.js';
import { namespaceFor, type PluginRow } from '../packages/runner/src/types.js';

const ROWS: PluginRow[] = [
  {
    name: 'eslint-plugin-small',
    version: '1.0.0',
    declaredPeerRange: '^9',
    weeklyDownloads: 10,
    results: { '10.9.0': { status: 'clean', crashingRules: [], totalRules: 3 } },
  },
  {
    name: 'eslint-plugin-big',
    version: '2.0.0',
    declaredPeerRange: null,
    weeklyDownloads: 999,
    results: { '10.9.0': { status: 'rule-crash', crashingRules: [{ rule: 'a', message: 'boom' }], totalRules: 3 } },
  },
];

describe('namespaceFor', () => {
  it('follows the ESLint plugin naming convention', () => {
    expect(namespaceFor('eslint-plugin-react')).toBe('react');
    expect(namespaceFor('@typescript-eslint/eslint-plugin')).toBe('@typescript-eslint');
    expect(namespaceFor('@next/eslint-plugin-next')).toBe('@next/next');
    expect(namespaceFor('@ternaus/eslint-plugin-react')).toBe('@ternaus/react');
  });
});

describe('emit', () => {
  it('orders rows by weekly downloads', () => {
    const matrix = buildMatrix({ v9: '9.39.5', v10: '10.9.0' }, ROWS, '2026-08-22T00:00:00.000Z');
    expect(matrix.plugins.map((p) => p.name)).toEqual(['eslint-plugin-big', 'eslint-plugin-small']);
    expect(validateMatrix(matrix)).toEqual([]);
  });

  it('catches every kind of malformed matrix', () => {
    expect(validateMatrix(null)).toContain('matrix is not an object');
    expect(validateMatrix({ ...buildMatrix({ v9: '9', v10: '10' }, ROWS, 'nope') })).toContain(
      'generatedAt must be an ISO timestamp'
    );
    // buildMatrix copies the array, not the rows, so clone before corrupting one.
    const bad = buildMatrix({ v9: '9.39.5', v10: '10.9.0' }, structuredClone(ROWS), '2026-08-22T00:00:00.000Z');
    (bad.plugins[0]!.results['10.9.0'] as { status: string }).status = 'exploded';
    expect(validateMatrix(bad).join(' ')).toMatch(/status invalid: exploded/);
  });

  it('refuses to write an invalid matrix', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'e10m-emit-'));
    try {
      const matrix = buildMatrix({ v9: '9.39.5', v10: '10.9.0' }, ROWS, '2026-08-22T00:00:00.000Z');
      matrix.schemaVersion = 7;
      await expect(writeMatrix(join(dir, 'm.json'), matrix)).rejects.toThrow(/refusing to write an invalid matrix/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('round-trips a valid matrix through disk', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'e10m-emit2-'));
    try {
      const file = join(dir, 'matrix.json');
      const matrix = buildMatrix({ v9: '9.39.5', v10: '10.9.0' }, ROWS, '2026-08-22T00:00:00.000Z');
      await writeMatrix(file, matrix);
      expect(validateMatrix(JSON.parse(await readFile(file, 'utf8')))).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('classify edge cases', () => {
  it('pulls a rule id out of an ESLint rule-loading error', () => {
    expect(ruleIdFromError("Error while loading rule 'react/display-name': x is not a function")).toBe(
      'react/display-name'
    );
  });

  it('treats install failure as its own status, not a crash', () => {
    const probe = null;
    const result = classify(probe, 'npm ERR! code ERESOLVE');
    expect(result.status).toBe('load-fail');
    expect(result.crashingRules).toEqual([]);
  });

  it('records a crash when only stderr survives the child process', () => {
    const stderr = "TypeError: Error while loading rule 'react/display-name': contextOrFilename.getFilename is not a function";
    const result = classify(null, stderr);
    expect(result.status).toBe('rule-crash');
    expect(result.crashingRules[0]!.rule).toBe('display-name');
  });

  it('never lets ordinary lint volume become a crash', () => {
    const result = classify({
      phase: 'done',
      ok: true,
      totalRules: 40,
      crashingRules: [],
      totalMessages: 9999,
      lintedFiles: 6,
    });
    expect(result.status).toBe('clean');
  });
});
