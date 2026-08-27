/**
 * Crashes on ESLint 10 only through context.getFilename(), which @eslint/compat
 * restores, so the wrap must recover every rule.
 */
export default {
  meta: { name: 'eslint-plugin-fixture-removed-api', version: '1.0.0' },
  rules: {
    'uses-filename': {
      meta: { type: 'problem', schema: [] },
      create(context) {
        const filename = context.getFilename();
        return {
          Program(node) {
            if (filename.endsWith('.jsx')) context.report({ node, message: 'jsx file seen' });
          },
        };
      },
    },
    'uses-physical-filename': {
      meta: { type: 'problem', schema: [] },
      create(context) {
        return {
          Program(node) {
            context.getPhysicalFilename();
            context.report({ node, message: 'physical filename inspected' });
          },
        };
      },
    },
  },
};
