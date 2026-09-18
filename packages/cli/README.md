# eslint10-matrix

**Can this repo upgrade to ESLint 10 yet?** Answered by running the plugins, not by reading their manifests.

![npx eslint10-matrix scan in a five-plugin React app: one plugin blocked, two rescuable with @eslint/compat, and the config to paste](https://raw.githubusercontent.com/Booyaka101/eslint10-matrix/main/docs/scan-terminal.png)

Three facts, all verifiable at the npm registry right now:

| package | latest version | declared `peerDependencies.eslint` |
| --- | --- | --- |
| `eslint-plugin-react` | 7.37.5 (2025-04-03) | `^3 \|\| ^4 \|\| ^5 \|\| ^6 \|\| ^7 \|\| ^8 \|\| ^9.7` |
| `eslint-plugin-jsx-a11y` | 6.10.2 (2024-10-26) | `^3 \|\| ^4 \|\| ^5 \|\| ^6 \|\| ^7 \|\| ^8 \|\| ^9` |
| `eslint-plugin-import` | 2.32.0 | `^2 \|\| ^3 \|\| ^4 \|\| ^5 \|\| ^6 \|\| ^7.2.0 \|\| ^8 \|\| ^9` |

ESLint's own latest is **10.10.0**. Every one of those ranges excludes it, so `npm install` refuses to resolve them against ESLint 10 and every readiness dashboard built on manifest data marks all three as blocked.

That answer is wrong in both directions. Executed against real ESLint 10.10.0 with every rule enabled:

- `eslint-plugin-import@2.32.0` declares `^9` and **mostly runs**. Three of its 46 rules crash (`no-default-export`, `no-named-export`, `unambiguous`); the other 43 are fine, and all three recover under `@eslint/compat`.
- `eslint-plugin-jsx-a11y@6.10.2` declares `^9` and is **completely clean**, all 39 rules, no crashes. Nothing is wrong with it. The range is just stale.
- `eslint-plugin-react@7.37.5` declares `^9` and **38 of its 101 rules throw**, including `display-name` with `contextOrFilename.getFilename is not a function`, exactly [issue #3977](https://github.com/jsx-eslint/eslint-plugin-react/issues/3977), open since February 2026 with hundreds of reactions.

And the failure does not have to be yours. `eslint-plugin-vitest@0.5.4` and `eslint-plugin-deprecation@3.0.0` both **fail to import entirely** on ESLint 10, because `@typescript-eslint/utils` does `class extends eslint.LegacyESLint` and ESLint 10 removed `LegacyESLint` along with eslintrc. Neither plugin's own manifest hints at that.

A declared range is a claim its author last checked at publish time. The only ground truth is execution.

**Live matrix: <https://booyaka101.github.io/eslint10-matrix/>**

## Install

```
npx eslint10-matrix scan
```

No install needed. Node 22 or newer, no runtime dependencies.

## Two questions, two commands

`check` reads the published board: for each plugin your config uses, what happened when **the latest
published version** of it was executed against a fixture corpus. That answers *what is the state of
the ecosystem*, it needs no install and it returns in under a second.

`scan` executes here, in your checkout, at **the versions in your `node_modules`**, over **your own
source files**. That answers *can I upgrade this repo*. It takes a few minutes and it can disagree
with the board in both directions: a plugin the board calls clean can crash on a syntax your code
uses and nothing in the corpus does, and a plugin the board calls blocked may be fine at the older
version you have pinned.

Run `check` to see where the ecosystem is. Run `scan` before you actually do the upgrade. There is a
third command, `diff`, for the question that comes after both: a row changed its verdict overnight,
what moved under it.

## `scan`: your versions, your files

```
$ cd examples/react-app && npx eslint10-matrix scan

ESLint 10.10.0 readiness for react-app (5 plugins)
executed here against your installed versions on 7 files, baseline eslint 9.39.5

BLOCKED (1)
  eslint-plugin-vitest@0.5.4  fails to load on 10.10.0
                              @eslint/compat did not help: still fails to load with @eslint/compat installed: Class ext…
                              measured with eslint 10.10.0, +4 more, node 22.18.0, npm 10.9.3

RESCUABLE (2)  crashes as published, verified clean when wrapped with @eslint/compat
  npm install --save-dev @eslint/compat, then in eslint.config.js:

  eslint-plugin-import@2.32.0  4 rules crash on 10.10.0, all recover wrapped in fixupPluginRules()
    import/order crashed on src\components\Catalogue.jsx: sourceCode.getTokenOrCommentBefore is not a function
    measured with eslint 10.10.0, @typescript-eslint/parser 8.67.0, +2 more, node 22.18.0, npm 10.9.3

    import { fixupPluginRules } from '@eslint/compat';
    import pluginImport from 'eslint-plugin-import';

    export default [
      // ...the rest of your config
      {
        plugins: { import: fixupPluginRules(pluginImport) },
      },
    ];

  eslint-plugin-react@7.37.5  6 rules crash on 10.10.0, all recover wrapped in fixupPluginRules()
    react/forward-ref-uses-ref crashed on eslint.config.js: Error while loading rule 'react/forward-ref-… (6 more files)
    measured with eslint 10.10.0, @typescript-eslint/parser 8.67.0, +2 more, node 22.18.0, npm 10.9.3

    import { fixupPluginRules } from '@eslint/compat';
    import react from 'eslint-plugin-react';

    export default [
      // ...the rest of your config
      {
        plugins: { react: fixupPluginRules(react) },
      },
    ];

SAFE TO FORCE (1)  declared below ^10, verified clean on 10.10.0 with all rules enabled
  eslint-plugin-jsx-a11y@6.10.2

  Add to package.json to install them against ESLint 10 anyway:
    {
      "overrides": {
        "eslint-plugin-jsx-a11y": {
          "eslint": "$eslint"
        }
      }
    }

CLEAN (1)  already declares ^10
  eslint-plugin-promise@7.3.0

3 of 5 plugins block the upgrade to ESLint 10.10.0 (2 of them rescuable with @eslint/compat).
```

That is a real run against [`examples/react-app`](https://github.com/Booyaka101/eslint10-matrix/tree/main/examples/react-app), a small React app with five
plugins in its flat config. Two rows differ from the board, and both differences are the reason the
command exists.

`eslint-plugin-import` crashes in **four** rules here, not the three the board reports. The extra one
is `import/order`, which dies on `sourceCode.getTokenOrCommentBefore is not a function` in
`src\components\Catalogue.jsx`. It runs clean over the fixture corpus. That is a crash you would only
have found by linting your own code, which is the gap the board cannot close.

`eslint-plugin-react` crashes in **six** rules here, not the board's 38, because the board runs it at
`settings: { react: { version: 'detect' } }` and this app pins `18.3`. Version detection is what
reaches most of the removed `context` APIs, so pinning it avoids 32 of the crashes. Your settings
are part of your answer, and `scan` reads them out of your config.

`scan` runs each plugin in a temp directory against real ESLint 9 and real ESLint 10 with the
versions your lockfile pins, so the numbers are about your repo and nothing else. The installs are
cached under `~/.cache/eslint10-matrix/envs` and pruned after 14 days, so the second run is much
faster than the first.

### Where your answer and the board's differ

`scan --against` prints the report, then says where this repo and a board disagree, in the same
words `diff` uses:

```
$ eslint10-matrix scan . --against board.json

board.json -> this repo
generated 2026-09-15T03:31:54.929Z -> 2026-09-18T06:22:24.900Z, 5 -> 5 plugins

eslint-plugin-promise  rule-crash -> clean on 10.10.0
  plugin: eslint-plugin-promise 7.4.0 -> 7.3.0

1 row changed, 0 added, 0 removed. 1 attributed, 0 with no recorded environment.
```

The board is the before and this repo is the after, so a cause line reads as what is different here:
that board measured eslint-plugin-promise at 7.4.0 and this app is on 7.3.0. Pass the flag bare to
compare against the published board, or name one to compare against that. Only
plugins the board also measures are compared: a plugin it has never heard of is on the report above
with its own verdict, and calling it `added to the board` would be a sentence about the board that
is not true. If the board measures none of them, the command says so rather than printing an empty
diff, which would read as agreement. The board is fetched fresh and never read from or written to
the cache, the same as `diff`, and the report is printed before the fetch, so a board that cannot be
reached costs you the comparison and not the scan you waited for.

What it refuses to do:

- **No `node_modules`**: it stops with exit 2 and tells you to install. It will never quietly fall back to whatever npm publishes as latest, because that is the question `check` answers.
- **A repo still on `.eslintrc`**: it stops and says ESLint 10 removed eslintrc, so no plugin version can make that repo run on 10. That is a real answer, just not one this tool can measure.
- **A plugin installed but not referenced by the config**: skipped, and named in a note at the end.
- **A monorepo root**: the config nearest the path you gave is the one measured. Workspace globs are detected and reported, but the packages under them are not walked. Point `scan` at each package.
- **A crash that does not reproduce**: every regression is measured twice, and only rules that crash on both runs are reported.
- **A config it cannot import**, such as one that default-exports a function or a TypeScript config this Node cannot strip: it stops and names the reason. `--plugins eslint-plugin-a,eslint-plugin-b` gets you a measurement anyway, using your installed versions and your files but none of the config's `ignores` or `settings`.

## `check`: the published board

```
$ cd examples/react-app && npx eslint10-matrix check --matrix ../../matrix.json

ESLint 10.10.0 readiness for react-app (5 plugins)
matrix generated 2026-09-15T03:31:54.929Z

BLOCKED (1)
  eslint-plugin-vitest@0.5.4  fails to load on 10.10.0
                              @eslint/compat did not help: still fails to load with @eslint/compat installed: Class ext…

RESCUABLE (2)  crashes as published, verified clean when wrapped with @eslint/compat
  npm install --save-dev @eslint/compat, then in eslint.config.js:

  eslint-plugin-import@2.32.0  3 rules crash on 10.10.0, all recover wrapped in fixupPluginRules()

    import { fixupPluginRules } from '@eslint/compat';
    import pluginImport from 'eslint-plugin-import';

    export default [
      // ...the rest of your config
      {
        plugins: { import: fixupPluginRules(pluginImport) },
      },
    ];

  eslint-plugin-react@7.37.5  38 rules crash on 10.10.0, all recover wrapped in fixupPluginRules()

    import { fixupPluginRules } from '@eslint/compat';
    import react from 'eslint-plugin-react';

    export default [
      // ...the rest of your config
      {
        plugins: { react: fixupPluginRules(react) },
      },
    ];

SAFE TO FORCE (1)  declared below ^10, verified clean on 10.10.0 with all rules enabled
  eslint-plugin-jsx-a11y@6.10.2

  Add to package.json to install them against ESLint 10 anyway:
    {
      "overrides": {
        "eslint-plugin-jsx-a11y": {
          "eslint": "$eslint"
        }
      }
    }

CLEAN (1)  already declares ^10
  eslint-plugin-promise@7.3.0

3 of 5 plugins block the upgrade to ESLint 10.10.0 (2 of them rescuable with @eslint/compat).
```

Same repo, same five plugins, same verdict vocabulary. The differences are the ones described above:
`check` reports each plugin's latest published version measured over a fixture corpus, `scan`
reports the version installed here measured over this app's own files. `--matrix` is pointing at the
board committed to this repo; without it the command fetches the published one, which is the same
board a deploy behind.

The buckets are the whole point:

- **BLOCKED**. Actually breaks, and wrapping does not help. Wait for a release, switch plugin, or disable the crashing rules.
- **RESCUABLE**. Breaks as published, but every crashing rule recovers when the plugin is wrapped with [@eslint/compat](https://www.npmjs.com/package/@eslint/compat). The report prints the exact `eslint.config.js` wiring to paste.
- **PARTIAL-RESCUE**. The wrap fixes most crashing rules; the report names the ones you still have to disable.
- **SAFE TO FORCE**. Declares an old range but runs clean with every rule enabled. The `overrides` block installs it against ESLint 10 anyway. `$eslint` resolves to whatever your root `eslint` dependency is, so you do not have to repeat the version.
- **CLEAN**. Already declares `^10`. Nothing to do.
- **HARNESS MISCONFIG**. Not a verdict about the plugin at all: the same rules failed the same way on ESLint 9 and 10, which means the environment they were measured in was wrong, not the plugin. The row names the cause and the fix, and is left out of the blocking count and the `--ci` exit code.

Every row the report prints on a line of its own carries one more dim line naming the environment
it was measured in. That is BLOCKED, both rescue tiers and HARNESS MISCONFIG. CLEAN and UNTESTED
are summarised as a single list, so there is no row to hang it on; `--json` has it for all of them:

```
  eslint-plugin-react@7.37.5  38 rules crash on 10.10.0, all recover wrapped in fixupPluginRules()
    measured with eslint 10.10.0, eslint-plugin-react 7.37.5, react 19.3.0, node 22.18.0, npm 10.9.3
```

ESLint leads, the rest are alphabetical, and names drop off the end with a `+N more` once the line
would not fit beside its indent, which a scoped parser and two long plugin names manage easily.
`--json` carries the whole object. A verdict without this is a claim you cannot go back and check,
which is what `diff` and the nightly drift guard are built on.

### When the board's versions are not yours

A verdict is only as good as what it was measured against, so `check` says when the two disagree:

```
CLEAN (1)  already declares ^10
  eslint-plugin-vue@10.5.0

MEASURED DIFFERENTLY (1)  the board reached these verdicts with versions this repo does not have
  eslint-plugin-vue  vue-eslint-parser 10.3.0, here 9.1.0
  eslint10-matrix scan measures these against the versions you have
```

The board says eslint-plugin-vue is clean on ESLint 10. It got there with vue-eslint-parser 10.3.0,
and this repo is on 9.1.0, so that clean result is about a setup this repo does not have. It is a
note and not a verdict: the section never moves a row between buckets and never changes the `--ci`
exit code, because the board cannot know whether the older parser is a problem for you.

Only packages both sides have are compared, so a peer the probe installed and you do not use stays
out of the way. ESLint itself is left out too, since a repo running `check` is on 9 by definition.
Versions are read from `node_modules` first and the lockfile second, the same way `scan` reads them,
and `--json` carries the full list under `measuredDrift`. Boards published before 1.4.0 recorded no
environment, so nothing appears against them. The section can say the versions disagree and not
whether the disagreement matters, so it ends by naming the command that can: `scan` runs the same
plugins against what you actually have installed.

## Rescue verdicts, measured not assumed

ESLint 9 reached end of life on 2026-08-06, so waiting on 9 is no longer a plan. For plugins that
regress on 10, both commands re-lint with the plugin wrapped in @eslint/compat 2.1.1's
`fixupPluginRules()` (or `fixupConfigRules()` when the plugin exports flat configs, whichever works
is recorded). The verdict comes from the before and after crash counts of that run, never from the
wrapper's own claim that it "fixes the most common issues", which is exactly why PARTIAL-RESCUE
exists.

The worked example is `eslint-plugin-react@7.37.5`, the same plugin behind
[issue #3977](https://github.com/jsx-eslint/eslint-plugin-react/issues/3977): 38 of its 101 rules
crash on ESLint 10.10.0 with `contextOrFilename.getFilename is not a function`. Wrapped in
`fixupPluginRules()` **all 38 recover**, so the matrix records it as RESCUABLE.

Reproduced end to end in a scratch repo with the real plugin, not a fixture:

```
$ npx eslint .                       # eslint-plugin-react@7.37.5 as published
Oops! Something went wrong! :(
ESLint: 10.10.0
TypeError: Error while loading rule 'react/display-name': contextOrFilename.getFilename is not a function
    at resolveBasedir (node_modules/eslint-plugin-react/lib/util/version.js:31:100)

$ npx eslint .                       # after pasting the snippet the report printed
$ echo $?
0
```

Across the current 54-plugin corpus, 5 plugins are RESCUABLE: `eslint-plugin-react` (38 rules),
`eslint-plugin-node` (the 8 that ESLint 10 broke), `eslint-plugin-eslint-comments` (8),
`eslint-plugin-import` (3) and `eslint-plugin-lodash` (1). That moves the blocked count from 7 to 2.

Whether the wrap helps is measured, not predicted from the error text. `eslint-plugin-import` is why:
its crashing rules die on `Cannot use 'in' operator to search for 'sourceType' in undefined`, which
does not read like a removed `context` API at all, and `fixupPluginRules()` repairs every one of
them. The rescue pass is skipped only for causes no rule wrapper can touch, each recorded with its
reason: the install itself failed, a dependency is missing, the Node engine does not match, or the
parser failed. `eslint-plugin-vitest` and `eslint-plugin-deprecation` do get the pass, and the
result is the honest one: wrapping rules cannot fix a crash that happens at import time.

A plugin that also crashes on ESLint 9 keeps that breakage after the wrap, and the report says so
rather than claiming a clean run. `eslint-plugin-node` is the case: 12 of its rules crash on both
versions, 8 more only on 10, and only those 8 are what RESCUABLE speaks to.

## `diff`: what changed between two boards, and why

A verdict that moves is only useful if you can say what moved under it. Every run since 1.4.0
records the versions npm actually installed, so `diff` can pair two boards row by row and put a
reason beside each change.

```
$ eslint10-matrix diff yesterday.json today.json

yesterday.json -> today.json
generated 2026-09-17T03:31:19.232Z -> 2026-09-18T02:41:07.004Z, 54 -> 54 plugins

eslint-plugin-jest     clean -> rule-crash on 10.10.0
  env: jest 30.5.1 -> 31.0.0
eslint-plugin-promise  clean -> rule-crash on 10.10.0
  unexplained: no recorded version changed

2 rows changed, 0 added, 0 removed. 1 attributed, 0 with no recorded environment.
1 change has no recorded cause: every version both boards recorded is identical.
```

Either argument can be a local path or an `https://` URL. Give it one board and the published one
is the other, so checking your build against what is live is just `eslint10-matrix diff
./matrix.json`.

It can also be a git revision, written the way `git show` takes one:

```
$ eslint10-matrix diff HEAD~7:matrix.json matrix.json
```

The nightly commits `matrix.json` every day, so a week of boards is already in the repository and
there is nothing to keep or fetch. The path after the colon is relative to the repository root
unless you start it with `./`. A path that really exists on disk is read as a file, colon or not.

`--only eslint-plugin-vue,eslint-plugin-jest` narrows the comparison to the plugins you named.
Everything else stays out of the changes and out of the counts, so `--ci` judges exactly what was
printed: a repo watching its own five plugins is not failed by a sixth it does not use moving
overnight. A name neither board has is a row that has not changed by any measure, not an error.

The cause is the first of these that applies, most specific first:

| cause | means |
| --- | --- |
| `eslint` | the two boards were built against different ESLint releases |
| `plugin` | the plugin shipped a new version between the runs |
| `env` | something else installed alongside it moved, named with both versions |
| `unknown-env` | one of the boards predates 1.4.0 and recorded no environment, so nothing can be ruled out |
| `unexplained` | every version both boards recorded is identical and the verdict moved anyway |

`unexplained` is the one worth waking up for. It means the board is about to publish a change it
cannot reproduce, so `--ci` exits 1 on it, and on a row that left the board entirely. An attributed
change exits 0: plugins change, and that is the board doing its job.

Attribution is scoped to the ESLint major the row actually moved on. A row that moved on 10 is not
explained by something that happened around 9, and an install that failed before it wrote a
`node_modules` on one major does not cost the other major its answer.

`scripts/check-drift.mjs` is this wired up as the nightly's `drift-guard` job: it diffs the freshly
built board against the published one, prints every change with its cause and fails the run on the
same two things `--ci` does: a change nothing recorded explains, or a row that left the board. The baseline comes from `scripts/fetch-published.mjs`, which saves the
published board during the merge, before the deploy overwrites it. The guard does not gate the
deploy. It reports, the same way the harness guard does, so a red night does not leave main ahead
of what is published and every night after it re-failing against the same stale board.

![The rescuable tier on the live matrix](https://raw.githubusercontent.com/Booyaka101/eslint10-matrix/main/docs/rescuable-tier.png)

Clicking a row opens what was measured: the `@eslint/compat` line first, then every rule that
crashed and the error it threw.

![eslint-plugin-react expanded, showing the rescue line above its 38 crashing rules](https://raw.githubusercontent.com/Booyaka101/eslint10-matrix/main/docs/react-rescue-detail.png)

### Commands

```
eslint10-matrix check [dir]      read the published board for a repo (default: .)
eslint10-matrix scan [dir]       execute your installed plugin versions against ESLint 10
                                 on your own source files
eslint10-matrix plugins          list every plugin in the published matrix
eslint10-matrix diff [a] <b>     what changed between two boards, and why. Each board is a
                                 path, an https:// URL, or a git revision such as
                                 HEAD~7:matrix.json. One board is compared against
                                 the published one.
```

### Options

| flag | applies to | effect |
| --- | --- | --- |
| `--ci` | all | `check` and `scan`: exit 1 when any plugin is BLOCKED, RESCUABLE or PARTIAL-RESCUE. `diff`: exit 1 when a change has no recorded cause, or a row left the board. Without it the command always exits 0. |
| `--color` | all | force ANSI colour when the output is not a terminal |
| `--json` | all | machine-readable output. `check` and `scan` include the `overrides` object; `diff` prints both board summaries, every change and the counts. |
| `--no-cache` | `check`, `scan` | never read or write `~/.cache/eslint10-matrix`. `diff` never touches the cache at all: it compares the two boards you named, so a board it cannot fetch is an error rather than a silent fall back to the last one `check` saw. |
| `--no-color` | all | disable ANSI colour |
| `--plugins <a,b>` | `check`, `scan` | skip config resolution and use these package names. The way past a config this tool cannot read, at the cost of the config's `ignores` and `settings`. |
| `--only <a,b>` | `diff` | compare only these plugins. The counts and `--ci` then cover exactly what was printed. |
| `--against [board]` | `scan` | after the report, say where this repo disagrees with a board and why. No board named means the published one. |
| `--matrix <src>` | `check` | read a board from a local path, a different URL, or a git revision such as `HEAD~7:matrix.json` |
| `--timeout <ms>` | `check`, `diff` | network timeout for fetching a board (default 15000) |
| `--eslint <version>` | `scan` | the ESLint 10 release to measure against (default 10.10.0) |
| `--max-files <n>` | `scan` | how many of the repo's files to lint (default 200) |
| `--concurrency <n>` | `scan` | plugins measured in parallel (default 3) |
| `--quiet` | `scan` | do not print progress to stderr |

`check` caches the board at `~/.cache/eslint10-matrix/matrix.json` and falls back to it when the
network is unavailable, with a warning naming the age of the copy. `scan` caches its npm installs
under `~/.cache/eslint10-matrix/envs`, keyed by the exact dependency set, and prunes anything
untouched for 14 days.

### In CI

```yaml
- run: npx eslint10-matrix check --ci
```

Fails the job while anything is blocked, passes the moment the last blocker ships a fix. That turns "is our ESLint 10 upgrade unblocked yet" into a check that answers itself instead of a ticket somebody re-reads every sprint.

`scan --ci` does the same thing against your own versions and files. It is the slower, more accurate
gate: run it nightly rather than on every push.

Exit codes: `0` report printed, `1` `--ci` and something is BLOCKED, or a `diff` change has no recorded cause, `2` the command could not run (no flat config, no `node_modules`, no matrix, bad arguments).

## How the matrix is produced

Nightly, for each plugin and each of ESLint 9.39.5 and 10.10.0:

1. `mkdtemp` a fresh directory and write a minimal `package.json`.
2. `npm install --legacy-peer-deps` the plugin at `latest`, ESLint at the pinned version, and any real peer packages it needs (`typescript`, `vue-eslint-parser`, `react`). The `--legacy-peer-deps` is the experiment: the declared range is what we are testing, so we install past it deliberately.
3. Import the plugin, collect every rule from `configs.all.rules` (or `Object.keys(plugin.rules)`), and enable all of them at `error`.
4. Lint a checked-in corpus of ordinary React, hooks, CommonJS, ESM, JSX-a11y and TypeScript source.
5. Classify: **clean**, **rule-crash**, **load-fail**, **install-fail**, or **harness-misconfig**.
   The last one is not about the plugin. A rule that crashes identically on ESLint 9 and on 10
   cannot be telling us anything about ESLint 10, so crashes that name a package we did not
   install, a parser that did not load, or an AST field the parser never produced are moved out of
   the crash list and recorded with the fix that repairs them. A crash that appears only on 10
   stays a crash whatever its message looks like.
6. Read the resolved version of every dependency back out of that directory's `node_modules` and
   record it on the result as `measuredWith`, alongside the Node and npm the run used. Step 2 asks
   for a spec, and a spec is a wish: `--legacy-peer-deps` backtracks, `latest` moves, and an
   environment reused from the cache can be a fortnight old. The only truthful answer to "what was
   this measured against" is the one read off disk after the install.
7. For a plugin that regressed on 10, install `@eslint/compat@2.1.1` into a fresh isolated directory
   (its peer range covers 10, no extra forcing needed) and repeat the identical run with the plugin
   wrapped. Crashes at zero is RESCUABLE, fewer is PARTIAL-RESCUE with the residual rules stored, no
   change stays BLOCKED. A failure that reproduces identically on ESLint 9, and a plugin that is
   SAFE TO FORCE or CLEAN, never enters the rescue pass, so a no-op wrap can never be reported as a
   rescue.

`scan` runs steps 1 to 7 too. It differs in three places: the version installed at step 2 is the one
your `node_modules` has rather than `latest`, the rules enabled at step 3 are only the ones your
config turns on, and the files linted at step 4 are yours.

A crashing rule aborts the entire lint run at the first casualty, so when the all-rules pass fails the runner re-lints **one rule at a time** to enumerate every broken rule rather than just the first. That is why the react row names 38 rules and not 1.

Both ESLint versions are executed so the report can answer the question you actually asked: **what does the upgrade break?** A failure that reproduces identically on ESLint 9 is not an ESLint 10 blocker, so it is reported as pre-existing and the plugin is not marked BLOCKED. `@typescript-eslint/eslint-plugin` is the case that proves it: 64 of its rules refuse to load without `parserOptions.project`, identically on 9 and 10. Counting those would have marked the most-installed plugin in the ecosystem as blocked over a `tsconfig` setting.

Volume of lint errors never affects the verdict. Enabling every rule on real source produces thousands of ordinary reports; only a module that fails to import and a rule that throws or emits a fatal message count against a plugin. ESLint validates rule options before running, so a rule that needs required options is recorded separately as a config problem, not as a compatibility failure.

Everything runs in a child process, so a plugin that hard-crashes the Node process takes down only its own probe.

### Configuration in `plugins.json`

Each entry may carry `settings`, `parser` and `extraDeps`, the same configuration an ordinary repo supplies. This is not cosmetic. `eslint-plugin-react` only reaches the removed `context.getFilename()` API when it is asked to detect the React version, so without `settings: { react: { version: 'detect' } }` only 6 of its 38 broken rules surface. Testing plugins in a configuration nobody actually uses would understate the breakage. `scan` reads the same three things out of your own flat config instead.

## Limitations

- **Two ESLint versions**, the current `latest` (10.10.0) and the current `maintenance` (9.39.5). No sweep across the earlier 10.x minors. `scan --eslint <version>` measures a different 10.x release if you need one.
- **Flat config only.** ESLint 10 removed eslintrc, so a repo still on `.eslintrc` has a bigger migration than this tool measures.
- **`plugins` maps only.** Plugins pulled in through a shared config's `extends` are not attributed to a package name; pass `--plugins` with the package names to measure them anyway.
- **Rules that exist only inside a plugin's exported flat config**, with no top-level `rules` map, are recorded as a config prerequisite rather than linted, so such a plugin reads as clean and never reaches the rescue pass.
- **A config that default-exports a function** is resolved by the ESLint CLI, not by this tool. Export the array, or pass `--plugins` with the package names.
- **One config per `scan`.** Workspaces are detected and reported, not walked.

## Development

```
npm ci
npm run build                                    # both packages
npm run lint                                     # this repo lints itself, on ESLint 10
npm test                                         # 271 tests, vitest (build first: the end-to-end tests drive the built CLI)
node packages/runner/dist/run.js --only eslint-plugin-react   # one plugin
node packages/runner/dist/run.js                 # full pass, ~4 minutes at concurrency 6
node site/build.mjs --in matrix.json --out site/dist
node site/build.mjs --in matrix.json --out site/dist --since HEAD:matrix.json   # with the "what moved" panel
```

`--since` takes the same things `--matrix` does: a file, an http(s) URL, or a git revision. The
nightly passes it the board it is about to replace, so the page opens with what moved since the one
you last looked at and why. A baseline it cannot read costs the panel and nothing else.

The README screenshots are generated, not drawn. `node scripts/terminal-shot.mjs --in <captured
output> --out docs/scan-terminal.png` turns a real `--color` run into the terminal image above.

The runner takes `--shard i/n` so the nightly workflow can fan out across four jobs and merge with `scripts/merge-shards.mjs`.

### Releasing

Tag the commit CI is green on, then run the `publish` workflow from the Actions tab. Leave "Use
workflow from" on `main` and put the tag in the input box: the definition comes from the ref you
dispatch, the published code comes from the tag. It refuses a tag whose version does not match
`packages/cli/package.json`, runs build, lint and the full suite on the tagged tree, and publishes
with npm provenance through OIDC. There is no
`NPM_TOKEN` anywhere in the repo, and there should not be: a token alongside `id-token: write`
makes npm prefer the token and the publish loses its attestation.

It needs one setup step only the package owner can do, since npmjs.com package settings sit behind
that account's own 2FA. On npmjs.com, under settings for `eslint10-matrix`, add a trusted publisher
for this repository and `publish.yml`, leaving the environment field blank. Until that exists the
workflow fails at the publish step, which is the right failure: publishing from a laptop instead
loses that version's provenance permanently.

### Adding a plugin

Add an entry to `packages/runner/src/plugins.json` with `name` and `weeklyDownloads`, plus `parser`/`extraDeps`/`settings` if it needs them, then open a PR. Or open an issue and it will be added on the next pass.

## Matrix schema

This is the published `matrix.json`. `scan` builds the same structure in memory and reports from it,
so the two commands share one vocabulary; `--json` prints the bucketed report rather than the raw
matrix, and prints it identically for both. Its `notes` array carries the same caveats the human
report prints in grey: files left unscanned, a version read from the lockfile rather than
`node_modules`, a workspace root whose packages were not walked.

```jsonc
{
  "schemaVersion": 1,
  "generatedAt": "2026-09-10T01:34:04.617Z",
  "eslintVersions": { "v9": "9.39.5", "v10": "10.10.0" },
  "plugins": [
    {
      "name": "eslint-plugin-react",
      "version": "7.37.5",
      "declaredPeerRange": "^3 || ^4 || ^5 || ^6 || ^7 || ^8 || ^9.7",
      "weeklyDownloads": 50254779,
      "results": {
        "10.10.0": {
          "status": "rule-crash",              // clean | rule-crash | load-fail | install-fail | harness-misconfig
          "crashingRules": [{ "rule": "display-name", "message": "..." }],
          "totalRules": 101,
          "measuredWith": {                    // what was on disk when this ran, read back out
            "node": "22.18.0",                 // of the probe's own node_modules. Absent when
            "npm": "10.9.3",                   // nothing installed; a dep that did not install
            "deps": {                          // is null rather than missing.
              "eslint": "10.10.0",
              "eslint-plugin-react": "7.37.5",
              "react": "19.3.0"
            }
          },
          "harness": {                         // only when the environment, not the plugin, broke a rule
            "rules": [
              {
                "rule": "no-deprecated-functions",
                "message": "Unable to detect Jest version...",
                "cause": "missing-peer",       // or parser-unavailable | ast-shape | corpus-unparsed
                "subject": "jest",
                "detail": "...",
                "fix": "add \"jest\" to extraDeps for eslint-plugin-jest in packages/runner/src/plugins.json"
              }
            ]
          }
        }
      },
      "rescue": {                              // only on plugins that regressed on 10
        "eslintVersion": "10.10.0",
        "compatVersion": "2.1.1",
        "attempted": true,                     // false with a skipReason when no wrapper could help
        "verdict": "rescuable",                // rescuable | partial-rescue | blocked
        "fixupFunction": "fixupPluginRules",   // or fixupConfigRules, with fixupConfigKey
        "crashingRulesBefore": 38,
        "crashingRulesAfter": 0,
        "residualRules": []                    // populated for partial-rescue
      }
    }
  ]
}
```

A `scan` row adds `file` to each crashing rule, naming a file in your repo that triggered it, plus
`fileCount` when more than one did. Attribution stops after 25 files per rule, and a count that hit
that cap carries `fileCountCapped` and reads as "at least 24 more files" in the report. The `rescue`
field is additive: nothing existing was renamed or removed and the schema version is still 1, so
tools reading the old shape keep working. `measuredWith` is additive the same way, which is why an
older CLI reads a 1.4.0 board and reports exactly the verdicts it always did.

## Telling people about it

The best place is the thread people are already stuck in, not a new announcement.
[jsx-eslint/eslint-plugin-react#3977](https://github.com/jsx-eslint/eslint-plugin-react/issues/3977)
has hundreds of reactions from people who cannot upgrade, and what helps there is the executed data:
which rules break, why, and which of your other plugins are already fine. Lead with that, link the
matrix once at the end, and skip it entirely if you have nothing new to add to the thread.

If you take it somewhere with a stricter format, lead with the same thing. r/javascript auto-removes
any self post not prefixed `[AskJS]` and wants a link post with the write-up as the first comment,
which suits this well: link the board, put the numbers and the `fixupPluginRules` snippet in the
comment.

## License

MIT
