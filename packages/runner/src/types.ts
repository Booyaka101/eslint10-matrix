export type {
  CrashingRule,
  FixupFunction,
  Matrix,
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
}
