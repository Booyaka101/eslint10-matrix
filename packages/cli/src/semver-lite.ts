/**
 * Just enough range evaluation to answer "does this declared peer range admit
 * the ESLint version we executed against". The published CLI ships no runtime
 * dependencies, so semver is not available.
 */

export interface Parsed {
  major: number;
  minor: number;
  patch: number;
  prerelease: string;
}

export function parseVersion(version: string): Parsed | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(version).trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? '',
  };
}

function compare(a: Parsed, b: Parsed): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  if (a.prerelease === b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  return a.prerelease < b.prerelease ? -1 : 1;
}

/** Expands a partial version like "9" or "9.7" to a comparable triple. */
function pad(part: string): Parsed | null {
  const cleaned = part.replace(/^[v=]+/, '').replace(/\.[xX*]/g, '').trim();
  if (cleaned === '' || cleaned === '*') return null;
  const bits = cleaned.split('-')[0]!.split('.');
  const nums = bits.map((b) => (/^\d+$/.test(b) ? Number(b) : Number.NaN));
  if (nums.length === 0 || Number.isNaN(nums[0])) return null;
  return {
    major: nums[0]!,
    minor: Number.isNaN(nums[1]!) || nums[1] === undefined ? 0 : nums[1]!,
    patch: Number.isNaN(nums[2]!) || nums[2] === undefined ? 0 : nums[2]!,
    prerelease: cleaned.includes('-') ? cleaned.slice(cleaned.indexOf('-') + 1) : '',
  };
}

function satisfiesComparator(target: Parsed, raw: string): boolean {
  const token = raw.trim();
  if (token === '' || token === '*' || token === 'x' || token === 'X' || token === 'latest') return true;

  const operatorMatch = /^(\^|~|>=|<=|>|<|=)?\s*(.+)$/.exec(token);
  if (!operatorMatch) return false;
  const operator = operatorMatch[1] ?? '=';
  const operand = operatorMatch[2]!.trim();

  const base = pad(operand);
  if (!base) return true; // "^*" and friends admit anything

  switch (operator) {
    case '^': {
      // ^0.x pins the minor; every plugin range we read here is ^1 or above.
      if (base.major === 0 && operand.split('.').length > 1) {
        return target.major === 0 && target.minor === base.minor && compare(target, base) >= 0;
      }
      return target.major === base.major && compare(target, base) >= 0;
    }
    case '~': {
      const pinnedMinor = operand.replace(/^[v=]+/, '').split('.').length > 1;
      if (pinnedMinor) return target.major === base.major && target.minor === base.minor && compare(target, base) >= 0;
      return target.major === base.major;
    }
    case '>=':
      return compare(target, base) >= 0;
    case '>':
      return compare(target, base) > 0;
    case '<=':
      return compare(target, base) <= 0;
    case '<':
      return compare(target, base) < 0;
    default: {
      const explicitParts = operand.replace(/^[v=]+/, '').split('.').filter((p) => !/^[xX*]$/.test(p)).length;
      if (explicitParts === 1) return target.major === base.major;
      if (explicitParts === 2) return target.major === base.major && target.minor === base.minor;
      return compare(target, base) === 0;
    }
  }
}

/** Returns true when `version` satisfies at least one `||` alternative of `range`. */
export function satisfies(version: string, range: string | null | undefined): boolean {
  if (range === null || range === undefined) return false;
  const target = parseVersion(version);
  if (!target) return false;
  const trimmed = range.trim();
  if (trimmed === '' || trimmed === '*') return true;

  return trimmed.split('||').some((alternative) => {
    const comparators = alternative.trim().split(/\s+/).filter(Boolean);
    if (comparators.length === 0) return false;
    return comparators.every((c) => satisfiesComparator(target, c));
  });
}
