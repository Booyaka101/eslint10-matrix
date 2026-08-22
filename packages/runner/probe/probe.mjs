/**
 * Runs inside a freshly-installed temp directory so that bare specifiers resolve
 * against that directory's own node_modules. Reads probe-input.json, writes
 * probe-result.json, and never throws out of the top level: every failure mode is
 * a recorded phase, because the caller classifies from the file, not the exit code.
 */
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const INPUT = 'probe-input.json';
const OUTPUT = 'probe-result.json';

/**
 * Rule options fail validation and typed-linting rules refuse to start without
 * `parserOptions.project`. Both are config prerequisites, not compatibility
 * failures, so they must not count as crashes.
 */
const CONFIG_ERROR =
  /Configuration for rule|should NOT have|must NOT have|Value ".*" should be|Unexpected top-level property|Key "rules"|requires? type information|parserOptions\.project|EXPERIMENTAL_useProjectService/i;

const JS_EXTENSIONS = ['.js', '.jsx', '.mjs', '.cjs'];
const TS_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts'];

function errorInfo(err) {
  if (!(err instanceof Error)) return { message: String(err), stack: '' };
  return { message: String(err.message ?? err), stack: String(err.stack ?? '') };
}

function firstLine(text) {
  return String(text ?? '').split('\n')[0].trim().slice(0, 300);
}

/** configs.all is an object in eslintrc-style plugins and an array in flat-config ones. */
function rulesFromConfigsAll(configsAll) {
  if (!configsAll) return [];
  const entries = Array.isArray(configsAll) ? configsAll : [configsAll];
  const ids = [];
  for (const entry of entries) {
    if (entry && typeof entry === 'object' && entry.rules) ids.push(...Object.keys(entry.rules));
  }
  return ids;
}

function collectRuleNames(plugin) {
  const fromAll = rulesFromConfigsAll(plugin.configs?.all);
  const source = fromAll.length > 0 ? fromAll : Object.keys(plugin.rules ?? {});
  // configs.all namespaces ids with the plugin's own prefix; we re-namespace ourselves.
  const bare = source.map((id) => (id.includes('/') ? id.slice(id.lastIndexOf('/') + 1) : id));
  const known = plugin.rules ? new Set(Object.keys(plugin.rules)) : null;
  const usable = known ? bare.filter((id) => known.has(id)) : bare;
  return [...new Set(usable)];
}

async function listFixtures(dir) {
  const names = await readdir(dir);
  return names
    .filter((n) => [...JS_EXTENSIONS, ...TS_EXTENSIONS].some((e) => n.endsWith(e)))
    .sort()
    .map((n) => join(dir, n));
}

function isTsFile(file) {
  return TS_EXTENSIONS.some((e) => file.endsWith(e));
}

