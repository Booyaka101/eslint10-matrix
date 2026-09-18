import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const FIXTURES = join(ROOT, 'test', 'fixtures');

/**
 * The guards are CI jobs, so they are tested the way CI runs them: as a real
 * process, on the exit code and the output a maintainer would read.
 */
export async function runScript(script: string, args: readonly string[]): Promise<{ code: number; out: string }> {
  try {
    const { stdout, stderr } = await exec(process.execPath, [join(ROOT, 'scripts', script), ...args]);
    return { code: 0, out: stdout + stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? -1, out: (e.stdout ?? '') + (e.stderr ?? '') };
  }
}
