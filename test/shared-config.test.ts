import { cp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { measuredDrift } from '../packages/cli/src/env-drift.js';
import { main } from '../packages/cli/src/index.js';
import { resolveInstalled } from '../packages/cli/src/installed.js';
import type { Matrix } from '../packages/cli/src/matrix.js';
import { buildReport, renderReport } from '../packages/cli/src/report.js';
import { resolveConfig } from '../packages/cli/src/resolve-config.js';
import { sharedConfigSnippet } from '../packages/cli/src/snippet.js';
import { tempDir } from './fake-repo.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'next-app');
const NEXT = { config: 'eslint-config-next', configVersion: '16.3.6' };

async function write(dir: string, files: Record<string, string>): Promise<void> {
  for (const [name, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, name)), { recursive: true });
    await writeFile(join(dir, name), text);
  }
}

/** The fixture in a scratch directory, with package.json edited by `edit`. */
async function copyFixture(edit: (manifest: Record<string, Record<string, string>>) => void = () => {}): Promise<string> {
  const dir = await tempDir('e10m-shared-');
  await cp(FIXTURE, dir, { recursive: true });
  const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
  edit(manifest);
  await writeFile(join(dir, 'package.json'), JSON.stringify(manifest));
  return dir;
}

const manifest = (deps: Record<string, string>) => JSON.stringify({ name: 'x', private: true, type: 'module', devDependencies: deps });
const pkg = (name: string, version: string, extra: object = {}) => JSON.stringify({ name, version, main: 'index.js', ...extra });

async function runCli(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const out = vi.spyOn(console, 'log').mockImplementation((...args) => {
    stdout += `${args.join(' ')}\n`;
  });
  const err = vi.spyOn(console, 'error').mockImplementation((...args) => {
    stderr += `${args.join(' ')}\n`;
  });
  const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout += String(chunk);
    return true;
  });
  try {
    return { code: await main(argv), stdout, stderr };
  } finally {
    out.mockRestore();
    err.mockRestore();
    write.mockRestore();
  }
}

