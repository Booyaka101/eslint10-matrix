export interface VersionDelta {
  package: string;
  before: string | null;
  after: string | null;
}

/**
 * Every package the two maps disagree about, in name order. A name on one side
 * only is a disagreement: `null` means "named and not there", which is the case
 * worth reporting rather than dropping.
 */
export function versionDeltas(
  before: Readonly<Record<string, string | null>>,
  after: Readonly<Record<string, string | null>>
): VersionDelta[] {
  const names = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  return names
    .map((name) => ({ package: name, before: before[name] ?? null, after: after[name] ?? null }))
    .filter((delta) => delta.before !== delta.after)
    .sort((a, b) => a.package.localeCompare(b.package));
}

/** The shape both the diff and the report print a delta in. */
export function describeDelta(delta: VersionDelta): string {
  return `${delta.package} ${delta.before ?? '(missing)'} -> ${delta.after ?? '(missing)'}`;
}
