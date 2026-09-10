#!/usr/bin/env node
/**
 * Renders captured terminal output to a PNG for the README, so the screenshots
 * can be regenerated from a real run instead of being redrawn by hand.
 *
 *   node packages/cli/dist/index.js scan examples/react-app --color > out.ansi
 *   node scripts/terminal-shot.mjs --in out.ansi --out docs/scan-terminal.png \
 *     --prompt "npx eslint10-matrix scan" --title examples/react-app --lines 23
 *
 * Needs Chrome; pass --chrome if it is not in one of the usual install paths.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];

const FONT_SIZE = 13;
const LINE_HEIGHT = 20.15;
const CHAR_WIDTH = 7.82;

/** The only SGR codes renderReport emits. */
const SGR_CLASS = { 1: 'b', 2: 'd', 31: 'r', 32: 'g', 33: 'y' };

// Reading terminal output means matching the escape character itself.
// eslint-disable-next-line no-control-regex
const SGR = /\u001B\[(\d+)m/g;

function parseArgs(argv) {
  const opts = { lines: 0, prompt: '', chrome: '', title: 'Terminal' };
  for (let i = 0; i < argv.length; i += 1) {
    const next = () => argv[++i];
    switch (argv[i]) {
      case '--in': opts.in = next(); break;
      case '--out': opts.out = next(); break;
      case '--prompt': opts.prompt = next(); break;
      case '--title': opts.title = next(); break;
      case '--lines': opts.lines = Number(next()); break;
      case '--chrome': opts.chrome = next(); break;
      default: throw new Error(`unknown argument ${argv[i]}`);
    }
  }
  if (!opts.in || !opts.out) throw new Error('usage: terminal-shot.mjs --in <file.ansi> --out <file.png>');
  return opts;
}

function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function ansiToHtml(text) {
  let depth = 0;
  const html = escapeHtml(text).replace(SGR, (_, code) => {
    if (code === '0') {
      const close = '</span>'.repeat(depth);
      depth = 0;
      return close;
    }
    const cls = SGR_CLASS[Number(code)];
    if (!cls) return '';
    depth += 1;
    return `<span class="${cls}">`;
  });
  return html + '</span>'.repeat(depth);
}

function page(body, title, width) {
  return `<!doctype html>
<meta charset="utf-8">
<style>
  :root { color-scheme: dark }
  body { margin: 0; background: #010409; font: ${FONT_SIZE}px/${LINE_HEIGHT}px "Cascadia Mono", "SF Mono", Consolas, "DejaVu Sans Mono", monospace }
  .window { margin: 24px; width: ${width}px; border: 1px solid #30363d; border-radius: 10px; overflow: hidden; background: #0d1117; box-shadow: 0 14px 44px rgba(0, 0, 0, .6) }
  .bar { height: 34px; background: #161b22; border-bottom: 1px solid #30363d; display: flex; align-items: center; padding: 0 13px; gap: 8px }
  .dot { width: 11px; height: 11px; border-radius: 50% }
  .title { margin-left: 10px; color: #8b949e; font-size: 12px }
  pre { margin: 0; padding: 16px 20px; color: #dbe2ea; white-space: pre }
  .prompt { color: #58a6ff }
  .b { font-weight: 700 }
  .d { color: #8b949e }
  .r { color: #ff7b72 }
  .g { color: #7ee787 }
  .y { color: #e3b341 }
</style>
<div class="window">
  <div class="bar">
    <div class="dot" style="background:#ff5f57"></div>
    <div class="dot" style="background:#febc2e"></div>
    <div class="dot" style="background:#28c840"></div>
    <div class="title">${escapeHtml(title)}</div>
  </div>
  <pre>${body}</pre>
</div>
`;
}

function chromePath(preferred) {
  const found = [preferred, ...CHROME_CANDIDATES].find((p) => p && existsSync(p));
  if (!found) throw new Error('no Chrome found: pass --chrome <path>');
  return found;
}

const opts = parseArgs(process.argv.slice(2));
const raw = await readFile(resolve(opts.in), 'utf8');
let lines = raw.replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n');
while (lines[0] === '') lines.shift();

const truncated = opts.lines > 0 && lines.length > opts.lines;
if (truncated) lines = lines.slice(0, opts.lines);

const widest = Math.max(...lines.map((l) => l.replace(SGR, '').length), opts.prompt.length + 2);
const width = Math.ceil(widest * CHAR_WIDTH) + 40;

const body = [
  ...(opts.prompt ? [`<span class="prompt">$</span> ${escapeHtml(opts.prompt)}`, ''] : []),
  ...lines.map(ansiToHtml),
  ...(truncated ? ['<span class="d">... output continues</span>'] : []),
].join('\n');

const rendered = (opts.prompt ? 2 : 0) + lines.length + (truncated ? 1 : 0);
const height = Math.ceil(48 + 34 + 32 + rendered * LINE_HEIGHT);

const stage = await mkdtemp(join(tmpdir(), 'e10m-shot-'));
try {
  const html = join(stage, 'shot.html');
  await writeFile(html, page(body, opts.title, width));
  const out = resolve(opts.out);
  const code = await new Promise((done) => {
    const child = spawn(
      chromePath(opts.chrome),
      [
        '--headless=new',
        '--disable-gpu',
        '--hide-scrollbars',
        '--force-device-scale-factor=2',
        `--window-size=${width + 48},${height}`,
        `--screenshot=${out}`,
        '--virtual-time-budget=3000',
        pathToFileURL(html).href,
      ],
      { stdio: 'inherit' }
    );
    child.on('close', done);
  });
  if (code !== 0) throw new Error(`chrome exited ${code}`);
  console.log(`wrote ${out} (${(width + 48) * 2}x${height * 2})`);
} finally {
  await rm(stage, { recursive: true, force: true });
}
