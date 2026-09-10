import { existsSync } from 'node:fs';
import { dirname, join, parse, resolve } from 'node:path';

/** Every directory from `startDir` up to the filesystem root, nearest first. */
export function ancestors(startDir: string): string[] {
  const out: string[] = [];
  let dir = resolve(startDir);
  const { root } = parse(dir);
  for (;;) {
    out.push(dir);
    if (dir === root) return out;
    const parent = dirname(dir);
    if (parent === dir) return out;
    dir = parent;
  }
}

/**
 * The first of `relativePaths` that exists, searching each directory in full
 * before moving up. That order is what makes the nearest eslint.config.js win
 * over a config name earlier in the list but further up the tree.
 */
export function findUp(startDir: string, ...relativePaths: readonly string[]): string | null {
  for (const dir of ancestors(startDir)) {
    for (const relativePath of relativePaths) {
      const candidate = join(dir, relativePath);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}
