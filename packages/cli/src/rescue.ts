import type { CrashingRule, PluginRunResult, RescueResult } from './matrix.js';
import { regressionOnTen } from './report.js';

export const COMPAT_VERSION = '2.1.1';
export const COMPAT_SPEC = `@eslint/compat@${COMPAT_VERSION}`;

/** Causes a rule wrapper cannot touch: nothing else is guessed at. */
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
 * breakage never reach it. Everything else does: whether the wrap helps is
 * measured, not predicted from the message text. Reading the message was wrong
 * for eslint-plugin-import, whose "Cannot use 'in' operator to search for
 * 'sourceType' in undefined" does not look like a removed context API and is
 * fixed by fixupPluginRules anyway.
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

  // A plugin that breaks both ways is what PARTIAL-RESCUE is for, so the pass is
  // skipped only when every new failure has a cause a wrapper cannot touch.
  const reasons = messages.map((message) => {
    const match = NOT_RESCUABLE.find(([pattern]) => pattern.test(message));
    return match?.[1] ?? null;
  });
  const blocking = reasons.find((reason) => reason !== null);
  if (blocking && reasons.every((reason) => reason !== null)) return { kind: 'skip', reason: blocking };

  return { kind: 'attempt', newlyBroken };
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
