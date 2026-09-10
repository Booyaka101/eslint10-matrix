export function titleCase(value) {
  return value.replace(/\b\w/g, (c) => c.toUpperCase());
}

export function byTitle(a, b) {
  return a.title.localeCompare(b.title);
}
