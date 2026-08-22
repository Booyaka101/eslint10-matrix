import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

interface Paged<T> {
  items: T[];
  cursor: string | null;
}

interface Row {
  id: string;
  name: string;
  updatedAt: string;
}

export function useDebounced<T>(value: T, delay = 250): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);

  return debounced;
}

export function useRows(query: string) {
  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const debouncedQuery = useDebounced(query);

  const load = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    try {
      const res = await fetch(`/api/rows?q=${encodeURIComponent(debouncedQuery)}`, {
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`rows request failed: ${res.status}`);
      }
      const page = (await res.json()) as Paged<Row>;
      setRows(page.items);
      setError(null);
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        setError(err as Error);
      }
    } finally {
      setLoading(false);
    }
  }, [debouncedQuery]);

  useEffect(() => {
    void load();
    return () => abortRef.current?.abort();
  }, [load]);

  const sorted = useMemo(
    () => [...rows].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [rows]
  );

  return { rows: sorted, error, loading, reload: load };
}

export function RowTable({ query }: { query: string }) {
  const { rows, error, loading } = useRows(query);

  if (error) {
    return <p role="alert">{error.message}</p>;
  }

  return (
    <table>
      <tbody>
        {loading ? (
          <tr>
            <td colSpan={2}>Loading…</td>
          </tr>
        ) : (
          rows.map((row) => (
            <tr key={row.id}>
              <td>{row.name}</td>
              <td>{new Date(row.updatedAt).toLocaleDateString()}</td>
            </tr>
          ))
        )}
      </tbody>
    </table>
  );
}
