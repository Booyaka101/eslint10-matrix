#!/usr/bin/env node
/**
 * Fails when the board carries rules the harness broke rather than the plugin,
 * or a row whose fixtures never parsed at all. Every finding names the edit that
 * fixes it, so the nightly tells us to repair the environment instead of quietly
 * publishing a verdict we did not measure.
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
function record(byCause, finding, label, version) {
  const key = `${finding.cause}:${finding.subject}`;
  const seen = byCause.get(key) ?? { ...finding, rules: [], versions: new Set() };
  seen.rules.push(label);
  seen.versions.add(version);
  byCause.set(key, seen);
}

/**
 * A row where every fixture failed to parse, whatever status it ended on. The
 * CLI only ever voids a run that also crashed, because a status is a published
 * verdict and rewriting one on this evidence is the maintainer's call, not the
 * tool's. A green row measured on no code at all is still not a measurement,
 * and telling us so is this guard's whole job.
 */
function unparsed(version, result, plugin) {
  const files = result?.lintedFiles ?? 0;
  const errors = result?.parseErrors ?? 0;
  if (files === 0 || errors < files) return null;
  return {
    cause: 'corpus-unparsed',
    subject: 'packages/runner/fixtures',
    detail:
      `none of the ${files} fixture ${files === 1 ? 'file' : 'files'} parsed on eslint ${version}, ` +
      `so this row reports "${result.status}" without the rules having seen any code`,
    fix:
      `add a fixture this parser can read to packages/runner/fixtures and list its extension under ` +
      `"corpusExtensions" for ${plugin} in packages/runner/src/plugins.json, or drop the plugin`,
  };
}

function findings(row) {
  const byCause = new Map();
  for (const [version, result] of Object.entries(row.results ?? {})) {
    const rules = result?.harness?.rules ?? [];
    for (const rule of rules) record(byCause, rule, `${rule.rule} (${version})`, version);
    if (rules.some((rule) => rule.cause === 'corpus-unparsed')) continue;
    const gap = unparsed(version, result, row.name);
    if (gap) record(byCause, gap, `every rule (${version})`, version);
  }
  return [...byCause.values()];
}

function label(row) {
  const results = Object.values(row.results ?? {});
  if (results.some((r) => r?.status === 'harness-misconfig')) return 'not measured';
  if (results.some((r) => r?.harness)) return 'partially excluded';
  return 'measured on nothing';
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
  console.error(`  ${row.name}@${row.version ?? '?'}  (${label(row)})`);
  for (const cause of causes) {
    console.error(`    ${cause.cause}: ${cause.detail}`);
    console.error(`    affects ${cause.rules.length}: ${cause.rules.slice(0, 4).join(', ')}${cause.rules.length > 4 ? ', …' : ''}`);
    console.error(`    fix: ${cause.fix}\n`);
  }
}
console.error('Repair the environment and re-run the nightly; do not publish these rows as facts about the plugin.');
process.exit(1);
