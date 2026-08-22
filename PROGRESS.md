# PROGRESS

Status at 2026-08-22: **v1.0.0 complete and verified locally. Not published** (publishing is owner-operated).

## Phase 0 verification (all re-fetched live on 2026-08-22)

| resource | result |
| --- | --- |
| `registry.npmjs.org/eslint-plugin-react/latest` | 7.37.5, peer `^3 \|\| … \|\| ^9.7`, matches brief |
| `registry.npmjs.org/eslint` | dist-tags `latest: 10.9.0`, `maintenance: 9.39.5`; 10.0.0 published 2026-02-06 |
| `registry.npmjs.org/eslint-plugin-jsx-a11y/latest` | 6.10.2, peer `^3 \|\| … \|\| ^9` |
| `registry.npmjs.org/eslint-plugin-import/latest` | 2.32.0, peer `^2 \|\| … \|\| ^9` |
| `eslint/eslint main tools/test-ecosystem/plugins-data.json` | 7 entries, fields `{commands, commit, repository}`, no `results` key |
| `jsx-eslint/eslint-plugin-react#3977` | open, created 2026-02-07, updated 2026-08-21, 355 reactions (341 👍), 45 comments; body names `contextOrFilename.getFilename is not a function` and `display-name` |
| issue comments | patrickconroy 2026-04-29 and stevensacks 2026-05-20 quotes present; ternaus announced the fork 2026-08-21 |
| `api.github.com/search/repositories?q=eslint+compatibility+matrix…` | `total_count: 0` |
| `@ternaus/eslint-plugin-react/latest` | 8.0.0, peer `^10.0.0` |

**Cost model: free.** Public npm registry, public GitHub API, GitHub Actions and Pages on a public repo. No paid key, account or hosting. Not blocked.

## Findings that shaped the build (none were in the brief)

1. **`npm install` cannot be plain.** Every plugin declaring `^9` makes npm refuse to resolve against ESLint 10 with `ERESOLVE`. The runner uses `--legacy-peer-deps`; installing past the declared range *is* the experiment.
2. **A crashing rule aborts the whole lint run.** The all-rules pass can only ever name the first casualty. When it fails, the probe re-lints one rule at a time. This is why `eslint-plugin-react` reports 38 crashing rules rather than 1.
3. **`files: ['**/*']` is a universal pattern.** ESLint does not treat it as making a file eligible; every fixture came back "File ignored because no matching configuration was supplied". Config uses explicit extension globs.
4. **Plugin configuration decides what breaks.** `eslint-plugin-react` only reaches the removed `context.getFilename()` API when detecting the React version. Without `settings: { react: { version: 'detect' } }` only 6 rules crash and `display-name` is not among them; with it, 38 crash including `display-name`. Testing in a configuration nobody uses would have understated the breakage and missed acceptance check (b).
5. **`typescript@latest` is TS 7.0, which typescript-eslint rejects.** It broke `@typescript-eslint/eslint-plugin`, `@angular-eslint/eslint-plugin`, `@eslint-react/eslint-plugin` and `eslint-plugin-deprecation` identically on *both* ESLint versions. Pinned to `typescript@^6`. A load-fail on ESLint 9 is almost always a runner bug, not a plugin bug. That symmetry is the tell.
6. **Windows `spawn` needs per-call `shell`.** npm resolves to `npm.cmd` (Node refuses to spawn a `.cmd` without a shell) while `process.execPath` lives under `C:\Program Files\...` and gets split in half by one.

7. **Typed-linting rules are not crashes.** 64 `@typescript-eslint` rules refuse to load without `parserOptions.project`, identically on 9 and 10. Counting them marked the most-installed plugin in the ecosystem as blocked over a `tsconfig` setting. They are now classified as config prerequisites, and the report only blocks on rules that break on 10 *and not* on 9.

## Acceptance checks, all run

| check | result |
| --- | --- |
| (a) full pass ≥40 plugins × 2 versions, validates against schema | **54 plugins, 108 pairs, 384s, schema valid** |
| (b) reproduces the react `display-name` crash on 10.9.0 | **yes**. `Error while loading rule 'react/display-name': contextOrFilename.getFilename is not a function`, 38 of 101 rules |
| (c) `check` in a scratch repo prints all three buckets + valid JSON overrides | **yes**. 7 real plugins resolved from a real `eslint.config.js` |
| (d) `--ci` exits 1 with a blocked plugin, 0 without | **yes**. 1 and 0 |
| (e) whole test suite passes | **38 tests, 3 files, pass** |
| (f) site renders to one static HTML file, no console errors | **yes**. driven in Chrome over CDP in a dedicated tab, hard reload with the recorder armed: `CONSOLE ERRORS/WARNINGS: NONE` |

## Also verified

- CLI packs to a tarball and installs into a clean directory (never tested via `npx .`, which is a silent no-op on Windows per `LESSONS.md` 2026-08-06).
- Error paths: no flat config, unreachable matrix, bad flag, missing matrix file, future schema version. All exit 2 with a message and no stack trace.
- Offline fallback: with the network unreachable, the cached copy at `~/.cache/eslint10-matrix` is used and the warning names its age.
- `plugins` subcommand lists all 54 rows with both versions' statuses.