describe('plugins that arrive through a shared config', () => {
  it('attributes every plugin eslint-config-next registers, with none left unknown', async () => {
    const resolved = await resolveConfig(FIXTURE);
    expect(resolved.unknown).toEqual([]);
    expect(resolved.plugins).toEqual([
      '@next/eslint-plugin-next',
      '@typescript-eslint/eslint-plugin',
      'eslint-plugin-import',
      'eslint-plugin-jsx-a11y',
      'eslint-plugin-react',
      'eslint-plugin-react-hooks',
    ]);
    for (const name of resolved.plugins) {
      expect(resolved.via[name]).toMatchObject(NEXT);
    }
    // eslint-plugin-react has no meta.name; eslint-plugin-jsx-a11y declares one.
    expect(resolved.keys.react).toBe('eslint-plugin-react');
    expect(resolved.keys['jsx-a11y']).toBe('eslint-plugin-jsx-a11y');
  });

  it('does not take the react key for the react library the app depends on', async () => {
    const resolved = await resolveConfig(FIXTURE);
    expect(resolved.plugins).not.toContain('react');
    expect(resolved.keys.react).toBe('eslint-plugin-react');
  });

  it('follows eslint-config-next one level down to typescript-eslint', async () => {
    const resolved = await resolveConfig(FIXTURE);
    const source = resolved.via['@typescript-eslint/eslint-plugin']!;
    expect(source.config).toBe('eslint-config-next');
    expect(source.dir).toBe(join(FIXTURE, 'node_modules', 'typescript-eslint'));
  });

  it('says the config brings a parser nothing here measures', async () => {
    const resolved = await resolveConfig(FIXTURE);
    expect(resolved.notes).toEqual([
      'eslint-config-next sets its own parser (eslint-config-next/parser) for **/*.{js,jsx,mjs,ts,tsx,mts,cts}; ' +
        'eslint10-matrix measures plugins, not parsers, so nothing here says it runs on ESLint 10',
    ]);
  });

  it('keeps a plugin the repo depends on directly as direct', async () => {
    const dir = await copyFixture((m) => {
      m.devDependencies!['eslint-plugin-react'] = '^7.37.5';
    });
    const resolved = await resolveConfig(dir);
    expect(resolved.plugins).toContain('eslint-plugin-react');
    expect(resolved.via['eslint-plugin-react']).toBeUndefined();
    expect(resolved.via['eslint-plugin-import']).toMatchObject(NEXT);
  });

  it('measures the copy the config loads when package.json names an older one', async () => {
    const dir = await copyFixture((m) => {
      m.devDependencies!['eslint-plugin-react'] = '7.30.0';
    });
    const modules = join(dir, 'node_modules');
    const nested = join(modules, 'eslint-config-next', 'node_modules', 'eslint-plugin-react');
    await cp(join(modules, 'eslint-plugin-react'), nested, { recursive: true });
    const rootManifest = join(modules, 'eslint-plugin-react', 'package.json');
    await writeFile(rootManifest, (await readFile(rootManifest, 'utf8')).replace('"7.37.5"', '"7.30.0"'));

    const resolved = await resolveConfig(dir);
    expect(resolved.via['eslint-plugin-react']).toMatchObject(NEXT);
    expect(resolved.via['eslint-plugin-react']!.dir).toBe(join(modules, 'eslint-config-next'));
    expect(resolved.notes).toContain(
      'eslint-plugin-react@7.30.0 in package.json is not the copy eslint.config loads: ' +
        'eslint-config-next registers its own 7.37.5, so that is the one measured'
    );
    expect((await resolveInstalled('eslint-plugin-react', resolved.via['eslint-plugin-react']!.dir, null))?.version).toBe(
      '7.37.5'
    );
  });

  it('finds the plugins beside the config in a pnpm store, where the root cannot see them', async () => {
    const dir = await tempDir('e10m-pnpm-');
    await cp(join(FIXTURE, 'package.json'), join(dir, 'package.json'));
    await cp(join(FIXTURE, 'eslint.config.mjs'), join(dir, 'eslint.config.mjs'));
    const store = join(dir, 'node_modules', '.pnpm');
    const stored = (name: string, version: string) => join(store, `${name.replace('/', '+')}@${version}`, 'node_modules', name);
    const installed = {
      'eslint-config-next': '16.3.6',
      'eslint-plugin-react': '7.37.5',
      'eslint-plugin-import': '2.32.0',
      'eslint-plugin-jsx-a11y': '6.10.2',
      'eslint-plugin-react-hooks': '7.1.1',
      '@next/eslint-plugin-next': '16.3.6',
      'typescript-eslint': '8.70.1',
      '@typescript-eslint/eslint-plugin': '8.70.1',
    };
    for (const [name, version] of Object.entries(installed)) {
      await cp(join(FIXTURE, 'node_modules', name), stored(name, version), { recursive: true });
    }
    const link = async (target: string, at: string) => {
      await mkdir(dirname(at), { recursive: true });
      await symlink(target, at, 'junction');
    };
    // pnpm links each package's dependencies beside it in the store, and only the
    // direct dependency at the root.
    const configDeps = join(store, 'eslint-config-next@16.3.6', 'node_modules');
    for (const [name, version] of Object.entries(installed)) {
      if (name !== 'eslint-config-next' && name !== '@typescript-eslint/eslint-plugin') {
        await link(stored(name, version), join(configDeps, name));
      }
    }
    await link(
      stored('@typescript-eslint/eslint-plugin', '8.70.1'),
      join(store, 'typescript-eslint@8.70.1', 'node_modules', '@typescript-eslint', 'eslint-plugin')
    );
    await link(stored('eslint-config-next', '16.3.6'), join(dir, 'node_modules', 'eslint-config-next'));

    const resolved = await resolveConfig(dir);
    expect(resolved.unknown).toEqual([]);
    expect(resolved.plugins).toHaveLength(6);
    expect(resolved.via['eslint-plugin-react']!.dir).toBe(stored('eslint-config-next', '16.3.6'));
    expect(resolved.via['@typescript-eslint/eslint-plugin']!.dir).toBe(stored('typescript-eslint', '8.70.1'));

    // What scan and check read the installed version from.
    expect(await resolveInstalled('eslint-plugin-react', dir, null)).toBeNull();
    expect((await resolveInstalled('eslint-plugin-react', resolved.via['eslint-plugin-react']!.dir, null))?.version).toBe(
      '7.37.5'
    );
  });

  it('identifies a plugin with no meta.name under a key that follows no convention', async () => {
    const dir = await tempDir('e10m-identity-');
    await write(dir, {
      'package.json': manifest({ '@acme/eslint-config': '1.0.0' }),
      'eslint.config.js': "import acme from '@acme/eslint-config';\nexport default acme;\n",
      'node_modules/@acme/eslint-config/package.json': pkg('@acme/eslint-config', '1.0.0', {
        dependencies: { 'eslint-plugin-legacy': '^3.0.0' },
      }),
      'node_modules/@acme/eslint-config/index.js':
        "module.exports = [{ plugins: { house: require('eslint-plugin-legacy') } }];\n",
      'node_modules/eslint-plugin-legacy/package.json': pkg('eslint-plugin-legacy', '3.1.0'),
      'node_modules/eslint-plugin-legacy/index.js': 'module.exports = { rules: {} };\n',
    });
    const resolved = await resolveConfig(dir);
    expect(resolved.keys).toEqual({ house: 'eslint-plugin-legacy' });
    expect(resolved.via['eslint-plugin-legacy']).toMatchObject({ config: '@acme/eslint-config', configVersion: '1.0.0' });
  });

  it('suggests install when a config the plugin may come from is not installed', async () => {
    const dir = await tempDir('e10m-missing-');
    await write(dir, {
      'package.json': manifest({ 'eslint-config-next': '16.3.6' }),
      'eslint.config.js': 'export default [{ plugins: { react: { rules: {} } } }];\n',
      'node_modules/.keep': '',
    });
    const resolved = await resolveConfig(dir);
    expect(resolved.unknown).toEqual(['react']);
    const reason =
      'may arrive through eslint-config-next, which is not installed where eslint10-matrix looked; run install and try again';
    expect(resolved.unknownReasons).toEqual({ react: reason });
    const report = buildReport(MATRIX, { ...resolved });
    expect(report.unknown[0]!.reason).toBe(reason);
  });

  it('leaves Yarn PnP as it was, since there is no node_modules to walk or install into', async () => {
    const dir = await tempDir('e10m-pnp-');
    await write(dir, {
      'package.json': manifest({ 'eslint-config-next': '16.3.6' }),
      'eslint.config.js': 'export default [{ plugins: { react: { rules: {} } } }];\n',
      '.pnp.cjs': '',
    });
    const resolved = await resolveConfig(dir);
    expect(resolved.unknown).toEqual(['react']);
    expect(resolved.unknownReasons).toEqual({});
    expect(resolved.via).toEqual({});
  });

  it('leaves a plugin object that matches nothing in any installed config unknown', async () => {
    const dir = await copyFixture();
    await writeFile(
      join(dir, 'eslint.config.mjs'),
      "import next from 'eslint-config-next';\nexport default [...next, { plugins: { local: { rules: {} } } }];\n"
    );
    const resolved = await resolveConfig(dir);
    expect(resolved.unknown).toEqual(['local']);
    expect(resolved.unknownReasons).toEqual({});
    expect(resolved.plugins).toHaveLength(6);
  });

  it('ignores a plugin a config only lists as a peer, which the repo has to install itself', async () => {
    const dir = await tempDir('e10m-peer-');
    await write(dir, {
      'package.json': manifest({ 'eslint-config-peer': '1.0.0' }),
      'eslint.config.js': "import peer from 'eslint-config-peer';\nexport default peer;\n",
      'node_modules/eslint-config-peer/package.json': pkg('eslint-config-peer', '1.0.0', {
        peerDependencies: { 'eslint-plugin-legacy': '^3.0.0' },
      }),
      'node_modules/eslint-config-peer/index.js':
        "module.exports = [{ plugins: { legacy: require('eslint-plugin-legacy') } }];\n",
      'node_modules/eslint-plugin-legacy/package.json': pkg('eslint-plugin-legacy', '3.1.0'),
      'node_modules/eslint-plugin-legacy/index.js': 'module.exports = { rules: {} };\n',
    });
    const resolved = await resolveConfig(dir);
    expect(resolved.unknown).toEqual(['legacy']);
    expect(resolved.via).toEqual({});
  });

  it('measures the copy eslint.config loads when two configs each nest their own', async () => {
    const dir = await tempDir('e10m-two-');
    const config = (name: string, version: string) => ({
      [`node_modules/${name}/package.json`]: pkg(name, '2.0.0', { dependencies: { 'eslint-plugin-legacy': '^3.0.0' } }),
      [`node_modules/${name}/index.js`]: "module.exports = [{ plugins: { legacy: require('eslint-plugin-legacy') } }];\n",
      [`node_modules/${name}/node_modules/eslint-plugin-legacy/package.json`]: pkg('eslint-plugin-legacy', version),
      [`node_modules/${name}/node_modules/eslint-plugin-legacy/index.js`]: 'module.exports = { rules: {} };\n',
    });
    await write(dir, {
      'package.json': manifest({ 'eslint-config-b': '2.0.0', 'eslint-config-a': '2.0.0' }),
      'eslint.config.js': "import a from 'eslint-config-a';\nexport default a;\n",
      ...config('eslint-config-a', '3.2.0'),
      ...config('eslint-config-b', '3.1.0'),
    });
    const resolved = await resolveConfig(dir);
    expect(resolved.via['eslint-plugin-legacy']).toMatchObject({ config: 'eslint-config-a', dir: join(dir, 'node_modules', 'eslint-config-a') });
    expect(resolved.notes).toEqual([
      'eslint-plugin-legacy arrives through eslint-config-a and eslint-config-b; ' +
        'measured the copy eslint-config-a registers, which is the one eslint.config loads',
    ]);
  });

  it('falls back to package.json order when no config registers the object itself', async () => {
    const dir = await tempDir('e10m-copied-');
    const config = (name: string) => ({
      [`node_modules/${name}/package.json`]: pkg(name, '2.0.0', { dependencies: { 'eslint-plugin-legacy': '^3.0.0' } }),
      [`node_modules/${name}/index.js`]: "module.exports = [{ plugins: { legacy: { ...require('eslint-plugin-legacy') } } }];\n",
    });
    await write(dir, {
      'package.json': manifest({ 'eslint-config-b': '2.0.0', 'eslint-config-a': '2.0.0' }),
      'eslint.config.js': "import a from 'eslint-config-a';\nexport default a;\n",
      ...config('eslint-config-a'),
      ...config('eslint-config-b'),
      'node_modules/eslint-plugin-legacy/package.json': pkg('eslint-plugin-legacy', '3.1.0'),
      'node_modules/eslint-plugin-legacy/index.js': "module.exports = { meta: { name: 'eslint-plugin-legacy' }, rules: {} };\n",
    });
    const resolved = await resolveConfig(dir);
    expect(resolved.via['eslint-plugin-legacy']?.config).toBe('eslint-config-b');
    expect(resolved.notes).toEqual([
      'eslint-plugin-legacy arrives through eslint-config-b and eslint-config-a; ' +
        'measured the copy eslint-config-b installed, which comes first in package.json',
    ]);
  });

  it('records the config in between, so scan knows typescript-eslint is in use', async () => {
    const resolved = await resolveConfig(FIXTURE);
    expect(resolved.via['@typescript-eslint/eslint-plugin']!.through).toBe('typescript-eslint');
    expect(resolved.via['eslint-plugin-react']!.through).toBeUndefined();
  });

  it('does not crash on a parser whose meta.name is empty', async () => {
    const dir = await tempDir('e10m-parser-');
    await write(dir, {
      'package.json': manifest({}),
      'eslint.config.js':
        "export default [{ languageOptions: { parser: { meta: { name: '' }, parse() {} } } }, " +
        "{ languageOptions: { parser: { meta: { name: '/local' }, parse() {} } } }];\n",
    });
    const resolved = await resolveConfig(dir);
    expect(resolved.notes).toEqual([]);
    expect(resolved.parsers).toEqual([]);
  });

  it('follows a package not named like a config, trusting only what it registers', async () => {
    const dir = await tempDir('e10m-unnamed-');
    await write(dir, {
      'package.json': manifest({ 'house-style': '1.0.0', 'unrelated-tool': '1.0.0' }),
      'eslint.config.js':
        "import house from 'house-style';\nexport default [...house(), { plugins: { other: { rules: {} } } }];\n",
      'node_modules/house-style/package.json': pkg('house-style', '1.0.0', {
        dependencies: { 'eslint-plugin-legacy': '^3.0.0', 'eslint-plugin-meta': '^1.0.0' },
      }),
      'node_modules/house-style/index.js':
        "module.exports = () => [{ plugins: { legacy: require('eslint-plugin-legacy'), m: { ...require('eslint-plugin-meta') } } }];\n",
      'node_modules/eslint-plugin-legacy/package.json': pkg('eslint-plugin-legacy', '3.1.0'),
      'node_modules/eslint-plugin-legacy/index.js': 'module.exports = { rules: {} };\n',
      'node_modules/eslint-plugin-meta/package.json': pkg('eslint-plugin-meta', '1.0.0'),
      'node_modules/eslint-plugin-meta/index.js': "module.exports = { meta: { name: 'eslint-plugin-meta' }, rules: {} };\n",
      // Depends on a plugin under the key's conventional name, and registers nothing.
      'node_modules/unrelated-tool/package.json': pkg('unrelated-tool', '1.0.0', { dependencies: { 'eslint-plugin-other': '^1.0.0' } }),
      'node_modules/unrelated-tool/index.js': 'module.exports = {};\n',
      'node_modules/eslint-plugin-other/package.json': pkg('eslint-plugin-other', '1.0.0'),
      'node_modules/eslint-plugin-other/index.js': 'module.exports = { rules: {} };\n',
    });
    const resolved = await resolveConfig(dir);
    expect(resolved.keys).toEqual({ legacy: 'eslint-plugin-legacy', m: 'eslint-plugin-meta' });
    expect(resolved.unknown).toEqual(['other']);
    expect(resolved.via['eslint-plugin-legacy']).toMatchObject({ config: 'house-style', configVersion: '1.0.0', spread: 'call' });
    expect(resolved.via['eslint-plugin-meta']?.config).toBe('house-style');
  });

  it('notices a direct plugin shadowed by the copy a package not named like a config registers', async () => {
    const dir = await tempDir('e10m-unnamed-shadow-');
    await write(dir, {
      'package.json': manifest({ 'house-style': '1.0.0', 'eslint-plugin-legacy': '3.0.0' }),
      'eslint.config.js': "import house from 'house-style';\nexport default house();\n",
      'node_modules/house-style/package.json': pkg('house-style', '1.0.0', { dependencies: { 'eslint-plugin-legacy': '^3.1.0' } }),
      'node_modules/house-style/index.js': "module.exports = () => [{ plugins: { legacy: require('eslint-plugin-legacy') } }];\n",
      'node_modules/house-style/node_modules/eslint-plugin-legacy/package.json': pkg('eslint-plugin-legacy', '3.1.0'),
      'node_modules/house-style/node_modules/eslint-plugin-legacy/index.js': 'module.exports = { rules: {} };\n',
      'node_modules/eslint-plugin-legacy/package.json': pkg('eslint-plugin-legacy', '3.0.0'),
      'node_modules/eslint-plugin-legacy/index.js': 'module.exports = { rules: {} };\n',
    });
    const resolved = await resolveConfig(dir);
    expect(resolved.via['eslint-plugin-legacy']).toMatchObject({ config: 'house-style', dir: join(dir, 'node_modules', 'house-style') });
    expect(resolved.notes).toEqual([
      'eslint-plugin-legacy@3.0.0 in package.json is not the copy eslint.config loads: ' +
        'house-style registers its own 3.1.0, so that is the one measured',
    ]);
  });

  it('reads board drift from where the config installed the plugin', async () => {
    const dir = await copyFixture();
    await write(dir, {
      'node_modules/eslint-config-next/node_modules/globals/package.json': pkg('globals', '16.4.0'),
      'node_modules/globals/package.json': pkg('globals', '11.12.0'),
    });
    const resolved = await resolveConfig(dir);
    const measuredWith = { node: '22.18.0', npm: '10.9.3', deps: { globals: '17.0.0' } };
    const drift = await measuredDrift(
      [{ name: 'eslint-plugin-react', measuredWith, fromDir: resolved.via['eslint-plugin-react']!.dir }],
      dir
    );
    expect(drift).toEqual([
      { plugin: 'eslint-plugin-react', deltas: [{ package: 'globals', before: '17.0.0', after: '16.4.0' }] },
    ]);
  });
});

