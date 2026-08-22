#!/usr/bin/env node
/** Renders matrix.json into one self-contained static page. No runtime fetches, no console errors. */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// Shared with the CLI so a row cannot be "blocked" in one and "ready" in the other.
// Requires `npm run build --workspace packages/cli` first; both workflows do that.
import { verdictFor } from '../packages/cli/dist/report.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');

const args = process.argv.slice(2);
function flag(name, fallback) {
  const i = args.indexOf(name);
  return i === -1 || args[i + 1] === undefined ? fallback : args[i + 1];
}

const inputPath = resolve(flag('--in', join(REPO_ROOT, 'matrix.json')));
const outDir = resolve(flag('--out', join(HERE, 'dist')));

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ESCAPES[ch]);

const STATUS_LABEL = {
  clean: 'clean',
  'rule-crash': 'rule crash',
  'load-fail': 'load fail',
  'install-fail': 'install fail',
};

function formatDownloads(n) {
  if (!Number.isFinite(n)) return '';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

const VERDICT_TEXT = { blocked: 'blocked', force: 'safe to force', clean: 'ready', untested: 'untested' };

function cell(result) {
  if (!result) return '<td class="s"><span class="pill untested">untested</span></td>';
  const label = STATUS_LABEL[result.status] ?? result.status;
  const detail =
    result.status === 'rule-crash'
      ? `${result.crashingRules.length}/${result.totalRules} rules`
      : result.status === 'clean'
        ? `${result.totalRules} rules ok`
        : esc((result.detail ?? '').slice(0, 90));
  return `<td class="s"><span class="pill ${esc(result.status)}">${esc(label)}</span><span class="sub">${esc(detail)}</span></td>`;
}

function crashDetail(row, v10) {
  const result = row.results[v10];
  if (!result || result.crashingRules.length === 0) return '';
  const items = result.crashingRules
    .map((r) => `<li><code>${esc(r.rule)}</code><span>${esc(r.message)}</span></li>`)
    .join('');
  return `<tr class="detail" hidden><td colspan="5"><ul class="crashes">${items}</ul></td></tr>`;
}

function render(matrix) {
  const { v9, v10 } = matrix.eslintVersions;
  const counts = { blocked: 0, force: 0, clean: 0, untested: 0 };
  for (const row of matrix.plugins) counts[verdictFor(row, matrix.eslintVersions).verdict] += 1;

  const rows = matrix.plugins
    .map((row, index) => {
      const { verdict } = verdictFor(row, matrix.eslintVersions);
      const hasDetail = (row.results[v10]?.crashingRules.length ?? 0) > 0;
      const name = row.version ? `${row.name}@${row.version}` : row.name;
      return `<tr class="row v-${verdict}" data-verdict="${verdict}" data-name="${esc(row.name)}"${
        hasDetail ? ` data-detail="${index}" tabindex="0" role="button" aria-expanded="false"` : ''
      }>
    <td class="n"><span class="pkg">${esc(name)}</span><span class="sub">${formatDownloads(row.weeklyDownloads)}/wk${hasDetail ? ' · click for crashing rules' : ''}</span></td>
    <td class="d"><code>${esc(row.declaredPeerRange ?? 'none')}</code></td>
    ${cell(row.results[v9])}
    ${cell(row.results[v10])}
    <td class="v"><span class="verdict ${verdict}">${esc(VERDICT_TEXT[verdict])}</span></td>
  </tr>${crashDetail(row, v10)}`;
    })
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ESLint 10 plugin compatibility matrix</title>
<meta name="description" content="Every plugin installed and executed against real ESLint ${esc(v9)} and ${esc(v10)} with all rules enabled. Declared peerDependencies are the claim; this is the evidence.">
<style>
:root{--bg:#0d1117;--panel:#161b22;--line:#262d36;--fg:#e6edf3;--muted:#8b949e;--ok:#3fb950;--warn:#d29922;--bad:#f85149;--accent:#58a6ff}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:1180px;margin:0 auto;padding:40px 20px 80px}
h1{font-size:30px;margin:0 0 8px;letter-spacing:-.02em}
.lede{color:var(--muted);max-width:70ch;margin:0 0 6px}
.meta{color:var(--muted);font-size:13px;margin:18px 0 28px}
code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:26px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px 16px}
.card b{display:block;font-size:26px;line-height:1.2}
.card span{color:var(--muted);font-size:12.5px}
.card.blocked b{color:var(--bad)}.card.force b{color:var(--warn)}.card.clean b{color:var(--ok)}
.controls{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px;align-items:center}
input[type=search]{background:var(--panel);border:1px solid var(--line);color:var(--fg);border-radius:8px;padding:8px 12px;min-width:230px;font-size:14px}
input[type=search]:focus-visible,button:focus-visible,tr:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
button{background:var(--panel);border:1px solid var(--line);color:var(--fg);border-radius:8px;padding:8px 13px;cursor:pointer;font-size:13.5px}
button[aria-pressed=true]{border-color:var(--accent);color:var(--accent)}
table{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--line);border-radius:10px;overflow:hidden}
th{text-align:left;font-size:11.5px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);padding:11px 14px;border-bottom:1px solid var(--line);font-weight:600}
td{padding:11px 14px;border-bottom:1px solid var(--line);vertical-align:top}
tr.row[data-detail]{cursor:pointer}
tr.row:hover{background:#1c2230}
.pkg{display:block;font-weight:600;font-size:14px}
.sub{display:block;color:var(--muted);font-size:11.5px;margin-top:2px}
.pill{display:inline-block;padding:2px 8px;border-radius:20px;font-size:11.5px;font-weight:600;border:1px solid}
.pill.clean{color:var(--ok);border-color:#23823a;background:#0f2a17}
.pill.rule-crash{color:var(--bad);border-color:#8b2d28;background:#2b1210}
.pill.load-fail,.pill.install-fail{color:var(--warn);border-color:#8a6415;background:#2a2009}
.pill.untested{color:var(--muted);border-color:var(--line)}
.verdict{font-weight:600;font-size:13px}
.verdict.blocked{color:var(--bad)}.verdict.force{color:var(--warn)}.verdict.clean{color:var(--ok)}.verdict.untested{color:var(--muted)}
.crashes{margin:0;padding:0 0 0 4px;list-style:none;display:grid;gap:6px}
.crashes li{display:grid;grid-template-columns:230px 1fr;gap:12px;font-size:12.5px}
.crashes code{color:var(--bad)}
.crashes span{color:var(--muted)}
.empty{padding:26px;text-align:center;color:var(--muted)}
footer{color:var(--muted);font-size:13px;margin-top:34px}
a{color:var(--accent)}
@media(max-width:760px){.crashes li{grid-template-columns:1fr;gap:2px}.d{display:none}th.d{display:none}}
</style>
</head>
<body>
<main>
  <h1>ESLint ${esc(v10)} plugin compatibility matrix</h1>
  <p class="lede">Every plugin below is installed into a clean temp directory against real ESLint ${esc(v9)} and ESLint ${esc(v10)}, has <strong>every rule it exports</strong> enabled at <code>error</code>, and lints a fixture corpus of ordinary React, hooks, CommonJS, ESM and TypeScript source.</p>
  <p class="lede">A declared <code>peerDependencies</code> range is a claim. This is the execution. It is wrong in both directions: plugins that declare <code>^9</code> and run perfectly, and plugins that install happily and then throw inside a rule.</p>
  <p class="meta">Generated ${esc(matrix.generatedAt)} · ${matrix.plugins.length} plugins · schema v${esc(matrix.schemaVersion)} · <a href="./matrix.json">matrix.json</a></p>

  <div class="cards">
    <div class="card blocked"><b>${counts.blocked}</b><span>blocked on ${esc(v10)}</span></div>
    <div class="card force"><b>${counts.force}</b><span>safe to force</span></div>
    <div class="card clean"><b>${counts.clean}</b><span>already declare ^10</span></div>
    <div class="card"><b>${matrix.plugins.length}</b><span>plugins executed</span></div>
  </div>

  <div class="controls">
    <input type="search" id="q" placeholder="Filter plugins…" aria-label="Filter plugins by name">
    <button data-filter="all" aria-pressed="true">All</button>
    <button data-filter="blocked" aria-pressed="false">Blocked</button>
    <button data-filter="force" aria-pressed="false">Safe to force</button>
    <button data-filter="clean" aria-pressed="false">Ready</button>
  </div>

  <table>
    <thead><tr>
      <th>Plugin</th><th class="d">Declared eslint peer range</th>
      <th>ESLint ${esc(v9)}</th><th>ESLint ${esc(v10)}</th><th>Verdict</th>
    </tr></thead>
    <tbody id="rows">
${rows}
    </tbody>
  </table>
  <p class="empty" id="empty" hidden>No plugins match that filter.</p>

  <footer>
    <p><strong>Can my repo upgrade?</strong> Run <code>npx eslint10-matrix check</code> in it.</p>
    <p>Built by executing plugins, not by reading manifests. <a href="https://github.com/cbosch101/eslint10-matrix">Source and issue tracker</a>. MIT.</p>
  </footer>
</main>
<script>
(function () {
  var rows = Array.prototype.slice.call(document.querySelectorAll('tr.row'));
  var buttons = Array.prototype.slice.call(document.querySelectorAll('button[data-filter]'));
  var search = document.getElementById('q');
  var empty = document.getElementById('empty');
  var active = 'all';

  function detailRow(row) {
    var next = row.nextElementSibling;
    return next && next.classList.contains('detail') ? next : null;
  }

  function apply() {
    var term = search.value.trim().toLowerCase();
    var shown = 0;
    rows.forEach(function (row) {
      var okFilter = active === 'all' || row.dataset.verdict === active;
      var okTerm = term === '' || row.dataset.name.toLowerCase().indexOf(term) !== -1;
      var visible = okFilter && okTerm;
      row.hidden = !visible;
      if (visible) shown++;
      var detail = detailRow(row);
      if (detail && !visible) {
        detail.hidden = true;
        row.setAttribute('aria-expanded', 'false');
      }
    });
    empty.hidden = shown !== 0;
  }

  function toggle(row) {
    var detail = detailRow(row);
    if (!detail) return;
    var open = detail.hidden;
    detail.hidden = !open;
    row.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  buttons.forEach(function (button) {
    button.addEventListener('click', function () {
      active = button.dataset.filter;
      buttons.forEach(function (b) { b.setAttribute('aria-pressed', String(b === button)); });
      apply();
    });
  });

  rows.forEach(function (row) {
    if (!row.dataset.detail) return;
    row.addEventListener('click', function () { toggle(row); });
    row.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggle(row); }
    });
  });

  search.addEventListener('input', apply);
  apply();
})();
</script>
</body>
</html>
`;
}

async function main() {
  let matrix;
  try {
    matrix = JSON.parse(await readFile(inputPath, 'utf8'));
  } catch (err) {
    console.error(
      err.code === 'ENOENT'
        ? `site: no matrix at ${inputPath}. Run the runner first, or pass --in <matrix.json>.`
        : `site: could not read ${inputPath}: ${err.message}`
    );
    process.exit(1);
  }

  if (matrix?.schemaVersion !== 1 || !Array.isArray(matrix.plugins) || !matrix.eslintVersions) {
    console.error(`site: ${inputPath} is not a v1 matrix document`);
    process.exit(1);
  }

  await mkdir(outDir, { recursive: true });
  const html = render(matrix);
  await writeFile(join(outDir, 'index.html'), html, 'utf8');
  await writeFile(join(outDir, 'matrix.json'), JSON.stringify(matrix, null, 2), 'utf8');
  await writeFile(join(outDir, '.nojekyll'), '', 'utf8');
  console.log(`site: wrote ${join(outDir, 'index.html')} (${matrix.plugins.length} plugins, ${Math.round(html.length / 1024)} kB)`);
}

await main();
