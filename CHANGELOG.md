# Changelog

## 1.4.0 - 2026-09-18

The board has always been able to say a plugin broke and never able to say what it was measured
against. Issue #11 asked for the fix the obvious way round: pin `settings.jest.version` in
`plugins.json` so the run stops depending on whichever jest npm resolves that night. That was
rejected, and rightly. A pin is a declaration, and the board's entire claim is that its verdicts
come from execution rather than from declarations. Pinning would also have frozen the measurement
at whatever was true the day somebody typed the number, which is the opposite of what a nightly is
for. The real defect was never what we install. It is that we never wrote down what we got.

So 1.4.0 records instead of declaring. Nothing about what gets installed changed, and
`plugins.json` gained no version pins, only a sentence in its comment saying where the versions
live now.

- **Every result carries `measuredWith`.** After the install, the probe reads the version out of
  each dependency's own `package.json` in the environment it is about to run in, and stores those
  alongside the Node and npm that did the work. A dependency we asked for and did not get is
  recorded as `null` rather than dropped, because "it was not there" is the interesting case. This
  happens on a cache hit too: an environment reused from `~/.cache/eslint10-matrix/envs` can be
  thirteen days old, so its specs are not evidence of anything. Resolving the spec against the
  registry instead would have been wrong in a way that is easy to miss. npm 10 backtracks a
  `latest` direct dependency to satisfy a transitive peer, so the version a spec installs is a
  property of the installer and the day, not of the spec.
- **`eslint10-matrix diff <before> <after>`.** Pairs two boards by plugin name and prints every row
  whose status on either ESLint major, or whose rescue verdict, moved, with the first cause that
  applies beside it: `eslint` if the boards were built against different releases, `plugin` if the
  plugin shipped, `env` if something installed around it moved (named, with both versions),
  `unknown-env` if one of the boards predates this release and recorded nothing, `unexplained` if
  every version both boards recorded is identical. Attribution is scoped to the major the row
  actually moved on, so an install that never wrote a `node_modules` on ESLint 9 cannot cost the
  ESLint 10 answer its cause. `--ci` exits 1 on `unexplained` and on a row that left the board, and
  0 on everything else, because plugins changing is the board working. Either argument can be a
  path or an `https://` URL.
- **A `drift-guard` job in the nightly.** `scripts/check-drift.mjs` fetches the published board,
  diffs the freshly built one against it, prints every change with its cause and fails when one has
  none. It also says out loud when rows left the board, which is what a shard that died looks like.
- The report prints one dim line per row naming the environment behind the verdict, ESLint first
  then alphabetical, capped at six packages with a `+N more`. The site shows the full list per
  major inside the expanded row, because the two majors install separately and the versions around
  the plugin can differ between them.
- `examples/react-app` pins `typescript` again. Its lockfile had drifted to TypeScript 7, which
  `@typescript-eslint/parser@8` refuses to load, so the example the README walks you through
  reported HARNESS MISCONFIG instead of the rescue story it is there to show. The measured line is
  what made that visible in one read.
- `packages/cli/README.md` is now generated from the repo README by `npm run sync:readme`, and a
  test fails when it is stale. The hand-kept copy had missed the entire 1.3.0 release.

`schemaVersion` is still 1. `measuredWith` is additive exactly as `harness` was in 1.3.0, so a
1.3.0 CLI reads a 1.4.0 board and prints the same verdicts it always did. That was checked by
running `npx eslint10-matrix@1.3.0 check` against a board built by this release: identical output,
minus the lines 1.3.0 has no field for.

## 1.3.0 - 2026-09-14

Two rows reached the published board saying a plugin was broken when what was broken was the
environment we measured it in. Both reported the same failure on ESLint 9 and on ESLint 10, which
is the tell: a run that fails identically on both majors cannot be telling you anything about
ESLint 10. 1.3.0 fixes those two rows and then teaches the tool to recognise the shape, so the
next one is reported as our problem instead of being published as a plugin failure.

- **New `harness-misconfig` status and HARNESS MISCONFIG bucket.** Crashes that name a package we
  did not install, a parser that did not load, an AST field the parser never produced, or a corpus
  that did not parse are moved off the crash list into a `harness` object on the result, each with
  a cause, the package or parser it is about, and the edit that fixes it. When neither major has a
  crash left that belongs to the plugin, the row's status becomes `harness-misconfig` and its
  verdict reads "not measured": it is counted in the plugin total, and deliberately not in the
  blocking total or the `--ci` exit code, because we have not measured the plugin. A row that keeps
  a real crash stays a `rule-crash` and prints one dim line naming what was excluded.
