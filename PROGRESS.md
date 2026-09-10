# PROGRESS

Status at 2026-09-10: **v1.2.0 built and verified locally, not pushed and not published.** The
working tree on branch `scan-command` carries the whole release: the new `scan` command, the shared
classification and rescue modules both commands now call, the board refreshed to ESLint 10.10.0,
and the docs and screenshots redrawn to match. It has been through a full review-and-fix round since:
six defects found by reading the diff as a reviewer, all fixed, plus a pass over every user-facing
string. v1.1.0 remains what is live on npm and Pages.

## Next steps for the owner

1. `git push -u origin scan-command` and open a PR against `main`. Nothing has been pushed: this
   build stayed local on purpose.
2. Wait for CI green on ubuntu and windows for the exact head commit, checked through the commit's
   check-runs API rather than `gh run watch`.
3. Merge, let the nightly regenerate and deploy `matrix.json`, then `npm publish` from
   `packages/cli` and tag `v1.2.0` on the merge commit.
4. The `NPM_TOKEN` provenance setup from the v1.1.0 notes is still not done, so 1.2.0 will publish
   without an attestation unless that is set up first. Both steps sit behind npm's 2FA and are
   owner-operated.

## v1.2.0: what changed and why

ESLint 9 went end of life on 2026-08-06, and the board answers a question that stops one step short
of the one people are actually asking. It measures each plugin's *latest* published version against
a *fixture corpus*. Neither is the repo you are trying to upgrade. `scan` measures the versions your
`node_modules` actually holds, against your own source files, with your own config's `ignores` and
`settings` applied.

The two commands answer different questions on purpose. `check` answers "what is the state of the
ecosystem", which is a shared fact worth publishing nightly. `scan` answers "can I upgrade this
repo", which is only true for one repo at one moment and is therefore executed on demand.

## What is VERIFIED working

Every line below was executed on this machine on 2026-09-10.

| check | result |
| --- | --- |
| `npm run build` | clean, both workspaces |
| `npm run lint` | clean, this repo lints itself on ESLint 10 |
| `npm test` | **9 files, 108 tests passed**, 4.01s |
| pre-refactor tier regression | `test/tiers-regression.test.ts` replays `test/fixtures/tiers-before-refactor.json` through the extracted modules and reproduces all 54 verdicts and the rendered report byte for byte |
| corpus vs repo disagreement | `test/scan-vs-corpus.test.ts` tiers the same plugin CLEAN over the fixture corpus and BLOCKED over the fixture repo, citing `src\Card.jsx` and `(1 more file)` |
| `scan examples/react-app` | exit 0, 5 plugins, 7 files, BLOCKED 1 / RESCUABLE 2 / SAFE TO FORCE 1 / CLEAN 1 |
| `scan` with no `node_modules` | exit 2, "no node_modules under ...", no stack trace |
| `scan` on an `.eslintrc` repo | exit 2, names `@eslint/migrate-config` |
| `scan --plugins` past an unreadable config | measured `eslint-plugin-react@7.37.5` in the example app with the config skipped, and said so in a note |
| clean-path install, re-run after the review fixes | `npm pack` then `npm install ./eslint10-matrix-1.2.0.tgz` into an empty directory: `--version` prints 1.2.0, `--help` renders, `import('eslint10-matrix')` exposes `main` and `parseArgs`, and `scan` ran the full example-app report from the installed bin |
| board refresh | `matrix.json` regenerated at ESLint 9.39.5 / 10.10.0, 54 plugins: 42 clean, 5 rescuable, 5 safe-to-force, 2 blocked |
| README transcripts | both fenced blocks diffed against a fresh run, 52 and 50 lines, no differences |
| `scan --json` | `ready: false`, counts 1/2/0/1/1, `notes: []` for a repo with nothing to qualify |
| `scan --ci` | exit 1 on the example app, exit 0 without `--ci` |

## What the refreshed board measured