function result(status: 'clean' | 'rule-crash', rules: string[] = []) {
  return {
    status,
    totalRules: 10,
    crashingRules: rules.map((rule) => ({ rule, message: `Error while loading rule '${rule}': boom` })),
  };
}

const RESCUED = {
  eslintVersion: '10.10.0',
  compatVersion: '2.1.1',
  attempted: true,
  verdict: 'rescuable' as const,
  crashingRulesBefore: 1,
  fixupFunction: 'fixupPluginRules' as const,
  crashingRulesAfter: 0,
};

const MATRIX: Matrix = {
  schemaVersion: 1,
  generatedAt: '2026-09-18T03:30:35.714Z',
  eslintVersions: { v9: '9.39.5', v10: '10.10.0' },
  plugins: [
    {
      name: 'eslint-plugin-react',
      version: '7.37.5',
      declaredPeerRange: '^9.7',
      weeklyDownloads: 1,
      results: { '9.39.5': result('clean'), '10.10.0': result('rule-crash', ['display-name']) },
      rescue: RESCUED,
    },
    {
      name: 'eslint-plugin-import',
      version: '2.32.0',
      declaredPeerRange: '^9',
      weeklyDownloads: 1,
      results: { '9.39.5': result('clean'), '10.10.0': result('rule-crash', ['unambiguous']) },
      rescue: RESCUED,
    },
    {
      name: 'eslint-plugin-jsx-a11y',
      version: '6.10.2',
      declaredPeerRange: '^9',
      weeklyDownloads: 1,
      results: { '9.39.5': result('clean'), '10.10.0': result('clean') },
    },
    {
      name: 'eslint-plugin-react-hooks',
      version: '7.1.1',
      declaredPeerRange: '^9 || ^10',
      weeklyDownloads: 1,
      results: { '9.39.5': result('clean'), '10.10.0': result('clean') },
    },
    {
      name: '@typescript-eslint/eslint-plugin',
      version: '8.70.0',
      declaredPeerRange: '^9 || ^10',
      weeklyDownloads: 1,
      results: { '9.39.5': result('clean'), '10.10.0': result('clean') },
    },
  ],
};

