#!/usr/bin/env node
/** Merges the per-shard matrix files the nightly job produces into one matrix.json. */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const [shardDir = 'shards', outFile = 'matrix.json'] = process.argv.slice(2);

const files = (await readdir(resolve(shardDir)).catch(() => [])).filter((f) => f.endsWith('.json'));
if (files.length === 0) {
  console.error(`merge: no shard files found in ${resolve(shardDir)}`);
  process.exit(1);
}

const rows = new Map();
let eslintVersions = null;
let newest = '';

for (const file of files.sort()) {
  const path = join(resolve(shardDir), file);
  let doc;
  try {
    doc = JSON.parse(await readFile(path, 'utf8'));
  } catch (err) {
    console.error(`merge: skipping unreadable shard ${file}: ${err.message}`);
    continue;
  }
  if (doc.schemaVersion !== 1 || !Array.isArray(doc.plugins)) {
    console.error(`merge: skipping ${file}: not a v1 matrix`);
    continue;
  }
  if (!eslintVersions) eslintVersions = doc.eslintVersions;
  else if (JSON.stringify(eslintVersions) !== JSON.stringify(doc.eslintVersions)) {
    console.error(
      `merge: ${file} tested ${JSON.stringify(doc.eslintVersions)} but earlier shards tested ` +
        `${JSON.stringify(eslintVersions)} - a release landed mid-run, refusing to mix them`
    );
    process.exit(1);
  }
  if (doc.generatedAt > newest) newest = doc.generatedAt;
  for (const row of doc.plugins) rows.set(row.name, row);
}

if (rows.size === 0) {
  console.error('merge: every shard was empty or invalid');
  process.exit(1);
}

const matrix = {
  schemaVersion: 1,
  generatedAt: newest || new Date().toISOString(),
  eslintVersions,
  plugins: [...rows.values()].sort((a, b) => b.weeklyDownloads - a.weeklyDownloads),
};

await writeFile(resolve(outFile), `${JSON.stringify(matrix, null, 2)}\n`, 'utf8');
console.log(`merge: ${files.length} shards -> ${resolve(outFile)} (${matrix.plugins.length} plugins)`);
