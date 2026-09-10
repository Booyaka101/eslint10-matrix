import { readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

export const LINTABLE_EXTENSIONS = ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts'];

/** Pruned before the config's own ignores, exactly as ESLint prunes them. */
const ALWAYS_IGNORED = new Set(['node_modules', '.git']);

/**
 * Flat-config `ignores` are minimatch globs against the path relative to the
 * config file. This covers the subset that appears in real configs: `**`, `*`,
 * `?`, character classes and brace alternatives, plus the ESLint 9 rule that a
 * pattern naming a directory ignores everything under it.
 */
export function globToRegExp(pattern: string): RegExp {
  const trimmed = pattern.replace(/\/+$/, '');
  let out = '';
  for (let i = 0; i < trimmed.length; i += 1) {
    const ch = trimmed[i]!;
    if (ch === '*') {
      const doubled = trimmed[i + 1] === '*';
      if (doubled) {
        i += 1;
        // A `**/` segment must also match zero segments, so `**/*.js` matches `a.js`.
        if (trimmed[i + 1] === '/') {
          i += 1;
          out += '(?:[^/]*(?:/|$))*';
        } else {
          out += '.*';
        }
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') out += '[^/]';
    else if (ch === '{') out += '(?:';
    else if (ch === '}') out += ')';
    else if (ch === ',') out += '|';
    else if (ch === '[') {
      const end = trimmed.indexOf(']', i);
      if (end === -1) out += '\\[';
      else {
        out += trimmed.slice(i, end + 1).replace('[!', '[^');
        i = end;
      }
    } else out += ch.replace(/[.+^$()|\\]/g, '\\$&');
  }
  // Naming a directory ignores its contents, so `dist` also matches `dist/a.js`.
  return new RegExp(`^${out}(?:/.*)?$`);
}

export interface Ignorer {
  ignores(relativePath: string): boolean;
}

/** Later negated patterns win, which is how flat config unignores a subtree. */
export function buildIgnorer(patterns: readonly string[]): Ignorer {
  const rules = patterns.map((raw) => {
    const negated = raw.startsWith('!');
    return { negated, test: globToRegExp(negated ? raw.slice(1) : raw) };
  });
  return {
    ignores(relativePath: string): boolean {
      let ignored = false;
      for (const rule of rules) {
        if (rule.test.test(relativePath)) ignored = !rule.negated;
      }
      return ignored;
    },
  };
}

export interface CollectResult {
  /** Repo-relative paths in OS form, sorted, capped at `max`. */
  files: string[];
  /** Files that matched but did not fit under `max`. */
  skipped: number;
}

export interface CollectOptions {
  ignores?: readonly string[];
  max?: number;
  extensions?: readonly string[];
}

/**
 * Walks the repo the way ESLint would, so `scan` measures the caller's own
 * sources rather than a fixture corpus. Directories are pruned on the ignore
 * list rather than filtered afterwards, which keeps a large `dist` cheap.
 */
export async function collectFiles(root: string, options: CollectOptions = {}): Promise<CollectResult> {
  const ignorer = buildIgnorer(options.ignores ?? []);
  const extensions = options.extensions ?? LINTABLE_EXTENSIONS;
  const max = options.max ?? Infinity;
  const found: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // an unreadable directory is not a measurement failure
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (ALWAYS_IGNORED.has(entry.name)) continue;
      const full = join(dir, entry.name);
      const rel = relative(root, full).split(sep).join('/');
      if (ignorer.ignores(rel)) continue;
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && extensions.some((ext) => entry.name.endsWith(ext))) found.push(rel);
    }
  }

  await walk(root);
  found.sort();
  return {
    files: found.slice(0, max).map((f) => f.split('/').join(sep)),
    skipped: Math.max(0, found.length - (max === Infinity ? found.length : max)),
  };
}
