const BASE = '/api/catalogue';

export async function fetchCatalogue(query) {
  const url = query ? `${BASE}?q=${encodeURIComponent(query)}` : BASE;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`catalogue request failed: ${response.status}`);
  return response.json();
}

export function openItem(id) {
  return fetch(`${BASE}/${id}`).then((response) => response.json());
}
