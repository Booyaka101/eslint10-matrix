import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const FIXTURES = join(ROOT, 'test', 'fixtures');

export interface Run {
  code: number;
  out: string;
}

/**
 * Runs a node script the way CI runs it: as a real process, reported on the
 * exit code and the output a maintainer would read. stdout and stderr are one
 * string because the reader sees one terminal.
 */
export async function runNode(script: string, args: readonly string[]): Promise<Run> {
  try {
    const { stdout, stderr } = await exec(process.execPath, [script, ...args]);
    return { code: 0, out: stdout + stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? -1, out: (e.stdout ?? '') + (e.stderr ?? '') };
  }
}

/** The CI guards, which all live in scripts/. */
export const runScript = (script: string, args: readonly string[]): Promise<Run> =>
  runNode(join(ROOT, 'scripts', script), args);
