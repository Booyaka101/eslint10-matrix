import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A scratch directory. The prefix is what says which suite left one behind. */
export async function tempDir(prefix = 'e10m-test-'): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

/** A node_modules the way npm leaves one, with a manifest per installed package. */
export async function fakeInstall(dir: string, packages: Record<string, string>): Promise<void> {
  for (const [name, version] of Object.entries(packages)) {
    const pkgDir = join(dir, 'node_modules', ...name.split('/'));
    await mkdir(pkgDir, { recursive: true });
    await writeFile(join(pkgDir, 'package.json'), JSON.stringify({ name, version }));
  }
}
