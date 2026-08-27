/**
 * One rule crashes through a removed API @eslint/compat restores, the other
 * through a method that never existed, so the wrap recovers exactly half.
 */
export default {
  meta: { name: 'eslint-plugin-fixture-partial', version: '1.0.0' },
  rules: {
    'fixable-filename': {
      meta: { type: 'problem', schema: [] },
      create(context) {
        context.getFilename();
        return {};
      },
    },
    'beyond-compat': {
      meta: { type: 'problem', schema: [] },
      create(context) {
        context.getSourceCodeThatNoLongerExists();
        return {};
      },
    },
  },
};
