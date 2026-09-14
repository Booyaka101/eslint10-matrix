import { readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** The fixture corpus every board row is measured against. */
export const CORPUS_DIR = join(resolve(HERE, '..'), 'fixtures');

const LINTABLE = ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts'];

let cached: string[] | null = null;

/**
 * Corpus-relative paths, as the probe expects them once the directory is copied
 * in. `extra` adds extensions only the asking plugin can read, so a framework
 * plugin whose parser rejects every shared fixture gets a file of its own
 * instead of a row measured on nothing. They stay out of every other plugin's
 * file list, where they would only ever be parse noise.
 */
export async function corpusFiles(extra: readonly string[] = []): Promise<string[]> {
  cached ??= (await readdir(CORPUS_DIR)).sort();
  const wanted = [...LINTABLE, ...extra];
  return cached.filter((name) => wanted.some((ext) => name.endsWith(ext))).map((name) => join('fixtures', name));
}
