/**
 * Wraps a comma-separated list under `head`, continuations indented to line up
 * under the first item. Lists of versions are the only thing here long enough to
 * need it, and they are never truncated: a list of what moved is the evidence
 * the reader came for, unlike the report's environment note, which is a footnote
 * and drops names instead.
 *
 * `width` counts the comma a line grows when something follows it, so no line
 * comes back longer than asked for.
 */
export function wrapList(head: string, items: readonly string[], width: number): string[] {
  const lines: string[] = [];
  let current = '';
  for (const item of items) {
    const next = current === '' ? head + item : `${current}, ${item}`;
    if (current !== '' && next.length + 1 > width) {
      lines.push(`${current},`);
      current = ' '.repeat(head.length) + item;
    } else current = next;
  }
  lines.push(current);
  return lines;
}
