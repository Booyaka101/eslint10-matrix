/** Reports the working directory the probe process was given, as a crash message. */
export default {
  meta: { name: 'eslint-plugin-fixture-cwd', version: '1.0.0' },
  rules: {
    'reports-cwd': {
      meta: { type: 'problem', schema: [] },
      create() {
        throw new Error(`ran in ${process.cwd()}`);
      },
    },
  },
};
