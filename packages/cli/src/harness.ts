import type { CrashingRule, HarnessFinding, HarnessRule, PluginRunResult } from './matrix.js';

/**
 * The fifth status exists because the first four can only ever say something
 * about the plugin. Two rows reached the published board saying a plugin was
 * broken when what was broken was the environment we measured it in: a rule
 * reading a version out of a package we never installed (issue #11), and rules
 * reading AST fields espree never produces, because the plugin's own parser was
 * wired up for TypeScript files only (issue #10).
 *
 * Both reproduced identically on ESLint 9 and ESLint 10, which is the tell, and
 * which is why the gate in `partitionHarness` is what it is.
 */
export interface HarnessContext {
  /** The package under test. Named in every suggested fix. */
  plugin: string;
  /**
   * The probe's own "cite the file each rule crashed on" flag, on for `scan`
   * and off for the fixture corpus. That is exactly the distinction between
   * "the linted files are the caller's" and "they are ours", so the
   * corpus-unparsed detector and the wording of every fix read it rather than
   * carry a second boolean that is its negation.
   */
  recordFiles: boolean;
}

/** `Unable to detect Jest version - please ensure jest package is installed` */
const DETECT_VERSION = /unable to detect ([\w@./-]+) version/i;
const ENSURE_INSTALLED = /ensure\s+(.{0,40}?)\s*(?:package|module) is installed/i;
/** ESM says "package" and CJS says "module"; ERR_MODULE_NOT_FOUND accompanies the former. */
const MISSING_MODULE = /cannot find (?:module|package) ['"]([^'"]+)['"]/i;
const MODULE_NOT_FOUND = /ERR_MODULE_NOT_FOUND/;

const PARSER_LOAD_FAILED = /failed to load parser|error while loading parser/i;

const MISSING_FIELD = /cannot read propert(?:y|ies) of (?:undefined|null)/i;
const NOT_A_FUNCTION = /([\w().]+)\.\w+ is not a function/;
/**
 * `context.getScope`, `sourceCode.isSpaceBetweenTokens`: the methods ESLint 9
 * and 10 deleted. They read exactly like a rule reaching for an AST field that
 * is not there, and they are the opposite thing: the plugin calling an API that
 * used to exist, which is the plugin's problem and the one `fixupPluginRules`
 * rescues. Every `is not a function` crash on the published board so far has
 * been one of these, including eslint-plugin-node's, which fails this way on
 * both majors and so would sail through the gate below.
 */
const ESLINT_API_RECEIVER = /context|sourcecode/i;

/** True only for a missing method on something that is not an ESLint API object. */
function astMethodMissing(message: string): boolean {
  const receiver = NOT_A_FUNCTION.exec(message)?.[1];
  return receiver !== undefined && !ESLINT_API_RECEIVER.test(receiver);
}

/** The corpus is ours to repair; a repo scanned by `scan` is the caller's. */
function fixIn(ctx: HarnessContext, corpusFix: string, scanFix: string): string {
  return ctx.recordFiles ? scanFix : corpusFix;
}

function missingPeer(name: string, ctx: HarnessContext): HarnessFinding {
  return {
    cause: 'missing-peer',
    subject: name,
    detail: `the rule reads ${name} at load time and it is not installed alongside ${ctx.plugin}`,
    fix: fixIn(
      ctx,
      `add "${name}" to extraDeps for ${ctx.plugin} in packages/runner/src/plugins.json`,
      `install ${name} here, so the probe measures ${ctx.plugin} the way this repo runs it`
    ),
  };
}

/** A plugin that cannot find its own files has a genuine load failure, not our environment. */
function isOwnModule(module: string, plugin: string): boolean {
  return module === plugin || module.startsWith(`${plugin}/`);
}

function detectMissingPeer(message: string, ctx: HarnessContext): HarnessFinding | null {
  const ensured = ENSURE_INSTALLED.exec(message)?.[1]?.trim();
  if (ensured) return missingPeer(ensured, ctx);

  const detected = DETECT_VERSION.exec(message)?.[1];
  if (detected) return missingPeer(detected.toLowerCase(), ctx);

  if (!MISSING_MODULE.test(message) && !MODULE_NOT_FOUND.test(message)) return null;
  // Naming the package is not optional: a fix nobody can act on is worse than
  // leaving the crash where the reader can at least see it.
  const module = MISSING_MODULE.exec(message)?.[1];
  if (!module || isOwnModule(module, ctx.plugin)) return null;
  return missingPeer(module, ctx);
}

function detectParserUnavailable(
  message: string,
  result: PluginRunResult,
  ctx: HarnessContext
): HarnessFinding | null {
  const askedAndMissing = result.parserRequested === true && result.parserLoaded === false;
  if (!askedAndMissing && !PARSER_LOAD_FAILED.test(message)) return null;
  return {
    cause: 'parser-unavailable',
    subject: ctx.plugin,
    detail: 'the run asked for a parser and did not get one, so every file was parsed by the wrong one',
    fix: fixIn(
      ctx,
      `repair the "parser" field for ${ctx.plugin} in packages/runner/src/plugins.json`,
      `install the parser ${ctx.plugin} needs, or point this repo's config at one that loads`
    ),
  };
}

function detectAstShape(message: string, ctx: HarnessContext): HarnessFinding | null {
  if (!MISSING_FIELD.test(message) && !astMethodMissing(message)) return null;
  return {
    cause: 'ast-shape',
    subject: ctx.plugin,
    detail: 'the rule read an AST field the parser never produced',
    fix: fixIn(
      ctx,
      `${ctx.plugin} likely needs a non-espree "parser" in packages/runner/src/plugins.json`,
      `${ctx.plugin} likely needs a non-espree parser in this repo's config`
    ),
  };
}

