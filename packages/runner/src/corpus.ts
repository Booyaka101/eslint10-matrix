import { readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** The fixture corpus every board row is measured against. */
export const CORPUS_DIR = join(resolve(HERE, '..'), 'fixtures');

const LINTABLE = ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts'];

let cached: string[] | null = null;

/** Corpus-relative paths, as the probe expects them once the directory is copied in. */
export async function corpusFiles(): Promise<string[]> {
  if (!cached) {
    const names = await readdir(CORPUS_DIR);
    cached = names
      .filter((name) => LINTABLE.some((ext) => name.endsWith(ext)))
      .sort()
      .map((name) => join('fixtures', name));
  }
  return cached;
}
