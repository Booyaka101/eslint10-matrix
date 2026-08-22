import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import process from 'node:process';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_TIMEOUT_MS = 10_000;

export function digest(input) {
  return createHash('sha256').update(input).digest('hex').slice(0, 12);
}

export async function loadJson(relativePath) {
  const full = resolve(HERE, relativePath);
  try {
    return JSON.parse(await readFile(full, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') {
      return undefined;
    }
    throw new Error(`could not read ${relativePath}: ${err.message}`, { cause: err });
  }
}

export async function fetchJson(url, { timeoutMs = DEFAULT_TIMEOUT_MS, retries = 2 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (res.status === 429) {
        const wait = Number(res.headers.get('retry-after') ?? 1) * 1000;
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} for ${url}`);
      }
      return await res.json();
    } catch (err) {
      lastError = err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError ?? new Error(`request failed: ${url}`);
}

export async function persist(name, payload) {
  const target = join(HERE, `${name}.${digest(name)}.json`);
  await writeFile(target, JSON.stringify(payload, null, 2), 'utf8');
  return pathToFileURL(target).href;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const data = await loadJson('./package.json');
  console.log(data ? digest(JSON.stringify(data)) : 'no manifest');
}
