import type { CrashingRule, PluginRunResult, ProbeResult } from './types.js';

/**
 * Matches `Error while loading rule 'react/display-name': ...` and the plain
 * `<ns>/<rule>` form that ESLint puts in the message of a rethrown rule error.
 */
const RULE_IN_MESSAGE = /(?:rule\s+['"`]([^'"`]+)['"`])|(?:\b([\w@][\w.-]*(?:\/[\w.-]+)+)\b)/;

/** ESLint surfaces a broken rule from inside the linter; these frames prove it. */
const RULE_FRAME = /node_modules[\\/](?:@[^\\/]+[\\/])?eslint-plugin[^\\/]*[\\/].*\.(?:js|cjs|mjs)/i;

export function ruleIdFromError(message: string, stack = ''): string | null {
  const quoted = /rule\s+['"`]([^'"`]+)['"`]/.exec(message);
  if (quoted?.[1]) return quoted[1];
  const bare = RULE_IN_MESSAGE.exec(message);
  if (bare?.[1]) return bare[1];
  if (bare?.[2] && !bare[2].includes('\\') && !bare[2].includes('.js')) return bare[2];
  if (RULE_FRAME.test(stack)) {
    const file = /rules[\\/]([\w-]+)\.(?:js|cjs|mjs)/.exec(stack);
    if (file?.[1]) return file[1];
  }
  return null;
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

  if (crashingRules.length > 0) {
    return { status: 'rule-crash', crashingRules, totalRules: probe.totalRules };
  }

  return { status: 'clean', crashingRules: [], totalRules: probe.totalRules };
}

function firstMeaningfulLine(text: string): string {
  const lines = String(text ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  const interesting = lines.find((l) => /error|cannot|failed|not a function|undefined/i.test(l));
  return truncate(interesting ?? lines[0] ?? '', 300);
}
