/**
 * The one --flag parser the screenshot scripts share. `spec` says how each flag
 * takes its value: 'string', 'number', or 'list' for one that may repeat. Every
 * flag starts empty ('', 0, []) unless `seed` gives it something better.
 */
export function parseFlags(argv, spec, usage, seed = {}) {
  const opts = {};
  for (const [flag, kind] of Object.entries(spec)) {
    opts[name(flag)] = kind === 'list' ? [] : kind === 'number' ? 0 : '';
  }
  Object.assign(opts, seed);

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const kind = spec[flag];
    if (!kind) throw new Error(`unknown argument ${flag}\n${usage}`);
    const value = argv[++i];
    if (value === undefined) throw new Error(`${flag} needs a value\n${usage}`);
    if (kind === 'list') opts[name(flag)].push(value);
    else opts[name(flag)] = kind === 'number' ? Number(value) : value;
  }
  return opts;
}

function name(flag) {
  return flag.replace(/^--/, '');
}

/**
 * Report a hand-run script's failures as one line rather than a stack. The two
 * things that actually go wrong are a mistyped flag and a missing file, and a
 * stack buries both. A top-level await that rejects arrives here rather than as
 * an unhandled rejection, so one handler covers the whole script without
 * wrapping it in a main().
 */
export function reportFailures(script) {
  process.on('uncaughtException', (err) => {
    console.error(`${script}: ${err.message}`);
    process.exit(1);
  });
}
