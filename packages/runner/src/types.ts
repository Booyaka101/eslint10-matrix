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
  /** Set on rescue-pass results: which @eslint/compat function produced this run. */
  fixupFunction?: FixupFunction;
  /** Set when fixupConfigRules was used: the plugin config key it wrapped. */
  fixupConfigKey?: string;
}

export type FixupFunction = 'fixupPluginRules' | 'fixupConfigRules';

export type RescueVerdict = 'rescuable' | 'partial-rescue' | 'blocked';

/**
 * Outcome of re-running a BLOCKED plugin with its rules wrapped by
 * @eslint/compat. Only ever present on rows whose plain v10 run is a
 * regression; a wrap that would be a no-op is never attempted or recorded.
 */
export interface RescueResult {
  eslintVersion: string;
  compatVersion: string;
  attempted: boolean;
  verdict: RescueVerdict;
  /** Why the rescue pass did not run (cause is not a removed context API). */
  skipReason?: string;
  fixupFunction?: FixupFunction;
  fixupConfigKey?: string;
  crashingRulesBefore?: number;
  crashingRulesAfter?: number;
  /** Rules that still crash under the wrap; the user must disable these. */
  residualRules?: CrashingRule[];
  /**
   * Rules still crashing under the wrap that already crashed on ESLint 9. They
   * never counted towards the verdict, but a reader pasting the snippet will
   * still meet them, so the report says so rather than claiming a clean run.
   */
  preexistingRulesAfter?: number;
  /** Set when the rescue probe itself failed (for example compat did not install). */
  detail?: string;
}

export interface PluginRow {
  name: string;
  version: string | null;
  declaredPeerRange: string | null;
  weeklyDownloads: number;
  results: Record<string, PluginRunResult>;
  rescue?: RescueResult;
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
  phase:
    | 'input'
    | 'load'
    | 'eslint-load'
    | 'compat-load'
    | 'collect'
    | 'instantiate'
    | 'lint'
    | 'attribute'
    | 'done'
    | 'probe-internal';
  ok: boolean;
  totalRules: number;
  crashingRules: CrashingRule[];
  configInvalidRules?: CrashingRule[];
  lintedFiles?: number;
  totalMessages?: number;
  parseErrors?: number;
  tsParserLoaded?: boolean;
  fixupFunction?: FixupFunction;
  fixupConfigKey?: string;
  error?: { message: string; stack: string } | null;
}