describe('check on a repo whose plugins come from eslint-config-next', () => {
  async function check(format: string[] = []) {
    const dir = await tempDir('e10m-check-');
    await writeFile(join(dir, 'matrix.json'), JSON.stringify(MATRIX));
    return runCli(['check', FIXTURE, '--matrix', join(dir, 'matrix.json'), '--no-color', ...format]);
  }

  it('carries the shared config on every plugin it brought, in --json', async () => {
    const attempt = await check(['--json']);
    const report = JSON.parse(attempt.stdout);
    expect(report.counts).toMatchObject({ rescuable: 2, safeToForce: 1, clean: 2, untested: 1, unknown: 0 });
    for (const entry of [...report.rescuable, ...report.safeToForce, ...report.clean, ...report.untested]) {
      expect(entry.via).toEqual(NEXT);
    }
    expect(report.untested.map((e: { name: string }) => e.name)).toEqual(['@next/eslint-plugin-next']);
  });

  it('labels each plugin with the config it came through and prints one wrap for both rescues', async () => {
    const attempt = await check();
    expect(attempt.stdout).toContain('eslint-plugin-react@7.37.5 (via eslint-config-next@16.3.6)');
    expect(attempt.stdout).toContain('eslint-plugin-jsx-a11y@6.10.2 (via eslint-config-next@16.3.6)');
    expect(attempt.stdout).toContain('@next/eslint-plugin-next (via eslint-config-next@16.3.6)');
    expect(attempt.stdout.match(/\.\.\.fixupConfigRules\(eslintConfigNext\)/g)).toHaveLength(1);
    expect(attempt.stdout).toContain('the eslint-config-next wrap above covers it');
    expect(attempt.stdout).not.toContain('fixupPluginRules(react)');
    expect(attempt.stdout).toContain(
      'CLEAN (2)  already declares ^10\n' +
        '  @typescript-eslint/eslint-plugin@8.70.0 (via eslint-config-next@16.3.6)\n' +
        '  eslint-plugin-react-hooks@7.1.1 (via eslint-config-next@16.3.6)\n'
    );
  });

  it('renders untested and unknown entries the same way when nothing arrives through a config', async () => {
    const report = buildReport(MATRIX, {
      plugins: ['eslint-plugin-react', 'eslint-plugin-nowhere'],
      unknown: ['mystery'],
      projectDir: './',
      configPath: './eslint.config.js',
    });
    expect(report.rescuable[0]!.via).toBeUndefined();
    expect(renderReport(report)).not.toContain('(via ');
  });

  it('compares board drift against the copy the config installed, end to end', async () => {
    const dir = await copyFixture();
    await write(dir, {
      'node_modules/eslint-config-next/node_modules/globals/package.json': pkg('globals', '16.4.0'),
      'node_modules/globals/package.json': pkg('globals', '11.12.0'),
    });
    const board = structuredClone(MATRIX);
    board.plugins[0]!.results['10.10.0']!.measuredWith = { node: '22.18.0', npm: '10.9.3', deps: { globals: '17.0.0' } };
    const scratch = await tempDir('e10m-check-');
    await writeFile(join(scratch, 'matrix.json'), JSON.stringify(board));
    const attempt = await runCli(['check', dir, '--matrix', join(scratch, 'matrix.json'), '--json']);
    expect(JSON.parse(attempt.stdout).measuredDrift).toEqual([
      { plugin: 'eslint-plugin-react', deltas: [{ package: 'globals', before: '17.0.0', after: '16.4.0' }] },
    ]);
  });

  it('prints one wrap per config across both rescue tiers, with every rule still off', () => {
    const board = structuredClone(MATRIX);
    board.plugins[1]!.rescue = { ...RESCUED, verdict: 'partial-rescue', residualRules: [{ rule: 'unambiguous', message: 'boom' }] };
    const text = renderReport(
      buildReport(board, {
        plugins: ['eslint-plugin-react', 'eslint-plugin-import'],
        unknown: [],
        via: { 'eslint-plugin-react': NEXT, 'eslint-plugin-import': NEXT },
        projectDir: './',
        configPath: './eslint.config.js',
      }),
      { color: false }
    );
    expect(text).toContain('RESCUABLE (1)');
    expect(text).toContain('PARTIAL-RESCUE (1)');
    expect(text.match(/\.\.\.fixupConfigRules\(eslintConfigNext\)/g)).toHaveLength(1);
    expect(text).toContain("'import/unambiguous': 'off',");
    expect(text).toContain('the eslint-config-next wrap above covers it');
  });

  it('does not say nothing blocks when a shared config brings a parser nothing measured', () => {
    const input = { plugins: ['eslint-plugin-react-hooks'], unknown: [], projectDir: './', configPath: './eslint.config.js' };
    expect(renderReport(buildReport(MATRIX, input), { color: false })).toContain('Nothing blocks the upgrade to ESLint 10.10.0.');
    expect(renderReport(buildReport(MATRIX, { ...input, parsers: ['eslint-config-next/parser'] }), { color: false })).toContain(
      'No plugin blocks the upgrade to ESLint 10.10.0, but the eslint-config-next/parser parser is not measured.'
    );
  });

  it('names a config that has no version without a dangling @', () => {
    const report = buildReport(MATRIX, {
      plugins: ['eslint-plugin-react-hooks'],
      unknown: [],
      via: { 'eslint-plugin-react-hooks': { config: '@acme/eslint-config', configVersion: '' } },
      projectDir: './',
      configPath: './eslint.config.js',
    });
    expect(renderReport(report, { color: false })).toContain('eslint-plugin-react-hooks@7.1.1 (via @acme/eslint-config)\n');
  });
});

