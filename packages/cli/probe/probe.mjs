/**
 * Runs inside a freshly-installed temp directory so that bare specifiers resolve
 * against that directory's own node_modules, while the files it lints are read
 * and reported relative to `cwd`, which is the corpus fixture directory for the
 * nightly board and the caller's own repository for `scan`. Reads
 * probe-input.json, writes probe-result.json, and never throws out of the top
 * level: every failure mode is a recorded phase, because the caller classifies
 * from the file, not the exit code.
 *
 * Its scratch files sit beside this script rather than in the working
 * directory, so the caller can leave the process in the environment root. Some
 * plugins resolve their own toolchain relative to the working directory and
 * hang in a worker thread when it is somewhere else.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const INPUT = join(HERE, 'probe-input.json');
const OUTPUT = join(HERE, 'probe-result.json');

/**
 * Rule options fail validation and typed-linting rules refuse to start without
 * `parserOptions.project`. Both are config prerequisites, not compatibility
 * failures, so they must not count as crashes.
 */
const CONFIG_ERROR =
  /Configuration for rule|should NOT have|must NOT have|Value ".*" should be|Unexpected top-level property|Key "rules"|requires? type information|parserOptions\.project|EXPERIMENTAL_useProjectService/i;

const TS_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts'];

/** Enough evidence to say how widely a rule breaks without linting every file against it. */
const EVIDENCE_CAP = 25;

/**
 * Per-rule attribution is rules times files, so a large repo and a plugin with
 * hundreds of rules can outlast the caller's timeout. Stopping early reports
 * fewer rules; being killed reports none at all and reads as a load failure.
 *
 * The budget is the whole process's, not one measure() call's. A rescue probe
 * measures two wrapped candidates, and two fresh budgets plus the lint passes
 * would overrun the six-minute kill this is meant to stay under.
 */
const ATTRIBUTE_BUDGET_MS = 4 * 60_000;
const DEADLINE = Date.now() + ATTRIBUTE_BUDGET_MS;

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

function isTsFile(file) {
  return TS_EXTENSIONS.some((e) => file.endsWith(e));
}

/**
 * A flat config entry carries plugins as an object map; eslintrc-style configs
 * list plugin names as strings. That difference is the discriminator.
 */
function flatConfigEntries(configs) {
  const out = [];
  for (const [key, value] of Object.entries(configs ?? {})) {
    const entries = Array.isArray(value) ? value : [value];
    const isFlat = entries.some(
      (c) => c && typeof c === 'object' && c.plugins && !Array.isArray(c.plugins)
    );
    if (isFlat) out.push({ key, configs: entries });
  }
  return out;
}

