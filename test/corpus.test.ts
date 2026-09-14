import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { corpusFiles } from '../packages/runner/src/corpus.js';
import type { PluginSpec } from '../packages/runner/src/types.js';

const PLUGINS_JSON = join(__dirname, '..', 'packages', 'runner', 'src', 'plugins.json');

async function plugins(): Promise<PluginSpec[]> {
  const doc = JSON.parse(await readFile(PLUGINS_JSON, 'utf8')) as { plugins: PluginSpec[] };
  return doc.plugins;
}

describe('the fixture corpus', () => {
  it('offers only JavaScript and TypeScript by default', async () => {
    const files = await corpusFiles();
    expect(files.length).toBeGreaterThan(0);
    expect(files.every((file) => /\.(?:js|jsx|mjs|cjs|ts|tsx|mts|cts)$/.test(file))).toBe(true);
  });

  it('keeps a plugin-specific extension out of every other plugin list', async () => {
    expect(await corpusFiles()).not.toContain(join('fixtures', 'component.svelte'));
  });

  it('adds the extensions a plugin asks for, on top of the shared files', async () => {
    const shared = await corpusFiles();
    const withSvelte = await corpusFiles(['.svelte']);
    expect(withSvelte).toContain(join('fixtures', 'component.svelte'));
    expect(withSvelte).toEqual(expect.arrayContaining(shared));
    expect(withSvelte).toHaveLength(shared.length + 1);
  });

  /**
   * A declared extension with no file behind it is a silent no-op: the plugin
   * goes on being measured on nothing and nothing says so until the nightly
   * guard catches it a day later.
   */
  it('has a real file behind every extension a plugin declares', async () => {
    const declaring = (await plugins()).filter((spec) => spec.corpusExtensions?.length);
    expect(declaring.length).toBeGreaterThan(0);
    for (const spec of declaring) {
      const files = await corpusFiles(spec.corpusExtensions);
      for (const extension of spec.corpusExtensions!) {
        expect(files.some((file) => file.endsWith(extension)), `${spec.name} declares ${extension}`).toBe(true);
      }
    }
  });

  it('gives eslint-plugin-svelte an extension, because its parser reads no shared fixture', async () => {
    const svelte = (await plugins()).find((spec) => spec.name === 'eslint-plugin-svelte');
    expect(svelte?.corpusExtensions).toContain('.svelte');
  });
});