/**
 * Only when *nothing* parsed. A corpus that is partly unreadable still measured
 * the rules on everything else, and that is the common case: eslint-plugin-vue
 * leaves two fixtures unparsed on every run and is clean on both majors, so a
 * threshold of "any parse error" would void a real ESLint 10 crash the first
 * time that plugin had one.
 */
function detectCorpusUnparsed(result: PluginRunResult, ctx: HarnessContext): HarnessFinding | null {
  const parseErrors = result.parseErrors ?? 0;
  const lintedFiles = result.lintedFiles ?? 0;
  if (ctx.recordFiles || parseErrors === 0 || lintedFiles === 0 || parseErrors < lintedFiles) return null;
  return {
    cause: 'corpus-unparsed',
    subject: 'packages/runner/fixtures',
    detail: `none of the ${lintedFiles} fixture ${lintedFiles === 1 ? 'file' : 'files'} parsed, so the rules never saw the code they were measured on`,
    fix: `the fixture corpus does not parse under this parser: fix packages/runner/fixtures, or the "parser" field for ${ctx.plugin}`,
  };
}

/**
 * Most specific cause wins. A named missing package beats "the parser is gone",
 * which beats "a field was missing", which beats "nothing parsed at all",
 * because that is also the order in which the fixes get vaguer.
 */
export function detectHarness(
  message: string,
  result: PluginRunResult,
  ctx: HarnessContext
): HarnessFinding | null {
  return (
    detectMissingPeer(message, ctx) ??
    detectParserUnavailable(message, result, ctx) ??
    detectAstShape(message, ctx) ??
    detectCorpusUnparsed(result, ctx)
  );
}

function findingsFor(result: PluginRunResult | undefined, ctx: HarnessContext): Map<string, HarnessFinding> {
  const found = new Map<string, HarnessFinding>();
  if (!result || result.status !== 'rule-crash') return found;
  for (const rule of result.crashingRules) {
    const finding = detectHarness(rule.message, result, ctx);
    if (finding) found.set(rule.rule, finding);
  }
  return found;
}

/**
 * THE GATE. A crash that appears only on ESLint 10 is an ESLint 10 finding
 * whatever its message looks like, so a rule is attributed to the harness only
 * when both majors crash it for the same cause. `eslint-plugin-react`'s
 * `contextOrFilename.getFilename is not a function` matches the ast-shape
 * pattern exactly and has to stay a crash, because ESLint 9 runs it fine.
 *
 * parser-unavailable is the one exception, and it is one by construction rather
 * than by choice: the run it came from had no parser, so nothing it measured
 * says anything about either ESLint version.
 */
function agreed(finding: HarnessFinding, rule: string, other: Map<string, HarnessFinding>): boolean {
  return finding.cause === 'parser-unavailable' || other.get(rule)?.cause === finding.cause;
}

function agreeingRules(own: Map<string, HarnessFinding>, other: Map<string, HarnessFinding>): Set<string> {
  return new Set([...own].filter(([rule, finding]) => agreed(finding, rule, other)).map(([rule]) => rule));
}

function split(result: PluginRunResult, found: Map<string, HarnessFinding>, keep: Set<string>): PluginRunResult {
  const rules: HarnessRule[] = [];
  const crashingRules: CrashingRule[] = [];
  for (const rule of result.crashingRules) {
    const finding = keep.has(rule.rule) ? found.get(rule.rule) : undefined;
    if (finding) rules.push({ ...rule, ...finding });
    else crashingRules.push(rule);
  }
  if (rules.length === 0) return result;
  return {
    ...result,
    // Nothing the plugin did broke this run, so it came through clean. The pair
    // is only called a misconfiguration once both majors agree, below.
    status: crashingRules.length === 0 ? 'clean' : result.status,
    crashingRules,
    harness: { rules },
  };
}

export interface Partitioned {
  onNine: PluginRunResult | undefined;
  onTen: PluginRunResult;
}

/**
 * Moves harness-attributed rules off both results, and calls the pair a
 * misconfiguration only when neither major has a crash left that belongs to the
 * plugin. A row that keeps one real crash stays a `rule-crash` with the
 * excluded rules recorded beside it.
 */
export function partitionHarness(
  onNine: PluginRunResult | undefined,
  onTen: PluginRunResult,
  ctx: HarnessContext
): Partitioned {
  const nine = findingsFor(onNine, ctx);
  const ten = findingsFor(onTen, ctx);
  if (nine.size === 0 && ten.size === 0) return { onNine, onTen };

  const keptNine = agreeingRules(nine, ten);
  const keptTen = agreeingRules(ten, nine);
  if (keptNine.size === 0 && keptTen.size === 0) return { onNine, onTen };

  const splitNine = onNine ? split(onNine, nine, keptNine) : undefined;
  const splitTen = split(onTen, ten, keptTen);

  const bothMisconfigured =
    splitNine !== undefined &&
    splitNine.harness !== undefined &&
    splitNine.crashingRules.length === 0 &&
    splitTen.harness !== undefined &&
    splitTen.crashingRules.length === 0;

  if (!bothMisconfigured) return { onNine: splitNine, onTen: splitTen };
  return {
    onNine: { ...splitNine, status: 'harness-misconfig' },
    onTen: { ...splitTen, status: 'harness-misconfig' },
  };
}
