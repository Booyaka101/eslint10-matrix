const ESC = '\u001B';

export interface Palette {
  dim: (s: string) => string;
  bold: (s: string) => string;
  red: (s: string) => string;
  yellow: (s: string) => string;
  green: (s: string) => string;
}

/** The report and the diff paint the same five things, so they share one palette. */
export function palette(enabled: boolean): Palette {
  const wrap = (code: string) => (s: string) => (enabled ? `${ESC}[${code}m${s}${ESC}[0m` : s);
  return { dim: wrap('2'), bold: wrap('1'), red: wrap('31'), yellow: wrap('33'), green: wrap('32') };
}
