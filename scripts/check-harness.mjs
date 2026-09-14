#!/usr/bin/env node
/**
 * Fails when the board carries rules the harness broke rather than the plugin.
 * Every finding names the edit that fixes it, so the nightly tells us to repair
 * the environment instead of quietly publishing a plugin as broken.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const [matrixFile = 'matrix.json'] = process.argv.slice(2);
const path = resolve(matrixFile);

let matrix;
try {
  matrix = JSON.parse(await readFile(path, 'utf8'));
} catch (err) {
  console.error(`harness: cannot read ${path}: ${err.message}`);
  process.exit(2);
}
if (matrix?.schemaVersion !== 1 || !Array.isArray(matrix.plugins)) {
  console.error(`harness: ${path} is not a v1 matrix`);
  process.exit(2);
}

/** One line per distinct cause, so four rules failing the same way read as one repair. */
function findings(row) {
  const byCause = new Map();
  for (const [version, result] of Object.entries(row.results ?? {})) {
    for (const rule of result?.harness?.rules ?? []) {
      const key = `${rule.cause}:${rule.subject}`;
      const seen = byCause.get(key) ?? { ...rule, rules: [], versions: new Set() };
      seen.rules.push(`${rule.rule} (${version})`);
      seen.versions.add(version);
      byCause.set(key, seen);
    }
  }
  return [...byCause.values()];
}

const broken = matrix.plugins
  .map((row) => ({ row, causes: findings(row) }))
  .filter(({ causes }) => causes.length > 0);

if (broken.length === 0) {
  console.log(`harness: ${matrix.plugins.length} plugins, none measured with a broken environment`);
  process.exit(0);
}

const ruleCount = broken.reduce((n, { causes }) => n + causes.reduce((m, c) => m + c.rules.length, 0), 0);
console.error(
  `harness: ${ruleCount} rule ${ruleCount === 1 ? 'measurement' : 'measurements'} across ` +
    `${broken.length} ${broken.length === 1 ? 'plugin' : 'plugins'} say more about this environment than about the plugin\n`
);
for (const { row, causes } of broken) {
  const status = Object.values(row.results ?? {}).some((r) => r?.status === 'harness-misconfig')
    ? 'not measured'
    : 'partially excluded';
  console.error(`  ${row.name}@${row.version ?? '?'}  (${status})`);
  for (const cause of causes) {
    console.error(`    ${cause.cause}: ${cause.detail}`);
    console.error(`    affects ${cause.rules.length}: ${cause.rules.slice(0, 4).join(', ')}${cause.rules.length > 4 ? ', …' : ''}`);
    console.error(`    fix: ${cause.fix}\n`);
  }
}
console.error('Repair the environment and re-run the nightly; do not publish these rows as plugin failures.');
process.exit(1);
