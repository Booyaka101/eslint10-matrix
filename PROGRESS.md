# PROGRESS

Status at 2026-08-27: **v1.1.0 shipped.** RESCUABLE and PARTIAL-RESCUE are live on npm, Pages and
the nightly. PR #1 merged with CI green on both ubuntu and windows, the nightly regenerated and
deployed the published matrix, `eslint10-matrix@1.1.0` is on npm as `latest`, and installing it
from the registry into an empty directory and running `check` against the live matrix reproduced
the rescue tier and snippet.

`main` also carries a branch ruleset: `deletion`, `non_fast_forward` and `required_linear_history`
with **no bypass actors**, so force-push and branch deletion are refused for everyone including the
repo admin, while the nightly's ordinary fast-forward push still lands.

## v1.1.0: what changed and why

ESLint 9 reached end of life on 2026-08-06, so BLOCKED stopped being an acceptable place for the
tool to stop. `@eslint/compat@2.1.0` declares `eslint` peer `^8.40 || 9 || 10`, so it installs
into the matrix's isolated ESLint 10 dirs with no new `--legacy-peer-deps` pressure, and its
`fixupPluginRules()` wraps every rule in a plugin. Whether that actually rescues a given plugin is
a measurement, not a claim, which is the whole point of this repo.

## Phase 0 verification (all re-fetched live on 2026-08-27)

| resource | result |
| --- | --- |
| `registry.npmjs.org/@eslint/compat/latest` | 2.1.0, "Compatibility utilities for ESLint", peer `eslint ^8.40 \|\| 9 \|\| 10` (optional), engines node `^20.19.0 \|\| ^22.13.0 \|\| >=24`. Matches the brief. |
| `eslint/rewrite` `packages/compat/README.md` | `fixupPluginRules()` applies `fixupRule()` to each rule and returns a new plugin; `fixupConfigRules()` documented; "intended for use with ESLint v8.x or v9.x to allow them to work as-is in ESLint v9.x and v10.x"; carries the "fixes the most common issues but can't fix everything" caveat. `includeIgnoreFile` deprecated. Matches. |
| `jsx-eslint/eslint-plugin-react#3977` | open, created 2026-02-07, names `contextOrFilename.getFilename is not a function` in `react/display-name`, traced to `lib/util/version.js`, no fix merged. Matches. |
| `jsx-eslint/eslint-plugin-jsx-a11y#1075` | open, "[Feature] Support for ESLint v10", created 2026-02-09, PRs #1079 and #1081 referenced, nothing merged. Matches. |
| `Booyaka101/eslint10-matrix` README on main | the three shipped buckets, the nightly method, and the react 38-of-101 result, exactly as the brief describes. |

The GitHub HTML fetch did not return reaction counts today, so the two README lines that quoted a
precise count now say "hundreds of reactions" rather than republish a number this run could not
re-verify.

**Cost model: free.** npm registry, GitHub API, Actions and Pages on a public repo. `@eslint/compat`
is MIT on the public registry. No paid key, account or hosting.

## What the run actually measured

Full 54-plugin pass against ESLint 9.39.5 and 10.9.1, rescue pass included.

| plugin | ESLint 10 | rescue |
| --- | --- | --- |
| `eslint-plugin-react@7.37.5` | 38 of 101 rules crash | **RESCUABLE**, all 38 recover under `fixupPluginRules()` |
| `eslint-plugin-eslint-comments@3.2.0` | 8 rules crash | **RESCUABLE**, all 8 recover |
| `eslint-plugin-node@11.1.0` | 20 crash, 12 of them on ESLint 9 too | **RESCUABLE** for the 8 that ESLint 10 broke; the other 12 survive the wrap and the report says so |
| `eslint-plugin-lodash@8.0.0` | 1 rule crashes | **RESCUABLE** |
| `eslint-plugin-import@2.32.0` | 3 rules crash | skipped, `not a removed context API`. The cause is `Cannot use 'in' operator to search for 'sourceType' in undefined`, which no rule wrapper repairs. |
| `eslint-plugin-vitest@0.5.4` | fails to import | attempted, still **BLOCKED**: `Class extends value undefined` |
| `eslint-plugin-deprecation@3.0.0` | fails to import | attempted, still **BLOCKED**, same cause |

