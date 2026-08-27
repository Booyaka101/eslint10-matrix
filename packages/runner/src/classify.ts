import type { CrashingRule, PluginRunResult, ProbeResult } from './types.js';

/** `Error while loading rule 'react/display-name': ...` */
const QUOTED_RULE = /rule\s+['"`]([^'"`]+)['"`]/;

/** A bare `ns/rule` or `@scope/ns/rule` mentioned in a rethrown rule error. */
const RULE_TOKEN = /\b([\w@][\w.-]*(?:\/[\w.-]+)+)\b/;

/** Distinguishes a rule id from a module path, which matches RULE_TOKEN just as well. */
const MODULE_FILE = /\.(?:[cm]?js|[cm]?ts)$/i;

/** Last resort: the plugin's own rule file, named in a stack frame. */
const RULE_FILE_IN_STACK =
  /node_modules[\\/](?:@[^\\/]+[\\/])?eslint-plugin[^\\/]*[\\/](?:.*[\\/])?rules[\\/]([\w-]+)\.[cm]?js/i;

export function ruleIdFromError(message: string, stack = ''): string | null {
  const quoted = QUOTED_RULE.exec(message)?.[1];
  if (quoted) return quoted;

  const token = RULE_TOKEN.exec(message)?.[1];
  if (token && !token.includes('\\') && !MODULE_FILE.test(token)) return token;

  return RULE_FILE_IN_STACK.exec(stack)?.[1] ?? null;
}

function stripNamespace(ruleId: string): string {
  const slash = ruleId.lastIndexOf('/');
  return slash === -1 ? ruleId : ruleId.slice(slash + 1);
}

export function installFail(detail: string): PluginRunResult {
  return { status: 'install-fail', crashingRules: [], totalRules: 0, detail: truncate(detail) };
}

export function loadFail(detail: string, totalRules = 0): PluginRunResult {
  return { status: 'load-fail', crashingRules: [], totalRules, detail: truncate(detail) };
}

function truncate(text: string, max = 400): string {
  const line = String(text ?? '').split('\n').map((l) => l.trim()).filter(Boolean).join(' ');
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/**
 * Ordinary lint errors are the expected output of enabling every rule, so volume
 * of reports never affects the verdict. Only a failure to load the module and a
 * rule that throws or emits a fatal message count against a plugin.
 */
export function classify(probe: ProbeResult | null, childStderr = ''): PluginRunResult {
  if (!probe) {
    const ruleId = ruleIdFromError(childStderr, childStderr);
    if (ruleId) {
      return {
        status: 'rule-crash',
        crashingRules: [{ rule: stripNamespace(ruleId), message: truncate(firstMeaningfulLine(childStderr), 300) }],
        totalRules: 0,
        detail: 'probe produced no result file',
      };
    }
    return loadFail(firstMeaningfulLine(childStderr) || 'probe produced no result file');
  }

  if (probe.phase === 'load' || probe.phase === 'eslint-load' || probe.phase === 'input' || probe.phase === 'probe-internal') {
    return loadFail(probe.error?.message ?? `probe failed during ${probe.phase}`, probe.totalRules);
  }

  if (probe.phase === 'compat-load') {
    return loadFail(`@eslint/compat failed to load: ${probe.error?.message ?? 'unknown'}`, probe.totalRules);
  }

  if (probe.phase === 'instantiate' || probe.phase === 'collect') {
    const message = probe.error?.message ?? '';
    const ruleId = ruleIdFromError(message, probe.error?.stack ?? '');
    if (ruleId) {
      return {
        status: 'rule-crash',
        crashingRules: [{ rule: stripNamespace(ruleId), message: truncate(message, 300) }],
        totalRules: probe.totalRules,
      };
    }
    return loadFail(message || `probe failed during ${probe.phase}`, probe.totalRules);
  }

  if (!probe.ok) {
    return loadFail(probe.error?.message ?? `probe stopped during ${probe.phase}`, probe.totalRules);
  }

  const crashingRules: CrashingRule[] = (probe.crashingRules ?? []).map((entry) => ({
    rule: stripNamespace(entry.rule),
    message: truncate(entry.message, 300),
  }));

  const fixup = probe.fixupFunction
    ? { fixupFunction: probe.fixupFunction, ...(probe.fixupConfigKey ? { fixupConfigKey: probe.fixupConfigKey } : {}) }
    : {};

  if (crashingRules.length > 0) {
    return { status: 'rule-crash', crashingRules, totalRules: probe.totalRules, ...fixup };
  }

  return { status: 'clean', crashingRules: [], totalRules: probe.totalRules, ...fixup };
}

function firstMeaningfulLine(text: string): string {
  const lines = String(text ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  const interesting = lines.find((l) => /error|cannot|failed|not a function|undefined/i.test(l));
  return truncate(interesting ?? lines[0] ?? '', 300);
}