/** Prefers the widest config so the fixupConfigRules path wraps as much as possible. */
function pickFlatConfig(entries) {
  const score = ({ key }) => (/(^|\/)all$/.test(key) ? 2 : /recommended/.test(key) ? 1 : 0);
  return [...entries].sort((a, b) => score(b) - score(a))[0] ?? null;
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
  const emit = () => writeFile(OUTPUT, JSON.stringify(result, null, 2));

  let input;
  try {
    input = JSON.parse(await readFile(INPUT, 'utf8'));
  } catch (err) {
    result.phase = 'input';
    result.error = errorInfo(err);
    await emit();
    return;
  }

  const {
    specifier,
    namespace,
    settings = null,
    parserSpecifier = null,
    cwd = process.cwd(),
    files = [],
    fixup = false,
    recordFiles = false,
  } = input;
  const baseDir = resolve(cwd);

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
    // typescript-eslint and other meta-packages export the plugin beside their
    // configs and parser rather than being one.
    if (!plugin.rules && plugin.plugin?.rules) plugin = plugin.plugin;
    if (!plugin.rules && !plugin.configs) {
      throw new Error('plugin module exports neither "rules" nor "configs"');
    }
  } catch (err) {
    result.error = errorInfo(err);
    await emit();
    return;
  }

  let eslintApi;
  try {
    eslintApi = await import('eslint');
  } catch (err) {
    result.phase = 'eslint-load';
    result.error = errorInfo(err);
    await emit();
    return;
  }
  const { ESLint, Linter } = eslintApi;

  // --- fixup candidates (rescue pass only) ----------------------------------
  // Both wrap paths are measured and the cleaner one is recorded. They differ
  // only when the config's plugin object carries rules the top-level `rules` map
  // does not, since fixupConfigRules applies the same fixupRule underneath.
  let candidates = [{ plugin }];
  if (fixup) {
    let compat;
    try {
      compat = await import('@eslint/compat');
    } catch (err) {
      result.phase = 'compat-load';
      result.error = errorInfo(err);
      await emit();
      return;
    }
    try {
      candidates = [{ plugin: compat.fixupPluginRules(plugin), fixupFunction: 'fixupPluginRules' }];
      const flat = pickFlatConfig(flatConfigEntries(plugin.configs));
      if (flat) {
        const wrappedConfigs = compat.fixupConfigRules(flat.configs);
        for (const config of wrappedConfigs) {
          const wrapped = Object.values(config?.plugins ?? {}).find((p) => p && typeof p === 'object' && p.rules);
          if (wrapped) {
            candidates.push({ plugin: wrapped, fixupFunction: 'fixupConfigRules', fixupConfigKey: flat.key });
            break;
          }
        }
      }
    } catch (err) {
      result.phase = 'compat-load';
      result.error = errorInfo(err);
      await emit();
      return;
    }
  }

  // --- collect phase --------------------------------------------------------
  result.phase = 'collect';
  let ruleNames;
  try {
    ruleNames = collectRuleNames(plugin);
    result.totalRules = ruleNames.length;
  } catch (err) {
    result.error = errorInfo(err);
    await emit();
    return;
  }

  if (ruleNames.length === 0) {
    result.phase = 'done';
    result.ok = true;
    await emit();
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

  // TypeScript sources are skipped rather than reported as parse noise when the
  // target has no parser for them.
  const usableFiles = tsParser ? files : files.filter((f) => !isTsFile(f));

  const rules = Object.fromEntries(ruleNames.map((id) => [`${namespace}/${id}`, 'error']));
  const jsLanguageOptions = {
    ecmaVersion: 'latest',
    sourceType: 'module',
    parserOptions: { ecmaFeatures: { jsx: true } },
  };

  function buildConfig(pluginObject, activeRules) {
    const common = { plugins: { [namespace]: pluginObject }, ...(settings ? { settings } : {}) };
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

  let sources = null;
  async function readSources() {
    if (sources) return sources;
    sources = new Map();
    for (const file of usableFiles) {
      try {
        sources.set(file, await readFile(isAbsolute(file) ? file : join(baseDir, file), 'utf8'));
      } catch {
        /* unreadable fixture: skip */
      }
    }
    return sources;
  }

  /**
   * The full flow for one plugin object: every rule at once, then one rule at a
   * time when that fails. A rule that throws aborts the whole run, so the
   * all-rules pass can only ever name the first casualty; re-linting per rule
   * is the only way to enumerate them.
   */
  async function measure(pluginObject) {
    const outcome = {
      phase: 'instantiate',
      fatal: null,
      crashingRules: [],
      configInvalidRules: [],
      lintedFiles: 0,
      totalMessages: 0,
      parseErrors: 0,
    };

    let eslint;
    try {
      eslint = new ESLint({
        cwd: baseDir,
        overrideConfigFile: true,
        overrideConfig: buildConfig(pluginObject, rules),
        errorOnUnmatchedPattern: false,
      });
    } catch (err) {
      outcome.fatal = errorInfo(err);
      return outcome;
    }

    outcome.phase = 'lint';
    let fastPathClean;
    try {
      const reports = await eslint.lintFiles(usableFiles);
      outcome.lintedFiles = reports.length;
      let fatalWithRule = 0;
      for (const report of reports) {
        outcome.totalMessages += report.messages.length;
        for (const message of report.messages) {
          if (!message.fatal) continue;
          if (message.ruleId) fatalWithRule += 1;
          else outcome.parseErrors += 1;
        }
      }
      fastPathClean = fatalWithRule === 0;
    } catch {
      fastPathClean = false; // fall through to per-rule attribution
    }

    if (fastPathClean) {
      outcome.phase = 'done';
      return outcome;
    }

    outcome.phase = 'attribute';
    const linter = new Linter({ cwd: baseDir });
    const crashed = new Map();
    const configInvalid = new Map();
    let truncated = false;

    const note = (id, message, file) => {
      const seen = crashed.get(id);
      if (seen) seen.files.push(file);
      else crashed.set(id, { message, files: [file] });
    };

    for (const id of ruleNames) {
      if (Date.now() > DEADLINE) {
        truncated = true;
        break;
      }
      const qualified = `${namespace}/${id}`;
      for (const [file, code] of await readSources()) {
        if (configInvalid.has(id)) break;
        // Without file evidence the first crash is the whole answer; with it the
        // rule keeps going, up to the cap, so the report can say how much of the
        // repo it breaks.
        const seen = crashed.get(id);
        if (seen && (!recordFiles || seen.files.length >= EVIDENCE_CAP)) break;
        const single = buildConfig(pluginObject, { [qualified]: 'error' });
        try {
          const messages = linter.verify(code, single, file);
          const fatal = messages.find((m) => m.fatal && m.ruleId);
          if (fatal) note(id, firstLine(fatal.message), file);
        } catch (err) {
          const message = firstLine(err?.message ?? err);
          if (CONFIG_ERROR.test(message)) configInvalid.set(id, message);
          else note(id, message, file);
        }
      }
    }

    outcome.crashingRules = [...crashed].map(([rule, { message, files }]) => ({
      rule,
      message,
      ...(recordFiles
        ? {
            file: files[0],
            fileCount: files.length,
            ...(files.length >= EVIDENCE_CAP ? { fileCountCapped: true } : {}),
          }
        : {}),
    }));
    outcome.configInvalidRules = [...configInvalid].map(([rule, message]) => ({ rule, message }));
    if (truncated && crashed.size === 0) {
      outcome.fatal = {
        message: `the all-rules pass crashed, but naming the rule ran out of time after ${ATTRIBUTE_BUDGET_MS / 1000}s over ${ruleNames.length} rules and ${usableFiles.length} files`,
        stack: '',
      };
      return outcome;
    }
    outcome.phase = 'done';
    return outcome;
  }

  const badness = (o) => (o.fatal ? Number.MAX_SAFE_INTEGER : o.crashingRules.length);
  let best = null;
  let bestCandidate = null;
  for (const candidate of candidates) {
    // Reporting the first candidate's measurement beats starting a second one
    // with no time left and being killed with nothing written.
    if (best && Date.now() > DEADLINE) break;
    const outcome = await measure(candidate.plugin);
    if (!best || badness(outcome) < badness(best)) {
      best = outcome;
      bestCandidate = candidate;
    }
    if (badness(best) === 0) break;
  }

  result.phase = best.phase;
  result.lintedFiles = best.lintedFiles;
  result.totalMessages = best.totalMessages;
  result.parseErrors = best.parseErrors;
  if (bestCandidate.fixupFunction) {
    result.fixupFunction = bestCandidate.fixupFunction;
    if (bestCandidate.fixupConfigKey) result.fixupConfigKey = bestCandidate.fixupConfigKey;
  }
  if (best.fatal) {
    result.error = best.fatal;
    await emit();
    return;
  }
  result.crashingRules = best.crashingRules;
  result.configInvalidRules = best.configInvalidRules;
  result.ok = true;
  await emit();
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
