import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchCatalogue } from './client.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(response) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
}

describe('fetchCatalogue', () => {
  it('returns the parsed body', async () => {
    stubFetch({ ok: true, json: () => Promise.resolve([{ id: 1 }]) });
    await expect(fetchCatalogue()).resolves.toEqual([{ id: 1 }]);
  });

  it('throws on a non-ok response', async () => {
    stubFetch({ ok: false, status: 503 });
    await expect(fetchCatalogue('chair')).rejects.toThrow('catalogue request failed: 503');
  });
});