- **The gate, which has no exceptions.** A rule is only attributed to the harness when *both*
  majors crash it for the *same* cause. A crash that appears only on ESLint 10 is an ESLint 10
  finding whatever its message looks like. `eslint-plugin-react`'s
  `contextOrFilename.getFilename is not a function` matches the AST-shape pattern exactly and stays
  RESCUABLE with its 38 rules, because ESLint 9 runs it fine.
- A probe whose parser never loaded is handled as a whole rather than rule by rule. It read every
  file with the wrong parser, so nothing it collected is evidence about either ESLint version, and
  the run is marked "not measured" entire. Each major installs separately and can lose its parser
  without the other, so this is decided per major, and it is the one way a row can be "not
  measured" on one major and something else on the other.
- A method missing on `context` or `sourceCode` is never called a harness problem. Those are the
  APIs ESLint 9 and 10 deleted, which is the plugin's problem and the one the rescue pass exists to
  fix. `eslint-plugin-node` fails that way on both majors, so only this keeps its 20 crashing rules
  and its RESCUABLE verdict intact.
- `scripts/check-harness.mjs` prints every row carrying harness data with its suggested fix and
  exits 1, and runs as a new `harness-guard` job in the nightly. The board stops being able to
  publish a broken measurement quietly. It also fails a row whose fixtures never parsed at all,
  whatever status that row ended on: a plugin reported CLEAN on a run where no rule saw a line of
  code is not a measurement either. The status is left alone there, because rewriting a published
  verdict on that evidence is a maintainer's call rather than the tool's.
- **A plugin can bring a fixture only its own parser reads**, through a `corpusExtensions` field in
  `packages/runner/src/plugins.json`. `eslint-plugin-svelte` was the reason: `svelte-eslint-parser`
  reads none of the six shared JavaScript and TypeScript fixtures, so all 84 of its rules were
  publishing CLEAN on both majors without having seen a line of code. It now gets a Svelte
  component alongside the shared corpus, and the CLEAN is a measurement. The extra file stays out
  of every other plugin's list, where it would only ever be parse noise.
- The config block the probe builds now takes its `files` glob from the files in front of it rather
  than a fixed list of extensions, which is what lets the above be linted at all. Every other row
  is unaffected: a five-plugin run before and after is identical field for field, including
  `eslint-plugin-react`'s 38 crashing rules and `eslint-plugin-vue`'s 2 unparsed fixtures.
- The static site gains a "not measured" pill, verdict, summary card and filter, and each such row
  expands to the excluded rules and the fix.
- Replaying the board 1.2.1 published through the new code moves no row into the new bucket and
  changes no plugin's tier. The only rows it moves are the two below, on the board published
  before they were fixed.

Fixed in the environment itself, so the board no longer carries either row:

