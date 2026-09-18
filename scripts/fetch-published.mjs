#!/usr/bin/env node
/**
 * Saves the board currently published, so the drift guard has something to diff
 * against after this run replaces it. Run before the deploy, or the guard ends up
 * comparing the fresh board with itself.
 *
 * A board it cannot fetch is not an error: no baseline is not drift, and a CDN
 * hiccup must not fail a nightly. It writes nothing and the guard skips.
 */
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DEFAULT_MATRIX_URL, loadMatrix, MatrixError } from '../packages/cli/dist/matrix.js';

const [outArg = 'published-matrix.json', source = DEFAULT_MATRIX_URL] = process.argv.slice(2);
const out = resolve(outArg);

try {
  const { matrix } = await loadMatrix({ url: source, noCache: true });
  await writeFile(out, JSON.stringify(matrix));
  console.log(`published: saved ${matrix.plugins.length} rows from ${source} to ${out}`);
} catch (err) {
  const hint = err instanceof MatrixError && err.hint ? `\n  ${err.hint}` : '';
  console.error(`published: could not read ${source}: ${err.message}${hint}`);
  console.log('published: no baseline saved, the drift guard will skip this run');
}
