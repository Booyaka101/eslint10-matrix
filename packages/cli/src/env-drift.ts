import { join } from 'node:path';
import { readLockfile, resolveInstalled } from './installed.js';
import type { MeasuredEnv } from './matrix.js';
import { versionDeltas, type VersionDelta } from './version-delta.js';

export interface MeasuredDrift {
  plugin: string;
  /** `before` is what the board installed, `after` is what this repo has. */
  deltas: VersionDelta[];
}

export interface DriftInput {
  name: string;
  measuredWith: MeasuredEnv | undefined;
  /** Where this row's versions resolve from, when a shared config installed the plugin. */
  fromDir?: string;
}

/**
 * eslint itself is the axis the board is about, not a dependency: a repo running
 * `check` is on 9 by definition, and saying so under every row would be noise.
 */
const IGNORED = new Set(['eslint']);

type Resolver = (name: string) => Promise<string | null>;

async function driftForRow(env: MeasuredEnv, installed: Resolver): Promise<VersionDelta[]> {
  const board: Record<string, string | null> = {};
  const here: Record<string, string | null> = {};
  for (const [name, version] of Object.entries(env.deps)) {
    if (IGNORED.has(name)) continue;
    board[name] = version;
    here[name] = await installed(name);
  }
  // Both sides have to have a version for this to be drift. A package the board
  // named and this repo does not have at all is usually a peer npm hoisted
  // differently, and reporting it would bury the case that matters under it.
  return versionDeltas(board, here).filter((d) => d.before !== null && d.after !== null);
}

/**
 * Where the versions a verdict was measured against are not the versions this
 * repo has. The board says eslint-plugin-vue is clean on ESLint 10; it reached
 * that with vue-eslint-parser 10.3.0, and a repo still on 9.1.0 has been told
 * something about a plugin it is not running. Until the board recorded what it
 * installed there was no way to say this at all.
 */
export async function measuredDrift(rows: readonly DriftInput[], projectDir: string): Promise<MeasuredDrift[]> {
  const wanted = rows.filter((row) => row.measuredWith);
  if (wanted.length === 0) return [];
  const lockfile = await readLockfile(projectDir);
  // Plugins name overlapping peers: five rows can each list the same parser, and
  // this repo's answer for it is the same every time it is asked from one place.
  const seen = new Map<string, Promise<string | null>>();
  const installedFrom =
    (fromDir: string): Resolver =>
    (name) => {
      const key = join(fromDir, name);
      const known = seen.get(key);
      if (known) return known;
      const lookup = resolveInstalled(name, fromDir, lockfile).then((found) => found?.version ?? null);
      seen.set(key, lookup);
      return lookup;
    };
  const found: MeasuredDrift[] = [];
  for (const row of wanted) {
    const deltas = await driftForRow(row.measuredWith!, installedFrom(row.fromDir ?? projectDir));
    if (deltas.length > 0) found.push({ plugin: row.name, deltas });
  }
  return found;
}
