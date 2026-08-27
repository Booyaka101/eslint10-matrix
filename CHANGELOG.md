# Changelog

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