Both load failures are `@typescript-eslint/utils` doing `class extends eslint.LegacyESLint`. The
rescue pass tries them because the message names a removed API, and correctly reports that wrapping
rules cannot fix a crash that happens at import time.

## Findings from this phase

1. **A rescue must be scoped to the regression, not the plugin.** `eslint-plugin-node` crashes on
   ESLint 9 as well. Counting its pre-existing failures would have hidden the 8 rules ESLint 10
   broke; ignoring them entirely would have printed "all recover" to somebody who will still watch
   12 rules crash. The verdict uses the regression, and the report names the remainder separately.
2. **The skip reason should classify, not narrate.** The first version embedded the failing message
   in `skipReason`, which duplicated data already on the row and produced a 200-character terminal
   line. It is now a short classification (`not a removed context API`, `missing dependency`,
   `parser failure`) with the evidence left where it already lived.
3. **`fixupConfigRules()` almost never wins the measurement.** It applies the same `fixupRule()` to
   the same rules, so it can only beat `fixupPluginRules()` when the config's plugin object carries
   rules the top-level `rules` map does not. Across all 54 plugins it never did. Both paths are
   still measured and the winner recorded, per the brief, and the snippet writer supports both
   because a user consuming `plugin.configs['flat/recommended']` wants the config wrapped. Worth
   revisiting if it stays unused.
4. **Rules that live only inside a plugin's flat config are invisible to the probe.** They are
   recorded as a config prerequisite rather than linted, so such a plugin reads as clean and never
   reaches the rescue pass. Found while building a fixture for finding 3, now a documented
   limitation.

## House-rule audit

- **Clone check, difflib over function line lists.** Found two pairs above the 60% threshold, both
  introduced by this change: `snippet.ts:pluginNamespace` vs `types.ts:namespaceFor` at **92.3%**,
  and `report.ts:regressionOnTen` vs `rescue.ts:newlyBrokenOnTen` at **90.9%**. Both were the
  "duplicate across the package boundary and pin it with a test" shape. Extracted instead: the
  runner now imports `regressionOnTen` and `pluginNamespace` from the CLI's built output, exactly
  as `site/build.mjs` already imports `verdictFor`. "Blocked" now has one definition rather than
  two that a test hopes agree. Re-run: **0 pairs at or above 55%**.
- **Cost of that extraction, stated.** The runner now needs the CLI built first, so the nightly
  shard job runs `npm run build` instead of building only the runner, and `npm test` builds first.
- **Proof the probe refactor changed nothing.** `probe.mjs` had its lint-and-attribute flow pulled
  into a reusable `measure()` so the wrapped run reuses it. Recorded `probe-result.json` from
  `HEAD`'s probe and from the new one over five fixture plugins covering the clean fast path (513
  lint messages), rule-crash attribution, load failure, and both new fixtures: **byte for byte
  identical** on every case, with only the probe's own stack line numbers normalised.
- **Em dashes.** Checked through Node rather than a bash pattern, per the lesson that `$'...'`
  silently matches nothing. None in any README, CHANGELOG, PROGRESS or source comment.
- **Report text reviewed as output, not as code.** The first render put a 200-character BLOCKED
  line with two nested colons, repeated the crashing-rule list that the wrap makes irrelevant,
  named the residual rule twice, quoted an object key that needs no quotes
  (`plugins: { 'react': ... }`), and repeated the `npm install` line once per plugin. All fixed.
- **Backward compatibility.** Each entry's `reason` string is byte-identical to what v1.0.0
  produced; the rescue detail travels in a separate `rescue` object. `--ci` exit codes and the
  `ready` flag are unchanged, since a rescuable plugin still breaks a plain upgrade.

