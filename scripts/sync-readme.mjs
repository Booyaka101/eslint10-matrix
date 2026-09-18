#!/usr/bin/env node
/**
 * The npm README is the repo README with its relative links made absolute:
 * npmjs.com has no `docs/` to resolve them against. Generated rather than
 * maintained because the hand-kept copy silently missed the whole 1.3.0 release.
 *
 * `--check` exits 1 when the copy is stale, which is how CI catches it.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RAW = 'https://raw.githubusercontent.com/Booyaka101/eslint10-matrix/main';
const TREE = 'https://github.com/Booyaka101/eslint10-matrix/tree/main';

export function absolutise(markdown) {
  return markdown
    .replace(/!\[([^\]]*)\]\((docs\/[^)]+)\)/g, (_, alt, path) => `![${alt}](${RAW}/${path})`)
    .replace(/\[([^\]]*)\]\((examples\/[^)]+)\)/g, (_, text, path) => `[${text}](${TREE}/${path})`);
}

const wanted = absolutise(readFileSync(join(ROOT, 'README.md'), 'utf8'));
const target = join(ROOT, 'packages', 'cli', 'README.md');
const current = readFileSync(target, 'utf8');

if (process.argv.includes('--check')) {
  if (current === wanted) {
    console.log('readme: packages/cli/README.md matches the repo README');
    process.exit(0);
  }
  console.error(
    'readme: packages/cli/README.md is out of date with README.md.\n' + '  Run: node scripts/sync-readme.mjs'
  );
  process.exit(1);
}

writeFileSync(target, wanted);
console.log(current === wanted ? 'readme: already in sync' : 'readme: rewrote packages/cli/README.md');