describe('the rescue snippet for a plugin a shared config registers', () => {
  const rows = [{ name: 'eslint-plugin-react', rescue: RESCUED }];

  it('wraps the config, since flat config refuses to register the plugin a second time', () => {
    expect(sharedConfigSnippet({ config: 'eslint-config-next' }, rows, '10.10.0')).toBe(
      [
        "import { fixupConfigRules } from '@eslint/compat';",
        "import eslintConfigNext from 'eslint-config-next';",
        '',
        'export default [',
        '  // eslint-config-next registers its plugins itself: wrap it where you spread it,',
        '  // whichever of its entry points you import',
        '  ...fixupConfigRules(eslintConfigNext),',
        '  // ...the rest of your config',
        '];',
        '',
      ].join('\n')
    );
  });

  it('calls a config that exports a factory, and wraps what it returns', () => {
    const text = sharedConfigSnippet({ config: 'neostandard', spread: 'call' }, rows, '10.10.0');
    expect(text).toContain('  ...fixupConfigRules(neostandard({ /* your options */ })),');
  });

  it('wraps one of the configs of a package that exports an object, since that object is not a config', () => {
    expect(sharedConfigSnippet({ config: 'typescript-eslint', spread: 'configs.recommended' }, rows, '10.10.0')).toContain(
      '  ...fixupConfigRules(typescriptEslint.configs.recommended),'
    );
    expect(sharedConfigSnippet({ config: 'x-lint', spread: 'configs.flat/base' }, rows, '10.10.0')).toContain(
      "  ...fixupConfigRules(xLint.configs['flat/base']),"
    );
  });

  it('keeps the rules that still crash off, under each plugin namespace', () => {
    const partial = { ...RESCUED, verdict: 'partial-rescue' as const, residualRules: [{ rule: 'display-name', message: 'boom' }] };
    const text = sharedConfigSnippet(
      { config: 'eslint-config-next' },
      [
        { name: 'eslint-plugin-react', rescue: partial },
        { name: 'eslint-plugin-import', rescue: { ...partial, residualRules: [{ rule: 'unambiguous', message: 'boom' }] } },
      ],
      '10.10.0'
    );
    expect(text).toContain("      'react/display-name': 'off',\n      'import/unambiguous': 'off',\n");
  });
});