- Each plugin's parser now parses every file, not only the TypeScript ones.
  `@typescript-eslint/eslint-plugin` was being run under espree on the `.js`, `.jsx`, `.mjs` and
  `.cjs` fixtures, and four of its rules read fields espree never produces, so they threw
  `Cannot read properties of undefined (reading 'length')` on both majors. It is clean on both
  now. `scan` picks up the same change, and resolves `@typescript-eslint/parser` whenever the
  repo has it installed rather than only when the repo contains `.ts` files.
  ([#10](https://github.com/Booyaka101/eslint10-matrix/issues/10))
- `eslint-plugin-jest` is measured with `jest` installed, the way a repo that lints jest tests
  has it. `no-deprecated-functions` reads a version out of the jest package and threw
  `Unable to detect Jest version` without it, again on both majors. Clean on both now.
  ([#11](https://github.com/Booyaka101/eslint10-matrix/issues/11))

`schemaVersion` stays 1 and a board written by 1.3.0 stays readable by 1.2.1 and earlier: the
`harness` object is an extra field they ignore, and the new status does not fail their shape check.
Checked against the published 1.2.1, a `harness-misconfig` row reads as CLEAN when the plugin
declares `^10` and as SAFE TO FORCE when it does not, and does not count towards `--ci`. So an old
CLI calls such a row ready rather than broken, which is the optimistic answer, not the alarming
one, and matches 1.3.0 on the part that matters: it never blocks an upgrade on a measurement we do
not stand behind. Upgrade to see the cause and the fix. In practice a published board should never
carry one, which is what the new `harness-guard` nightly job is for.

## 1.2.1 - 2026-09-10

- Fixes a probe hang introduced in 1.2.0. The probe got a scratch directory of its own so that a
  killed run could not leave its answer behind for the next one, and that directory became the
  process's working directory. A plugin that resolves its own toolchain from there, such as
  `eslint-plugin-tailwindcss`, found no `node_modules` and deadlocked in a worker thread until
  the six-minute kill. The scratch directory stays, but the probe now reads and writes it by its
  own path and leaves the process in the environment root. Measuring
  `eslint-plugin-tailwindcss@4.4.0` went from 729s and two timeouts to 14s, and the board reports
  its five crashing rules again instead of a bare load failure.

## 1.2.0 - 2026-09-10

ESLint 9 went end of life on 2026-08-06 and ESLint 10.10.0 is now the release everyone is landing
on, so the two gaps the README already admitted stopped being acceptable: the board measured each
plugin's *latest* version against a *fixture corpus*, and neither of those is the repo you are
actually trying to upgrade. `scan` closes both.

- **`eslint10-matrix scan [dir]`** executes your installed plugin versions, read from
  `node_modules` and falling back to the lockfile, against real ESLint 9 and ESLint 10 over your
  own source files. Same five verdicts, same snippets, but a BLOCKED row now names the file in
  your repo that triggered the crash. Flags: `--eslint`, `--max-files`, `--concurrency`,
  `--quiet`, plus the shared `--ci`, `--json`, `--no-cache` and `--no-color`.
- `scan` refuses to guess rather than quietly answering a different question. No `node_modules`
  exits 2 and says to install rather than falling back to registry latest, a repo still on
  `.eslintrc` is told ESLint 10 removed eslintrc, a workspace root is told its packages were not
  walked, a plugin installed but unused by the config is skipped and named, and every regression
  is measured twice so a crash that does not reproduce is not reported.
- `--plugins` now applies to `scan` as well as `check`. A config that default-exports a function,
  or a TypeScript config this Node cannot strip, used to end the scan; naming the packages gets a
  measurement anyway, against your installed versions and your files, and the report says which
  config's `ignores` and `settings` were skipped to get it.
- Installs are cached under `~/.cache/eslint10-matrix/envs`, keyed by the exact dependency set and
  pruned after 14 days, so a second `scan` is much faster than the first.
- The crash classifier and the `@eslint/compat` rescue logic moved out of the nightly runner into
  the CLI package, and both commands now call the same code. A regression fixture captured before
  the move asserts the corpus still tiers every plugin exactly as it did.

Two measurement fixes changed published verdicts:

- The rescue pass no longer decides from the error text whether a wrapper could help. It only
  skips causes no wrapper can touch: install failure, missing dependency, Node engine mismatch,
  parser failure. `eslint-plugin-import@2.32.0` was the casualty of the old gate. Its crashes read
  `Cannot use 'in' operator to search for 'sourceType' in undefined`, which does not look like a
  removed `context` API, and `fixupPluginRules()` repairs all three rules. It moves from BLOCKED
  to RESCUABLE. Board blocked count drops from 3 to 2, rescuable rises from 4 to 5.
- The printed snippet used to emit `import import from 'eslint-plugin-import'`, which is not valid
  JavaScript. Import bindings that collide with a reserved word are now prefixed. Every plugin on
  the board is checked with `node --check` in CI.
- A plugin's `meta.name` is no longer trusted ahead of the naming convention when it is not
  plugin-shaped. `eslint-plugin-vitest@0.5.4` reports `meta.name: 'vitest'`, so in a repo that also
  runs vitest the scan measured the test runner and suggested forcing an eslint override onto it.
- `--matrix matrix.json` (a bare relative path) parsed as a URL, failed to fetch, and silently
  reported the cached board instead. Anything that is not http(s) is now read as a file.

Found in review before this shipped:

- Install specs are quoted. npm is spawned through a shell, which joins the arguments with spaces
  and quotes nothing, so a peer range such as `>=4.8.4 <5.9.0` or one containing `||` arrived as
  several words and the plugin came back `install-fail`.
- Each probe run gets its own scratch directory inside the cached environment. A run killed on
  timeout used to leave its `probe-result.json` behind, and the next run over the same dependency
  set read that stale file as its own answer.
- An environment whose move into the cache failed is now used where it was built instead of after
  being deleted, which had reported every plugin in that run as `install-fail`.
- Per-rule attribution is bounded: 25 files of evidence per crashing rule, and a deadline that
  reports what it found rather than letting the probe be killed and read as a load failure. A count
  that stopped at the cap is marked, and the report says "at least 24 more files".
- An `ignores` list beside `files` in a flat config block is scoped to that block. It was being
  hoisted into the global ignore list, so `scan` skipped files ESLint would have linted.
- `--json` now carries the `notes` array. The caveats the human report prints in grey (files left
  unscanned, a version read from the lockfile, a workspace root whose packages were not walked) were
  missing from the machine-readable output, so a CI consumer read a verdict with none of its
  qualifications.
- A workspace root scanned with `--plugins` printed "(--plugins) is a workspace root". The note names
  the directory now.
- A global ignore written by ESLint's own `globalIgnores()` was not recognised. It emits
  `{ name, ignores }`, and the check required `ignores` to be the object's only key, so `scan` linted
  build output ESLint never looks at. `name` and `basePath` are metadata now, and a `basePath` scopes
  the patterns under it.
- npm v2 and v3 lockfiles are keyed by install path and written sorted, so a copy nested under
  another package sorts ahead of the hoisted one and won. A lockfile-only tree (`npm ci --omit=dev`)
  could report a transitive version as the repo's. The shallowest path wins now.
- Install specs are checked against the characters a package name and semver range can contain.
  `scan` builds its specs from versions and peer ranges read out of the caller's own
  `node_modules`, and npm is spawned through a shell, so `$(...)` in a dependency's declared range
  reached `sh` as syntax. Anything outside that set is refused with the spec named.
- The attribution budget is one deadline for the whole probe process rather than one per measured
  candidate. A rescue probe measures two, and two four-minute budgets plus the lint passes overran
  the six-minute kill, which reported a rescuable plugin as still failing to load.
- Both commands name the measured directory relative to where you ran them, and by its own name
  when that is the directory you are standing in. Reports get pasted into issues, and the header
  used to print the absolute path of the machine it ran on.

Board refreshed to ESLint 10.10.0 against the 9.39.5 maintenance line, 54 plugins, and
@eslint/compat 2.1.1. 7 of 54 plugins block the upgrade, 5 of them rescuable.

The closing summary line now agrees with itself when a single plugin blocks: "1 of 1 plugin blocks
the upgrade to ESLint 10.10.0 (rescuable with @eslint/compat)".

`matrix.json` is unchanged in shape: a `scan` row adds `file`, `fileCount` and `fileCountCapped` to
each crashing rule, the schema version stays 1, and nothing was renamed or removed.

## 1.1.0 - 2026-08-27

ESLint 9 reached end of life on 2026-08-06, so "wait on 9" stopped being an answer, and
@eslint/compat 2.1.0 now declares peer support for ESLint 10. This release measures whether that
wrapper actually rescues each BLOCKED plugin instead of leaving BLOCKED as a dead end.

- Two new verdicts, both measured by execution, never assumed from the wrapper's claims:
  **RESCUABLE** (every newly crashing rule recovers when the plugin is wrapped with
  @eslint/compat) and **PARTIAL-RESCUE** (the crash count drops but some rules remain, and the
  matrix stores exactly which ones).
- The nightly runner re-probes every BLOCKED plugin with `fixupPluginRules()`, and with
  `fixupConfigRules()` too when the plugin exports flat configs, recording whichever worked.
  Crashes that a rule wrapper cannot touch (install failures, missing dependencies, Node engine
  mismatches, parser failures) are classified and skipped with a reason, and a failure that
  reproduces identically on ESLint 9 stays out of the rescue pass entirely.
- `check` prints a copy-pasteable `eslint.config.js` snippet for each RESCUABLE or
  PARTIAL-RESCUE plugin, with the residual rules to disable in the partial case. Verified end to
  end in CI: the printed snippet takes a repo from an ESLint 10 rule crash to a clean run.
- `plugins` and the published site show the new tier. `matrix.json` gains an optional `rescue`
  field per plugin; every existing field is unchanged and the schema version stays 1, so older
  CLIs keep working.
- First measured result: `eslint-plugin-react@7.37.5`, 38 of 101 rules crashing on ESLint 10, is
  RESCUABLE. Wrapped in `fixupPluginRules()` all 38 recover.

Upgrading from 1.0.0: `--ci` exit codes and the `ready` flag are unchanged, because a rescuable
plugin still breaks a plain upgrade and still fails the check. Two things did move for anyone
parsing `--json`: a plugin that was reported in `blocked` may now appear in `rescuable` or
`partialRescue` instead, so read `ready` rather than `counts.blocked`, and each entry's `reason`
string is unchanged while the new rescue detail lives in its own `rescue` object.

## 1.0.0 - 2026-08-22

Initial release: nightly matrix of 54 plugins executed against real ESLint 9 and 10 installs,
the BLOCKED / SAFE TO FORCE / CLEAN verdicts, the `check` and `plugins` commands, and the
published site.
