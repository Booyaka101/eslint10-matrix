import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { findUp } from './find-up.js';

/** npm, pnpm and yarn all write manifests that may start with a BOM. */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export async function readJsonFile<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(stripBom(await readFile(path, 'utf8'))) as T;
  } catch {
    return null;
  }
}

export interface InstalledPackage {
  name: string;
  version: string;
  /** Where the version came from, so the report can say how sure it is. */
  source: 'node_modules' | 'lockfile';
  peerDependencies: Record<string, string>;
  optionalPeers: Set<string>;
  peerEslintRange: string | null;
  dir?: string;
}

interface Manifest {
  version?: string;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
}

/**
 * The installed tree is the only truthful answer to "what version is this repo
 * on": a range in package.json is a wish, and the registry's latest is somebody
 * else's repo. The lockfile is the fallback for a pnpm store or a repo that has
 * not run install yet.
 */
export async function readInstalled(name: string, fromDir: string): Promise<InstalledPackage | null> {
  const manifestPath = findUp(fromDir, join('node_modules', ...name.split('/'), 'package.json'));
  if (!manifestPath) return null;
  const doc = await readJsonFile<Manifest>(manifestPath);
  if (!doc?.version) return null;
  return describe(name, doc, 'node_modules', dirname(manifestPath));
}

function describe(
  name: string,
  doc: Manifest,
  source: InstalledPackage['source'],
  dir?: string
): InstalledPackage {
  const peers = doc.peerDependencies ?? {};
  const optional = new Set(
    Object.entries(doc.peerDependenciesMeta ?? {})
      .filter(([, meta]) => meta?.optional)
      .map(([peer]) => peer)
  );
  return {
    name,
    version: String(doc.version),
    source,
    peerDependencies: peers,
    optionalPeers: optional,
    peerEslintRange: peers.eslint ?? null,
    ...(dir ? { dir } : {}),
  };
}

export function hasNodeModules(fromDir: string): boolean {
  return findUp(fromDir, 'node_modules') !== null;
}

const LOCKFILES = ['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock'];

export interface Lockfile {
  path: string;
  versions: Map<string, string>;
}

export function findLockfile(fromDir: string): string | null {
  return findUp(fromDir, ...LOCKFILES);
}

interface NpmLock {
  lockfileVersion?: number;
  packages?: Record<string, { version?: string }>;
  dependencies?: Record<string, { version?: string; dependencies?: Record<string, unknown> }>;
}

function fromNpmLock(doc: NpmLock): Map<string, string> {
  const out = new Map<string, string>();
  // v2 and v3 key by install path; the last node_modules segment is the package.
  // npm writes those paths sorted, so a nested copy under another package can
  // come first: the shallowest path is the hoisted install, and that is the one
  // a plugin resolved from the repo root would get.
  const depth = new Map<string, number>();
  for (const [path, entry] of Object.entries(doc.packages ?? {})) {
    const at = path.lastIndexOf('node_modules/');
    if (at === -1 || !entry?.version) continue;
    const name = path.slice(at + 'node_modules/'.length);
    const nesting = path.split('node_modules/').length;
    if (!out.has(name) || nesting < depth.get(name)!) {
      out.set(name, entry.version);
      depth.set(name, nesting);
    }
  }
  // v1 nests by name; the top level is the hoisted install, which is what a
  // plugin resolved from the repo root would get.
  const walk = (deps: NpmLock['dependencies']): void => {
    for (const [name, entry] of Object.entries(deps ?? {})) {
      if (entry?.version && !out.has(name)) out.set(name, entry.version);
      walk(entry?.dependencies as NpmLock['dependencies']);
    }
  };
  walk(doc.dependencies);
  return out;
}

/**
 * pnpm has written three key shapes: `/name/1.2.3:`, `/name@1.2.3:` and bare
 * `name@1.2.3:`. Peer suffixes such as `(eslint@10.0.0)` are stripped.
 */
function fromPnpmLock(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const line = /^ {2}'?\/?((?:@[^/\s'@]+\/)?[^/\s'@]+)[@/](\d[^\s'(:]*)'?[^:]*:\s*$/;
  for (const raw of text.split('\n')) {
    const match = line.exec(raw);
    if (match && !out.has(match[1]!)) out.set(match[1]!, match[2]!);
  }
  return out;
}

/** Covers yarn classic (`version "1.2.3"`) and berry (`version: 1.2.3`). */
function fromYarnLock(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const header = /^"?((?:@[^/\s"]+\/)?[^@\s"][^@\s"]*)@/;
  const version = /^ {2}version:?\s+"?([^"\s]+)"?\s*$/;
  let current: string | null = null;
  for (const raw of text.split('\n')) {
    if (!raw.startsWith(' ') && raw.trim().endsWith(':')) {
      const match = header.exec(raw.trim());
      current = match ? match[1]! : null;
      continue;
    }
    const found = version.exec(raw);
    if (found && current && !out.has(current)) out.set(current, found[1]!);
  }
  return out;
}

export async function readLockfile(fromDir: string): Promise<Lockfile | null> {
  const path = findLockfile(fromDir);
  if (!path) return null;
  const text = stripBom(await readFile(path, 'utf8').catch(() => ''));
  if (text === '') return null;
  if (path.endsWith('.json')) {
    try {
      return { path, versions: fromNpmLock(JSON.parse(text) as NpmLock) };
    } catch {
      return { path, versions: new Map() };
    }
  }
  return { path, versions: path.endsWith('pnpm-lock.yaml') ? fromPnpmLock(text) : fromYarnLock(text) };
}

/** node_modules first, lockfile second; a package in neither is not installed. */
export async function resolveInstalled(
  name: string,
  fromDir: string,
  lockfile: Lockfile | null
): Promise<InstalledPackage | null> {
  const installed = await readInstalled(name, fromDir);
  if (installed) return installed;
  const version = lockfile?.versions.get(name);
  return version ? describe(name, { version }, 'lockfile') : null;
}
