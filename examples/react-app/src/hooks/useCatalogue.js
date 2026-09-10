import { useEffect, useState } from 'react';
import { fetchCatalogue } from '../api/client.js';

export function useCatalogue(query) {
  const [state, setState] = useState({ items: [], error: null, loading: true });

  useEffect(() => {
    let live = true;
    setState((prev) => ({ ...prev, loading: true }));

    fetchCatalogue(query)
      .then((items) => {
        if (live) setState({ items, error: null, loading: false });
        return items;
      })
      .catch((error) => {
        if (live) setState({ items: [], error, loading: false });
      });

    return () => {
      live = false;
    };
  }, [query]);

  return state;
}
