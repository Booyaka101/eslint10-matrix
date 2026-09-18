#!/usr/bin/env node
/**
 * Diffs a freshly built board against the one already published and prints why
 * each row moved. A change nothing recorded can account for fails the job: the
 * board's whole claim is that a verdict is a measurement, and a verdict that
 * moved with no eslint, plugin or dependency version behind it is a measurement
 * we cannot reproduce.
 */
import { resolve } from 'node:path';
import { diffMatrices, renderDiff } from '../packages/cli/dist/diff.js';
import { DEFAULT_MATRIX_URL, loadMatrix, MatrixError } from '../packages/cli/dist/matrix.js';

const [matrixFile = 'matrix.json', publishedUrl = DEFAULT_MATRIX_URL] = process.argv.slice(2);
const path = resolve(matrixFile);

async function board(source) {
  try {
    const load = await loadMatrix({ url: source, noCache: true });
    return load.matrix;
  } catch (err) {
    const hint = err instanceof MatrixError && err.hint ? `\n  ${err.hint}` : '';
    return { error: `cannot read ${source}: ${err.message}${hint}` };
  }
}

const fresh = await board(path);
if (fresh.error) {
  console.error(`drift: ${fresh.error}`);
  process.exit(2);
}

// An unreachable published board is not drift, it is the absence of a baseline:
// nothing to compare against, so nothing this job can claim either way. Saying so
// and passing beats blocking a release on somebody else's CDN.
const published = await board(publishedUrl);
if (published.error) {
  console.error(`drift: ${published.error}`);
  console.log('drift: no published board to compare against, skipping the check');
  process.exit(0);
}

const result = diffMatrices(
  { matrix: published, source: publishedUrl },
  { matrix: fresh, source: path }
);

process.stdout.write(renderDiff(result));

const { changed, added, removed, unexplained } = result.counts;
const moved = changed + added + removed;

// renderDiff already names the dropped rows. This is the part only CI can say.
if (removed > 0) console.error('drift: check no shard failed before this board replaces the published one.');

if (unexplained === 0) {
  console.log(
    `drift: ${moved} ${moved === 1 ? 'change' : 'changes'}, no verdict moved without a recorded reason`
  );
  process.exit(0);
}

console.error(
  '\nA verdict moved without any recorded version moving with it. Re-run the shard before publishing:\n' +
    '  node packages/runner/dist/run.js --only <plugin> --out /tmp/recheck.json\n' +
    'and compare again. Publishing this board would state a change we cannot reproduce.'
);
process.exit(1);
