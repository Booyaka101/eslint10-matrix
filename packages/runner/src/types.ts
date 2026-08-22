export const SCHEMA_VERSION = 1;

export type Status = 'clean' | 'rule-crash' | 'load-fail' | 'install-fail';

export interface CrashingRule {
  rule: string;
  message: string;
}

export interface PluginRunResult {
  status: Status;
  crashingRules: CrashingRule[];
  totalRules: number;
  /** Populated for install-fail and load-fail so the site can show why. */
  detail?: string;
}

export interface PluginRow {
  name: string;
  version: string | null;
  declaredPeerRange: string | null;
  weeklyDownloads: number;
  results: Record<string, PluginRunResult>;
}

export interface Matrix {
  schemaVersion: number;
  generatedAt: string;
  eslintVersions: { v9: string; v10: string };
  plugins: PluginRow[];
}

export interface PluginSpec {
  name: string;
  weeklyDownloads: number;
  namespace?: string;
  settings?: Record<string, unknown>;
  parser?: string;
  extraDeps?: string[];
}

/** Raw shape written by probe/probe.mjs. */
export interface ProbeResult {
  phase: 'input' | 'load' | 'eslint-load' | 'collect' | 'instantiate' | 'lint' | 'attribute' | 'done' | 'probe-internal';
  ok: boolean;
  totalRules: number;
  crashingRules: CrashingRule[];
  configInvalidRules?: CrashingRule[];
  lintedFiles?: number;
  totalMessages?: number;
  parseErrors?: number;
  tsParserLoaded?: boolean;
  error?: { message: string; stack: string } | null;
}

/**
 * ESLint's own convention: eslint-plugin-x is referenced as `x`,
 * @scope/eslint-plugin as `@scope`, @scope/eslint-plugin-x as `@scope/x`.
 */
export function namespaceFor(packageName: string): string {
  if (packageName.startsWith('@')) {
    const slash = packageName.indexOf('/');
    const scope = packageName.slice(0, slash);
    const rest = packageName.slice(slash + 1);
    if (rest === 'eslint-plugin') return scope;
    if (rest.startsWith('eslint-plugin-')) return `${scope}/${rest.slice('eslint-plugin-'.length)}`;
    return `${scope}/${rest}`;
  }
  return packageName.startsWith('eslint-plugin-')
    ? packageName.slice('eslint-plugin-'.length)
    : packageName;
}