| | 10.9.1 (v1.1.0) | 10.10.0 (v1.2.0) |
| --- | --- | --- |
| BLOCKED | 3 | **2** (`eslint-plugin-vitest`, `eslint-plugin-deprecation`, both load failures) |
| RESCUABLE | 4 | **5** (react 38, node 8, eslint-comments 8, import 3, lodash 1) |
| SAFE TO FORCE | 5 | 5 |
| CLEAN | 42 | 42 |

`eslint-plugin-import` moved BLOCKED to RESCUABLE because the rescue pass stopped reading the error
text to decide whether a wrapper could help. Its crashes say `Cannot use 'in' operator to search for
'sourceType' in undefined`, which names no removed `context` API, and `fixupPluginRules()` repairs
all three rules anyway. That is now a dated bullet in `LESSONS.md`.

## Findings from this phase

1. **The board and the repo genuinely disagree, in both directions.** In `examples/react-app`,
   `eslint-plugin-import` crashes in four rules rather than the board's three: `import/order` dies
   on `sourceCode.getTokenOrCommentBefore is not a function` in `src\components\Catalogue.jsx` and
   runs clean over the corpus. `eslint-plugin-react` crashes in six rather than 38, because the
   board runs it at `settings: { react: { version: 'detect' } }` and the app pins `18.3`. Version
   detection is what reaches most of the removed APIs. The caller's settings are part of the answer.
2. **`scan` has to refuse rather than substitute.** Falling back to registry latest when there is no
   `node_modules` would answer a different question in the same words, which is worse than exiting
   2. Same for the eslintrc case: the answer is "no", for a reason this tool cannot measure.
3. **The `node_modules` guard has to run before config resolution.** `resolveConfig` imports the
   config, so an uninstalled repo failed first with "Cannot find package 'eslint-plugin-react'".
   Technically true, and a worse answer to "why did the scan stop" than naming the missing install.
4. **A bare relative `--matrix matrix.json` was silently ignored.** The path detector required a
   leading `.`, `/` or drive letter, so the value parsed as a URL, failed to fetch, and fell back to
   a cached board from three weeks earlier without saying the file had been skipped. Two regression
   tests now cover the relative path and the `file:` URL.

## House-rule audit

- **Clone check, difflib over function line lists.** 101 functions of 6+ lines on the final tree
  (79 at the first pass, before the tests and the screenshot script). One pair sat in the
  60% neighbourhood: `packages/runner/src/run.ts:corpusFiles` against
  `test/probe-sandbox.ts:corpusFiles` at **59%**, both reading `packages/runner/fixtures` and both
  producing `fixtures/<name>` paths. Extracted to `packages/runner/src/corpus.ts` and both callers
  converted. Re-run: **nothing at or above 57%**, and the remainder are five-line `try`/`catch`
  wrappers (`readJsonFile`, `isHttpUrl`, `readCache`, `writeCache`, `readVersion`) with no shared
  mechanism worth a module. `scan` deliberately does not clone the corpus runner: both call
  `probe`, `classify`, `rescuePass` and `verdictFor` from the CLI package. Re-run after the review
  fixes: the highest real pair is 67%, still `readJsonFile` against `isHttpUrl`, both five-line
  `try`/`catch` wrappers. The 68% reported for `collect-files.ts:collectFiles` against `walk` is the
  extractor counting a nested function's lines twice, not a clone. Two six-line `result()` builders
  in `test/cli.test.ts` and `test/rescue.test.ts` sit at 62%; they take different arguments and
  sharing them would couple two suites for six lines, so that is where I stopped.
- **Proof the extraction changed nothing.** `test/fixtures/tiers-before-refactor.json` was captured
  from the pre-refactor code and holds both the 54 verdicts and the full rendered report.
  `test/tiers-regression.test.ts` replays it and compares byte for byte.
- **No em dashes** in either README, the CHANGELOG, this file or the example app's README, checked
  through Node rather than a shell pattern.
- **Comments.** Every comment added this phase states a constraint that is not visible from the
  code: why the install guard precedes config resolution, why settings are stripped to JSON-safe
  values, why `meta.name` loses to the naming convention, why a crash is measured twice.
