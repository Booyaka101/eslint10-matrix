export type {
  CrashingRule,
  FixupFunction,
  HarnessCause,
  HarnessFinding,
  HarnessReport,
  HarnessRule,
  Matrix,
  MeasuredEnv,
  PluginRow,
  PluginRunResult,
  RescueResult,
  RescueVerdict,
  Status,
} from '../../cli/dist/matrix.js';
export type { ProbeResult } from '../../cli/dist/classify.js';

export const SCHEMA_VERSION = 1;

/** One row of the corpus board's plugin list, as written in src/plugins.json. */
export interface PluginSpec {
  name: string;
  weeklyDownloads: number;
  namespace?: string;
  settings?: Record<string, unknown>;
  parser?: string;
  extraDeps?: string[];
  /** Extensions only this plugin's parser can read, added to its copy of the corpus. */
  corpusExtensions?: string[];
}
