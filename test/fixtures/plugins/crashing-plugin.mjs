/** One rule that throws the moment the linter builds its listeners. */
export default {
  meta: { name: 'eslint-plugin-fixture-crashing', version: '1.0.0' },
  rules: {
    'explodes-on-program': {
      meta: { type: 'problem', schema: [] },
      create(context) {
        // Mirrors the real ESLint 10 breakage: a rule reaching for an API that is gone.
        context.getSourceCodeThatNoLongerExists();
        return {};
      },
    },
  },
};
