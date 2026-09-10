import { basename, isAbsolute, relative } from 'node:path';

/**
 * Reports get pasted into issues and CI logs, so a directory is named relative
 * to where the command was run. Anything outside that stays absolute, because a
 * trail of `..` is worse than the real path.
 */
export function displayPath(dir: string, from: string = process.cwd()): string {
  const rel = relative(from, dir);
  if (rel === '') return basename(dir) || dir;
  return rel.startsWith('..') || isAbsolute(rel) ? dir : rel;
}
