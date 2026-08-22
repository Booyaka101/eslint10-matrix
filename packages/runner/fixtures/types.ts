export type Status = 'clean' | 'rule-crash' | 'load-fail' | 'install-fail';

export interface CrashingRule {
  rule: string;
  message: string;
}

export interface PluginResult {
  status: Status;
  crashingRules: CrashingRule[];
  totalRules: number;
}

type Awaitable<T> = T | Promise<T>;

export class Registry<T extends { id: string }> {
  readonly #items = new Map<string, T>();

  add(item: T): this {
    if (this.#items.has(item.id)) {
      throw new Error(`duplicate id: ${item.id}`);
    }
    this.#items.set(item.id, item);
    return this;
  }

  get(id: string): T | undefined {
    return this.#items.get(id);
  }

  get size(): number {
    return this.#items.size;
  }

  *[Symbol.iterator](): IterableIterator<T> {
    yield* this.#items.values();
  }
}

export function isCrash(result: PluginResult): boolean {
  return result.status === 'rule-crash' || result.status === 'load-fail';
}

export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Awaitable<R>
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      out[index] = await fn(items[index]!, index);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker())
  );
  return out;
}

export function summarise(results: ReadonlyMap<string, PluginResult>): Record<Status, number> {
  const tally: Record<Status, number> = {
    clean: 0,
    'rule-crash': 0,
    'load-fail': 0,
    'install-fail': 0,
  };
  for (const result of results.values()) {
    tally[result.status] += 1;
  }
  return tally;
}