- **Screenshots redrawn.** `docs/rescuable-tier.png` and `docs/react-rescue-detail.png` are new
  2680x2040 captures of the 10.10.0 board, showing five rescuable rows and the new footer that
  points at `scan`. `docs/scan-terminal.png` is new: the README hero, a 2148x1276 render of a real
  `scan --color` run produced by `scripts/terminal-shot.mjs`, so the terminal images are generated
  from captured output rather than drawn.
- **The two pasted transcripts are byte-identical to a fresh run.** Both fenced blocks in the README
  were diffed line by line against `scan examples/react-app` and `check examples/react-app --matrix
  matrix.json` after the last edit. 52 and 50 lines, no differences.

## Review round two: what a reviewer objected to, and the fix

Six defects came out of reading the diff as a reviewer, all fixed and all in the CHANGELOG:

1. **Install specs were unquoted.** npm is spawned through a shell, which joins arguments with
   spaces and quotes nothing, so a peer range such as `>=4.8.4 <5.9.0` or one containing `||`
   arrived as several words and the plugin came back `install-fail`. `installArgs` now quotes each
   spec, and a test spawns a real shell with such a range to prove it arrives as one argument.
2. **Stale probe results.** Every run shared the cached environment's directory, so a run killed on
   timeout left a `probe-result.json` that the next run over the same dependency set read as its own
   answer. Each run now gets its own `run-` subdirectory, removed with the run.
3. **A failed move into the cache deleted a good install.** The staging directory is now used where
   it was built when the rename loses a race, instead of being removed and reported as
   `install-fail` for every plugin in that run.
4. **Per-rule attribution was unbounded.** Rules times files on a large repo could outlast the
   caller's patience and be killed, which reads as a load failure. It now stops at 25 files of
   evidence per rule and at a four-minute deadline, marks a capped count, and the report says
   "at least 24 more files".
5. **A block-scoped `ignores` was hoisted.** An `ignores` list beside `files` scopes that block, not
   the whole config. Hoisting it made `scan` skip files ESLint would have linted.
6. **`--json` dropped the notes.** The caveats the human report prints in grey were missing from the
   machine-readable output, so a CI consumer read a verdict with none of its qualifications. The
   `notes` array is now in the JSON, and a workspace root scanned with `--plugins` names the
   directory rather than the literal `(--plugins)` placeholder.

Prose and help pass: `--color` was a working flag documented nowhere, so it is in `--help` and in
both README option tables. The exit-code line said "at least one plugin is BLOCKED" while `--ci`
exits 1 for RESCUABLE and PARTIAL-RESCUE too.

## Review round three: what the last read found

A second review pass over the whole branch diff turned up four more, all fixed and all with a test
that fails against the old code:

1. **`globalIgnores()` was not recognised.** ESLint's own helper emits `{ name, ignores }`, and the
   global-ignore check required `ignores` to be the object's only key, so those patterns were
   dropped and `scan` linted build output ESLint never looks at. `name` and `basePath` are treated
   as metadata now, matching `META_FIELDS` in `@eslint/config-array`, and a `basePath` scopes the
   patterns under it.
2. **npm v2/v3 lockfiles returned the wrong version.** They key by install path and npm writes the
   paths sorted, so `node_modules/eslint-config-x/node_modules/eslint-plugin-react` comes before
   `node_modules/eslint-plugin-react` and a first-one-wins read kept the nested copy. Reproduced at
   7.30.0 against a hoisted 7.37.5. The shallowest path wins now. It only bites a tree resolved
   through the lockfile, which is exactly `npm ci --omit=dev`.
3. **Shell injection through an install spec.** `scan` builds specs from versions and peer ranges
   read out of the caller's own `node_modules`, and npm is spawned through a shell, so `$(...)` in
   a dependency's declared range reached `sh` as syntax. Quoting does not stop that. Specs are now
   checked against the characters a package name and semver range can contain, and anything else is
   refused with the spec named. Verified end to end: a spec carrying `$(touch ...)` comes back
   `install-fail` and no file is written. (cmd.exe does not expand `$(...)`, so the hole was only
   reachable on POSIX, which is where CI and most users are.)