## Notable real findings in the shipped matrix

- `eslint-plugin-jsx-a11y@6.10.2` declares `^9` and is completely clean on 10.9.0. The declared range is simply stale.
- `eslint-plugin-vitest@0.5.4` and `eslint-plugin-deprecation@3.0.0` fail to *import* on ESLint 10 through `@typescript-eslint/utils`, which does `class extends eslint.LegacyESLint`, an API ESLint 10 removed with eslintrc. Neither manifest hints at it.
- `@ternaus/eslint-plugin-react@8.0.0`, the fork announced in #3977 on 2026-08-21, declares `^10.0.0` and is clean. Its claim now has an independent execution behind it.

## House-rule audit

Run before the first commit, with tools rather than by eye.

- **Em dashes in outward-facing prose.** The first pass used a bash `$'...'` grep pattern and silently matched nothing, because bash never expanded the escape. Re-run through Node it found 23 lines across both READMEs and PROGRESS. All rewritten with periods and commas. Commit messages were already clean.
- **Clone check, difflib over function line lists.** `regressionOnTen` was duplicated between `packages/cli/src/report.ts` and `site/build.mjs` at **64%**, over the 60% threshold. The site also carried its own looser `satisfiesTen` instead of the CLI's `satisfies`, and the two disagreed on bounded ranges: a plugin declaring `>=9 <10` rendered as "ready" for ESLint 10 on the site while the CLI correctly said "safe to force". Extracted `verdictFor` in `report.ts` as the single place a matrix row becomes a verdict; the site imports it. Regression test added.
- **Proof the extraction changed nothing.** Built the site from `HEAD`'s `build.mjs` and from the new one over the committed `matrix.json`: the rendered HTML is **byte-for-byte identical**. The behaviour change is confined to the bug, demonstrated separately with a synthetic `>=9 <10` row (old "ready", new "safe to force").
- **Where the extraction stopped.** The remaining pairs at or above 55% are `fixtures/types.ts:worker` vs `run.ts:mapWithConcurrency` and `fixtures/esm-imports.mjs:fetchJson` vs `registry.ts:getJson`. Both sides of each pair are the lint corpus, which exists to be realistic source for plugins to lint, not product code to share. Deduplicating them would make the fixtures less idiomatic for no gain. The `readVersion`/`writeCache`/`readDependencies` pairs at 47 to 50% are the ordinary "try a file operation, fall back" shape over genuinely different workflows.
- **Comment density.** Two rationale essays trimmed to the constraint they document (the `CONFIG_ERROR` block in `probe.mjs` and the `--legacy-peer-deps` note in `run.ts`).

## Maintainability pass

- **The repo now lints itself**, on ESLint 10 with `typescript-eslint`, which for this project is dogfooding rather than housekeeping. It was the most obvious gap: a tool that measures ESLint readiness had no `eslint.config.js`. `npm run lint` is wired into CI. Typed rules are off deliberately, since they need `parserOptions.project`, the same prerequisite the matrix classifies separately.
- **`ruleIdFromError` had an unreachable branch and a real hole.** Its second regex repeated the first as an alternative, so `bare[1]` could never be reached. The guard against mistaking a module path for a rule id tested `includes('.js')`, which does not match `.cjs` or `.mjs`, so a path ending in either was returned as a rule id. Rewritten around named regexes with an anchored extension test, plus four tests covering bare ids, every module extension, stack-frame fallback, and the null case.
- **Dead code removed.** `pad(part, fill)` in `semver-lite.ts` was always called with a no-op ternary (`? 0 : 0`), so the parameter was removed. `run.ts` re-exported `classify` although nothing imports `run.ts` as a module.
- **Entrypoint guards unified.** `run.ts` compared `process.argv[1]` against a `dist/run.js` suffix, which breaks on rename; it now uses the same `import.meta.url` comparison as the CLI.
- **Schema drift pinned by a test.** The CLI redeclares the matrix shape because it ships standalone with no dependency on the private runner package. Two tests now push a runner-built matrix through the CLI loader and check both agree on every status.
- **10 raw ESC bytes** sat invisibly in the colour helpers in `report.ts`, now written as unicode escapes, with runtime colour output verified byte-identical afterwards. The `no-control-regex` error the linter raised was a separate matter: a test regex that matched ESC, now asserted with `toContain`.
- **Known gaps, deliberately not closed for v1.** `scripts/merge-shards.mjs` and the site's inline browser script have no unit tests; both are exercised end to end instead (the nightly workflow and the CDP render check). `probe.mjs` is the longest file at 271 lines and its `main()` carries the phase machine; splitting it would spread the phase transitions across files for no clear gain at this size.

## Left for the owner (cannot be done by an agent)

Per `LESSONS.md` 2026-08-20 and 2026-08-05, both of these are behind 2FA walls an agent cannot pass:

1. `npm publish` from `packages/cli` (decide on provenance *before* the first publish, because npm forbids adding an attestation to an already-published version).
2. `gh repo create --public --source=.`, push, then enable Pages from the Actions workflow.

After the repo exists, update `homepage`/`repository` in `packages/cli/package.json` and `DEFAULT_MATRIX_URL` in `packages/cli/src/matrix.ts` if the final repo name differs from `cbosch101/eslint10-matrix`.