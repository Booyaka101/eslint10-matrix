/** Fails at module evaluation, the way a plugin does when a removed ESLint export is missing. */
throw new Error("Cannot find module 'eslint/use-at-your-own-risk/removed-in-10'");

// eslint-disable-next-line no-unreachable
export default { rules: {} };