4. **The attribution budget was per measured candidate, not per process.** A rescue probe measures
   two wrapped candidates, and two four-minute budgets plus the lint passes overran the six-minute
   kill: SIGKILL, no result file, and a rescuable plugin reported as still failing to load. One
   process-wide deadline now, the second candidate is skipped once it passes, and a test asserts the
   budget stays under the kill because the two constants live in different files.

Also removed a dead store in `scan.ts` (`unresolved` was written and never read).

## Acceptance checks from the brief

| check | result |
| --- | --- |
| full existing suite green | **yes**, 108 tests, and every pre-existing test is unchanged |
| pre-refactor regression fixture reproduces byte for byte | **yes** |
| `scan` on a repo pinned to `eslint-plugin-react@7.37.5` reports BLOCKED and cites a file path | **partly, and the difference is a measurement, not a gap.** react 7.37.5 measures **RESCUABLE**, not BLOCKED: every rule it breaks recovers under `fixupPluginRules()`, and the report cites `react/forward-ref-uses-ref crashed on eslint.config.js ... (6 more files)`. The BLOCKED-with-a-file-citation path is proven directly by `test/scan-vs-corpus.test.ts`, which cites `src\Card.jsx`. The example app's real BLOCKED row is `eslint-plugin-vitest@0.5.4`, and being a load failure it has no file to cite. |
| `scan` with no `node_modules` exits non-zero with a readable message | **yes**, exit 2 |
| the published board shows 10.10.0 | **`matrix.json` in this branch does.** Publishing it is the nightly's job after the merge. |

## What is missing, and what was deliberately left

Built during the review pass because it was small and closed a real hole:

- **`--plugins` for `scan`.** A config that default-exports a function, or a TypeScript config this
  Node cannot strip, used to end the scan even though two existing hints told the user to pass
  `--plugins`. It now works for both commands, at the documented cost of the config's `ignores` and
  `settings`.

Not built, in rough order of value:

1. **Workspace walking.** A monorepo root is detected and reported, not walked. `scan` measures the
   config nearest the path it was given. The natural shape is `scan --workspaces`, running one scan
   per package and merging the rows, and it needs a story for the same plugin resolving to different
   versions in different packages.
2. **Plugins reached through a shared config's `extends`.** They are not attributed to a package
   name, so a repo that gets everything from `eslint-config-airbnb` scans as having no plugins.
   Resolving them means walking the shared config's own dependency tree.
3. **`scan --fix`, writing the `fixupPluginRules` snippet into the config.** The snippet is already
   exact. Editing somebody's config is a different risk class and wants a diff preview first.
4. **Caching scan results per repo.** Only the npm installs are cached today, so an unchanged repo
   still re-lints. Keying on the lockfile hash plus the file list would make a repeat scan instant.
5. **More than two ESLint versions.** `--eslint` measures any single 10.x release, but nothing
   bisects which minor broke a plugin.
6. **Rules that exist only inside a plugin's exported flat config**, with no top-level `rules` map,
   are recorded as a config prerequisite rather than linted, so such a plugin reads as clean and
   never reaches the rescue pass. Known since v1.1.0 and still a documented limitation.

## v1.1.0 record

Shipped 2026-08-27: RESCUABLE and PARTIAL-RESCUE, measured with `@eslint/compat` 2.1.0, PR #1 merged
with CI green on ubuntu and windows, `eslint10-matrix@1.1.0` published as `latest`, the board
deployed to Pages, and a `main` branch ruleset (`deletion`, `non_fast_forward`,
`required_linear_history`, no bypass actors). The Phase 0 verification table, the rescue findings
and the publish record for that release are in the v1.1.0 section of `CHANGELOG.md` and in the
repository history.

`npm publish` warned on 1.1.0 that it had auto-corrected `bin` from `./dist/index.js` to
`dist/index.js`. The manifest now writes it the corrected way, so that warning is gone.

## v1.0.0 record

The original three buckets, the 54-plugin corpus, the `--legacy-peer-deps` install method and the
per-rule attribution loop, all as recorded at 2026-08-22. Nothing since has changed how the three
original verdicts are computed, which `test/tiers-regression.test.ts` now enforces.