async function main() {
  const result = {
    phase: 'load',
    ok: false,
    totalRules: 0,
    crashingRules: [],
    configInvalidRules: [],
    lintedFiles: 0,
    totalMessages: 0,
    parseErrors: 0,
    tsParserLoaded: false,
    error: null,
  };

  let input;
  try {
    input = JSON.parse(await readFile(INPUT, 'utf8'));
  } catch (err) {
    result.phase = 'input';
    result.error = errorInfo(err);
    await writeFile(OUTPUT, JSON.stringify(result, null, 2));
    return;
  }

  const { specifier, namespace, settings = null, parserSpecifier = null, fixturesDir = 'fixtures' } = input;

  // --- load phase -----------------------------------------------------------
  let plugin;
  try {
    const mod = await import(specifier);
    plugin = mod.default ?? mod;
    if (plugin && typeof plugin === 'object' && plugin.default && !plugin.rules && !plugin.configs) {
      plugin = plugin.default; // double-default from transpiled CJS interop
    }
    if (!plugin || typeof plugin !== 'object') {
      throw new Error(`plugin module did not export an object (got ${typeof plugin})`);
    }
    if (!plugin.rules && !plugin.configs) {
      throw new Error('plugin module exports neither "rules" nor "configs"');
    }
  } catch (err) {
    result.error = errorInfo(err);
    await writeFile(OUTPUT, JSON.stringify(result, null, 2));
    return;
  }

  let eslintApi;
  try {
    eslintApi = await import('eslint');
  } catch (err) {
    result.phase = 'eslint-load';
    result.error = errorInfo(err);
    await writeFile(OUTPUT, JSON.stringify(result, null, 2));
    return;
  }
  const { ESLint, Linter } = eslintApi;

  // --- collect phase --------------------------------------------------------
  result.phase = 'collect';
  let ruleNames;
  try {
    ruleNames = collectRuleNames(plugin);
    result.totalRules = ruleNames.length;
  } catch (err) {
    result.error = errorInfo(err);
    await writeFile(OUTPUT, JSON.stringify(result, null, 2));
    return;
  }

  if (ruleNames.length === 0) {
    result.phase = 'done';
    result.ok = true;
    await writeFile(OUTPUT, JSON.stringify(result, null, 2));
    return;
  }

  let tsParser = null;
  if (parserSpecifier) {
    try {
      const mod = await import(parserSpecifier);
      tsParser = mod.default ?? mod;
      result.tsParserLoaded = true;
    } catch {
      tsParser = null; // TypeScript fixtures get skipped rather than reported as parse noise
    }
  }

  const files = await listFixtures(fixturesDir);
  const jsFiles = files.filter((f) => !isTsFile(f));
  const usableFiles = tsParser ? files : jsFiles;

  const rules = Object.fromEntries(ruleNames.map((id) => [`${namespace}/${id}`, 'error']));
  const common = { plugins: { [namespace]: plugin }, ...(settings ? { settings } : {}) };
  const jsLanguageOptions = {
    ecmaVersion: 'latest',
    sourceType: 'module',
    parserOptions: { ecmaFeatures: { jsx: true } },
  };

  function buildConfig(activeRules) {
    const config = [
      { ...common, files: ['**/*.{js,jsx,mjs,cjs}'], languageOptions: jsLanguageOptions, rules: activeRules },
    ];
    if (tsParser) {
      config.push({
        ...common,
        files: ['**/*.{ts,tsx,mts,cts}'],
        languageOptions: {
          parser: tsParser,
          ecmaVersion: 'latest',
          sourceType: 'module',
          parserOptions: { ecmaFeatures: { jsx: true } },
        },
        rules: activeRules,
      });
    }
    return config;
  }

  // --- fast path: every rule at once ---------------------------------------
  result.phase = 'instantiate';
  let eslint;
  try {
    eslint = new ESLint({ overrideConfigFile: true, overrideConfig: buildConfig(rules), errorOnUnmatchedPattern: false });
  } catch (err) {
    result.error = errorInfo(err);
    await writeFile(OUTPUT, JSON.stringify(result, null, 2));
    return;
  }

  result.phase = 'lint';
  let fastPathClean = false;
  try {
    const reports = await eslint.lintFiles(usableFiles);
    result.lintedFiles = reports.length;
    let fatalWithRule = 0;
    for (const report of reports) {
      result.totalMessages += report.messages.length;
      for (const message of report.messages) {
        if (!message.fatal) continue;
        if (message.ruleId) fatalWithRule += 1;
        else result.parseErrors += 1;
      }
    }
    fastPathClean = fatalWithRule === 0;
  } catch {
    fastPathClean = false; // fall through to per-rule attribution
  }

  if (fastPathClean) {
    result.phase = 'done';
    result.ok = true;
    await writeFile(OUTPUT, JSON.stringify(result, null, 2));
    return;
  }

  // --- attribution: one rule at a time -------------------------------------
  // A rule that throws aborts the whole run, so the all-rules pass can only ever
  // name the first casualty. Re-linting per rule is the only way to enumerate them.
  result.phase = 'attribute';
  const sources = new Map();
  for (const file of usableFiles) {
    try {
      sources.set(file, await readFile(file, 'utf8'));
    } catch {
      /* unreadable fixture: skip */
    }
  }

  const linter = new Linter();
  const crashed = new Map();
  const configInvalid = new Map();

  for (const id of ruleNames) {
    const qualified = `${namespace}/${id}`;
    for (const [file, code] of sources) {
      if (crashed.has(id) || configInvalid.has(id)) break;
      const single = buildConfig({ [qualified]: 'error' });
      try {
        const messages = linter.verify(code, single, file);
        const fatal = messages.find((m) => m.fatal && m.ruleId);
        if (fatal) crashed.set(id, firstLine(fatal.message));
      } catch (err) {
        const message = firstLine(err?.message ?? err);
        if (CONFIG_ERROR.test(message)) configInvalid.set(id, message);
        else crashed.set(id, message);
      }
    }
  }

  result.crashingRules = [...crashed].map(([rule, message]) => ({ rule, message }));
  result.configInvalidRules = [...configInvalid].map(([rule, message]) => ({ rule, message }));
  result.phase = 'done';
  result.ok = true;
  await writeFile(OUTPUT, JSON.stringify(result, null, 2));
}

try {
  await main();
} catch (err) {
  await writeFile(
    OUTPUT,
    JSON.stringify({ phase: 'probe-internal', ok: false, totalRules: 0, crashingRules: [], error: errorInfo(err) }, null, 2)
  ).catch(() => {});
  process.exitCode = 1;
}