## Acceptance checks

| check | result |
| --- | --- |
| (1) full nightly pass completes, published JSON carries a non-BLOCKED rescue verdict | **yes**. The GitHub Actions nightly (4 shards, all green) published 54 plugins with 4 RESCUABLE, and every non-rescued attempt carries a classification. Its Linux runners reproduced the Windows numbers exactly: react 38 to 0, node 8 to 0, eslint-comments 8 to 0, lodash 1 to 0. |
| (2) `check` prints a snippet that makes `eslint .` stop crashing on ESLint 10, asserted end to end | **yes**, twice. `test/rescue.test.ts` installs a plugin that crashes on 10, runs the real `eslint` binary (exit 2, "not a function"), pastes the CLI's own printed snippet and re-runs clean. Repeated by hand against the real `eslint-plugin-react@7.37.5`: the #3977 crash, then exit 0. |
| (3) `npm test` green | **yes**, 63 tests, and CI green on ubuntu and windows for the merged commit |
| (4) README numbers match the committed `matrix.json` | **yes**, every count re-derived from `matrix.json` after the final run |
| three original buckets unchanged on the current corpus | **yes**. Ran v1.0.0's compiled `verdictFor` and this version's over the committed v1.0.0 matrix: identical verdicts on all 54 rows (42 clean, 7 blocked, 5 force). |
| published CLI resolves the live matrix from a clean install | **yes**, cache written, rescue tier and snippet printed, `--ci` exits 1 |
| site renders with no console errors | **yes**, driven over CDP through every filter, the search box, a row toggle and the empty state. The detector was self-tested with a deliberate `console.error` first, so "none" is a real result. |

## Shipped

| artifact | where |
| --- | --- |
| repo | https://github.com/Booyaka101/eslint10-matrix |
| PR | https://github.com/Booyaka101/eslint10-matrix/pull/1 (squash-merged, CI green on ubuntu and windows) |
| live matrix | https://booyaka101.github.io/eslint10-matrix/ (rescue tier deployed) |
| matrix.json | https://booyaka101.github.io/eslint10-matrix/matrix.json (7 rows carry `rescue`) |
| npm | https://www.npmjs.com/package/eslint10-matrix (1.1.0, `latest`, 21 files, 29.6 kB, zero runtime deps) |
| release | https://github.com/Booyaka101/eslint10-matrix/releases/tag/v1.1.0 (tag on 33e2776) |

### Publish record

Published from an authenticated local npm session as `booyaka`, no OTP prompt. Registry confirms
`1.1.0` as `latest` with shasum `98ad5270cac80d87e8bf34a95b939e03305f2bf0`, matching what was
uploaded. The tag points at 33e2776 while `main` has moved on with nightly matrix commits; the
packaged paths (`packages/cli/src`, `package.json`, `README.md`, `LICENSE`) are byte-identical
between the two, so the published artifact is the CI-verified tagged code. `matrix.json` is the
only difference and is not in the package.

`npm publish` warns that it auto-corrected `bin` from `./dist/index.js` to `dist/index.js`. That is
cosmetic normalisation npm applies at publish time, 1.0.0 shipped the same way, and the installed
binary works. Worth writing as `dist/index.js` in the manifest next time the file is touched.

### No provenance on 1.1.0

Same as 1.0.0: published from a local session, so no attestation, and npm forbids adding one after
the fact. To get provenance from the next version, create a classic Automation token, add it as the
`NPM_TOKEN` Actions secret, and publish from a workflow with `--provenance`. Both steps sit behind
npm's 2FA, so they are owner-operated (`LESSONS.md` 2026-08-20).

## v1.0.0 record

Kept for context: the original three buckets, the 54-plugin corpus, the `--legacy-peer-deps`
install method, the per-rule attribution loop, and the release notes are all as recorded at
2026-08-22. Nothing in v1.1.0 changes how the three original verdicts are computed.
