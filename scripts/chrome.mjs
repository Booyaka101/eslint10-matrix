/** Where Chrome lives, so both screenshot scripts look in the same places. */
import { existsSync } from 'node:fs';

const CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];

export function chromePath(preferred) {
  const found = [preferred, ...CANDIDATES].find((p) => p && existsSync(p));
  if (!found) throw new Error('no Chrome found: pass --chrome <path>');
  return found;
}
