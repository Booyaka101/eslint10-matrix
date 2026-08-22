const REGISTRY = 'https://registry.npmjs.org';

export interface PackageFacts {
  version: string | null;
  peerRange: string | null;
  error?: string;
}

async function getJson(url: string, timeoutMs = 20_000): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } });
    if (res.status === 429) {
      const wait = Number(res.headers.get('retry-after') ?? 2) * 1000;
      await new Promise((r) => setTimeout(r, wait));
      throw new Error('rate limited by registry, retry scheduled');
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 500 * 2 ** i));
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

export async function packageFacts(name: string): Promise<PackageFacts> {
  try {
    const doc = (await withRetry(() => getJson(`${REGISTRY}/${encodeURIComponent(name).replace('%40', '@')}/latest`))) as {
      version?: string;
      peerDependencies?: Record<string, string>;
    };
    return { version: doc.version ?? null, peerRange: doc.peerDependencies?.eslint ?? null };
  } catch (err) {
    return { version: null, peerRange: null, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function eslintDistTags(): Promise<{ v9: string; v10: string }> {
  const doc = (await withRetry(() => getJson(`${REGISTRY}/eslint`))) as {
    'dist-tags'?: Record<string, string>;
    versions?: Record<string, unknown>;
  };
  const tags = doc['dist-tags'] ?? {};
  const versions = Object.keys(doc.versions ?? {});

  const latest = tags.latest;
  if (!latest) throw new Error('npm registry returned no dist-tags.latest for eslint');

  const v10 = latest.startsWith('10.') ? latest : highest(versions, '10.');
  const maintenance = tags.maintenance;
  const v9 = maintenance?.startsWith('9.') ? maintenance : highest(versions, '9.');

  if (!v9) throw new Error('could not determine an eslint 9.x version from the registry');
  if (!v10) throw new Error('could not determine an eslint 10.x version from the registry');
  return { v9, v10 };
}

function highest(versions: string[], prefix: string): string | null {
  const matching = versions.filter((v) => v.startsWith(prefix) && !v.includes('-'));
  if (matching.length === 0) return null;
  return matching.sort(compareSemver).at(-1) ?? null;
}

function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
