// The CLI ships standalone and owns the definition of "blocked"; the site
// imports its verdict the same way. Requires the CLI to be built first, which
// `npm run build` and both workflows do.
import { regressionOnTen } from '../../cli/dist/report.js';
import type { CrashingRule, PluginRunResult, RescueResult } from './types.js';

export const COMPAT_VERSION = '2.1.0';
export const COMPAT_SPEC = `@eslint/compat@${COMPAT_VERSION}`;

/**
 * The failure signatures @eslint/compat exists to paper over: context and
 * sourceCode methods that ESLint 10 removed, plus the eslintrc-era APIs that
 * went with them. Anything else is skipped, never attempted.
 */
const REMOVED_API =
  /is not a function|is not a constructor|LegacyESLint|FlatESLint|eslintrc|getFilename|getPhysicalFilename|getScope\b|getAncestors|getDeclaredVariables|markVariableAsUsed|getSourceCode|getCwd/i;

/** Causes a rule wrapper cannot touch, matched before the removed-API check. */
const NOT_RESCUABLE: ReadonlyArray<readonly [RegExp, string]> = [
  [/cannot find (module|package)|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND/i, 'missing dependency'],
  [/unsupported engine|EBADENGINE|requires node/i, 'node engine mismatch'],
  [/failed to load parser|error while loading parser|parsing error/i, 'parser failure'],
];

export type Eligibility =
  | { kind: 'not-blocked' }
  | { kind: 'skip'; reason: string }
  | { kind: 'attempt'; newlyBroken: string[] };

/**
 * Decides whether the rescue pass runs. Clean, safe-to-force and pre-existing
 * breakage never reach it; a blocked plugin only reaches it when at least one
 * of its new failures looks like a removed context API.
 */
export function rescueEligibility(onNine: PluginRunResult | undefined, onTen: PluginRunResult): Eligibility {
  const newlyBroken = regressionOnTen(onNine, onTen);
  if (newlyBroken === null) return { kind: 'not-blocked' };

  // The reason is a short classification, not prose: the failing message it was
  // derived from is already on the row in results[v10], so echoing it here would
  // only make the field harder to group by.
  if (onTen.status === 'install-fail') {
    return { kind: 'skip', reason: 'install failure, and @eslint/compat wraps rules rather than installs' };
  }

  const messages =
    onTen.status === 'rule-crash'
      ? onTen.crashingRules.filter((r) => newlyBroken.includes(r.rule)).map((r) => r.message)
      : [onTen.detail ?? ''];

  // One rescuable crash is enough to be worth measuring: a plugin that breaks
  // both ways is what PARTIAL-RESCUE is for, so the removed-API signal is
  // checked before the causes a wrapper cannot touch.
  if (messages.some((m) => REMOVED_API.test(m))) return { kind: 'attempt', newlyBroken };

  for (const message of messages) {
    for (const [pattern, reason] of NOT_RESCUABLE) {
      if (pattern.test(message)) return { kind: 'skip', reason };
    }
  }
  return { kind: 'skip', reason: 'not a removed context API' };
}

export function skippedRescue(eslintVersion: string, reason: string): RescueResult {
  return { eslintVersion, compatVersion: COMPAT_VERSION, attempted: false, verdict: 'blocked', skipReason: reason };
}

/**
 * Turns the before/after crash counts into the measured verdict. A rule that
 * already crashed on ESLint 9 stays out of the residual set for the same
 * reason it never made the plugin BLOCKED in the first place.
 */
export function deriveRescue(
  onNine: PluginRunResult | undefined,
  onTen: PluginRunResult,
  wrapped: PluginRunResult,
  eslintVersion: string,
  newlyBroken: string[]
): RescueResult {
  const base: RescueResult = {
    eslintVersion,
    compatVersion: COMPAT_VERSION,
    attempted: true,
    verdict: 'blocked',
    crashingRulesBefore: onTen.status === 'rule-crash' ? newlyBroken.length : undefined,
  };

  if (wrapped.status === 'install-fail') {
    return { ...base, detail: `rescue probe could not install ${COMPAT_SPEC}: ${wrapped.detail ?? 'unknown'}` };
  }
  if (wrapped.status === 'load-fail') {
    const detail = wrapped.detail ?? 'unknown';
    return {
      ...base,
      fixupFunction: wrapped.fixupFunction,
      detail: detail.startsWith('@eslint/compat failed to load')
        ? detail
        : `still fails to load with @eslint/compat installed: ${detail}`,
    };
  }

  const alreadyBroken = new Set(onNine?.status === 'rule-crash' ? onNine.crashingRules.map((r) => r.rule) : []);
  const residual: CrashingRule[] = wrapped.crashingRules.filter((r) => !alreadyBroken.has(r.rule));
  const preexisting = wrapped.crashingRules.length - residual.length;
  const fixup = {
    fixupFunction: wrapped.fixupFunction ?? 'fixupPluginRules',
    ...(wrapped.fixupConfigKey ? { fixupConfigKey: wrapped.fixupConfigKey } : {}),
    ...(preexisting > 0 ? { preexistingRulesAfter: preexisting } : {}),
  } as const;

  if (residual.length === 0) {
    return { ...base, ...fixup, verdict: 'rescuable', crashingRulesAfter: 0 };
  }

  // An undefined "before" means the baseline was load-fail: nothing ran at all,
  // so loading with only residual crashes is still an improvement.
  const before = base.crashingRulesBefore;
  if (before === undefined || residual.length < before) {
    return { ...base, ...fixup, verdict: 'partial-rescue', crashingRulesAfter: residual.length, residualRules: residual };
  }

  return {
    ...base,
    ...fixup,
    crashingRulesAfter: residual.length,
    residualRules: residual,
    detail: 'the wrap did not reduce the crash count',
  };
}
