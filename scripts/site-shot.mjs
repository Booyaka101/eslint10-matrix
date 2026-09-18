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
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
  // Per-process so two shots can render at once, and never 9222: that is where a
  // developer's own Chrome listens, and this script clicks inside what it finds.
  const opts = parseFlags(argv, FLAGS, USAGE, { port: 9300 + (process.pid % 600) });
  if (!opts.in || !opts.out || opts.clip.length === 0) throw new Error(USAGE);
  return opts;
}

/**
 * Chrome needs a moment to open its debugging port, and says so when it has. The
 * target has to be the page we asked for: anything else on this port is somebody
 * else's browser, and this script is about to click inside whatever it gets.
 */
async function debuggerUrl(port, wanted, child, deadline = Date.now() + 15_000) {
  for (;;) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const target = (await response.json()).find(
        (t) => t.type === 'page' && t.url === wanted && t.webSocketDebuggerUrl
      );
      if (target) return target.webSocketDebuggerUrl;
    } catch {
      // Not listening yet.
    }
    // A Chrome that died is not going to start listening, and spending the rest of
    // the deadline finding that out buries the exit code under a timeout message.
    if (!alive(child)) throw new Error(`chrome exited (${exitReason(child)}) before opening ${wanted}`);
    if (Date.now() > deadline) throw new Error(`chrome never opened ${wanted} on port ${port}`);
    await new Promise((done) => setTimeout(done, 100));
  }
}

const alive = (child) => child.exitCode === null && child.signalCode === null;

const exitReason = (child) => (child.signalCode ? `signal ${child.signalCode}` : `code ${child.exitCode}`);

function connect(url, timeoutMs = 20_000) {
  const socket = new WebSocket(url);
  const pending = new Map();
  let nextId = 0;

  // Chrome dying mid-capture settles nothing on its own, so without these the
  // await would hang forever and the browser this script spawned would leak.
  const failAll = (reason) => {
    for (const waiting of [...pending.values()]) waiting.fail(new Error(reason));
    pending.clear();
  };

  const open = new Promise((done, fail) => {
    socket.addEventListener('open', () => done());
    socket.addEventListener('error', () => fail(new Error('devtools socket failed')));
    socket.addEventListener('close', () => fail(new Error('devtools socket closed')));
  });
  socket.addEventListener('error', () => failAll('devtools socket failed'));
  socket.addEventListener('close', () => failAll('devtools socket closed'));

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
        const timer = setTimeout(() => {
          pending.delete(id);
          fail(new Error(`${method} did not answer within ${timeoutMs / 1000}s`));
        }, timeoutMs);
        const settle = (fn) => (value) => {
          clearTimeout(timer);
          fn(value);
        };
        pending.set(id, { done: settle(done), fail: settle(fail) });
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
// Its own profile, so it can never attach to a Chrome already running on this box
// and so nothing it does lands in the user's real one.
const profile = await mkdtemp(join(tmpdir(), 'e10m-shot-'));

const chrome = spawn(
  chromePath(opts.chrome),
  [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${opts.port}`,
    `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
    url,
  ],
  { stdio: 'ignore' }
);

let cdp;
try {
  cdp = connect(await debuggerUrl(opts.port, url, chrome));
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  for (const selector of opts.click) {
    // click() returns undefined, so the hit has to be reported separately or a
    // renamed selector silently writes an unfiltered screenshot over the old one.
    const clicked = await evaluate(
      cdp,
      `(() => {
         const el = document.querySelector(${JSON.stringify(selector)});
         el?.click();
         return Boolean(el);
       })()`
    );
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
} catch (err) {
  console.error(`site-shot: ${err.message}`);
  process.exitCode = 1;
} finally {
  cdp?.close();
  // Only the Chrome this script started, by pid. Windows keeps the profile's
  // lockfile open until it has actually gone, so the wait is not politeness. A
  // child that already exited never emits `exit` again, and awaiting one that
  // will not fire strands the process with whatever threw above unreported.
  if (alive(chrome)) {
    const gone = new Promise((done) => chrome.once('exit', done));
    chrome.kill();
    await gone;
  }
  // A temp directory left behind is not worth failing a screenshot that worked.
  await rm(profile, { recursive: true, force: true }).catch(() => {});
}
