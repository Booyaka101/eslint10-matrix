#!/usr/bin/env node
/**
 * Screenshots a region of the built site, so the README's site images can be
 * regenerated from a real board instead of being recaptured by hand.
 *
 *   node site/build.mjs --in matrix.json --out /tmp/site
 *   node scripts/site-shot.mjs --in /tmp/site/index.html --out docs/rescuable-tier.png \
 *     --click "button[data-filter=rescuable]" --clip "table"
 *
 * Needs Chrome; pass --chrome if it is not in one of the usual install paths.
 */
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseFlags } from './args.mjs';
import { chromePath } from './chrome.mjs';

const VIEWPORT = { width: 1280, height: 2400 };
const SCALE = 2;
const PAD = 16;

const USAGE =
  'usage: site-shot.mjs --in <index.html> --out <file.png> --clip <selector>... [--click <selector>...]';

const FLAGS = {
  '--in': 'string',
  '--out': 'string',
  '--click': 'list',
  '--clip': 'list',
  '--chrome': 'string',
  '--port': 'number',
};

function parseArgs(argv) {
  // Ports are per-process so two shots can render at once without colliding.
  const opts = parseFlags(argv, FLAGS, USAGE, { port: 9222 + (process.pid % 900) });
  if (!opts.in || !opts.out || opts.clip.length === 0) throw new Error(USAGE);
  return opts;
}

/** Chrome needs a moment to open its debugging port, and says so when it has. */
async function debuggerUrl(port, deadline = Date.now() + 15_000) {
  for (;;) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const target = (await response.json()).find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (target) return target.webSocketDebuggerUrl;
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) throw new Error(`chrome never opened a debugging port on ${port}`);
    await new Promise((done) => setTimeout(done, 100));
  }
}

function connect(url) {
  const socket = new WebSocket(url);
  const pending = new Map();
  let nextId = 0;
  const open = new Promise((done, fail) => {
    socket.addEventListener('open', () => done());
    socket.addEventListener('error', () => fail(new Error('devtools socket failed')));
  });
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    const waiting = pending.get(message.id);
    if (!waiting) return;
    pending.delete(message.id);
    if (message.error) waiting.fail(new Error(message.error.message));
    else waiting.done(message.result);
  });
  return {
    async send(method, params = {}) {
      await open;
      const id = (nextId += 1);
      return new Promise((done, fail) => {
        pending.set(id, { done, fail });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close: () => socket.close(),
  };
}

/** Runs an expression in the page and returns whatever it evaluated to. */
async function evaluate(cdp, expression) {
  const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? 'page threw');
  return result.value;
}

const opts = parseArgs(process.argv.slice(2));
const url = pathToFileURL(resolve(opts.in)).href;

const chrome = spawn(
  chromePath(opts.chrome),
  [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    `--remote-debugging-port=${opts.port}`,
    `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
    url,
  ],
  { stdio: 'ignore' }
);

let cdp;
try {
  cdp = connect(await debuggerUrl(opts.port));
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  for (const selector of opts.click) {
    const clicked = await evaluate(cdp, `!!document.querySelector(${JSON.stringify(selector)})?.click()  || true`);
    if (!clicked) throw new Error(`nothing matched ${selector}`);
  }

  // A table row and the detail row under it are siblings, so the region worth
  // capturing is the union of several elements rather than one of them.
  const box = await evaluate(
    cdp,
    `(() => {
       const found = ${JSON.stringify(opts.clip)}.map((s) => document.querySelector(s));
       if (found.some((el) => !el)) return null;
       const boxes = found.map((el) => el.getBoundingClientRect());
       const left = Math.min(...boxes.map((b) => b.left));
       const top = Math.min(...boxes.map((b) => b.top));
       return {
         x: left + scrollX,
         y: top + scrollY,
         width: Math.max(...boxes.map((b) => b.right)) - left,
         height: Math.max(...boxes.map((b) => b.bottom)) - top,
       };
     })()`
  );
  if (!box) throw new Error(`nothing matched ${opts.clip.join(', ')}`);

  const { data } = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true,
    clip: {
      x: Math.max(0, box.x - PAD),
      y: Math.max(0, box.y - PAD),
      width: box.width + PAD * 2,
      // Top pad only: the extra at the bottom shows a slice of the next row.
      height: box.height + PAD,
      scale: SCALE,
    },
  });

  const out = resolve(opts.out);
  await writeFile(out, Buffer.from(data, 'base64'));
  console.log(`wrote ${out} (${Math.round((box.width + PAD * 2) * SCALE)}x${Math.round((box.height + PAD) * SCALE)})`);
} finally {
  cdp?.close();
  // Only the Chrome this script started, by pid.
  chrome.kill();
}
