/**
 * One rule that only works under the fixture parser, mirroring a
 * typescript-eslint rule reading a field espree never produces.
 */
export default {
  meta: { name: 'eslint-plugin-fixture-parser-field', version: '1.0.0' },
  rules: {
    'needs-parser-field': {
      meta: { type: 'problem', schema: [] },
      create(context) {
        return {
          Program(node) {
            if (node.parsedByFixtureParser.files.length > 0) context.report({ node, message: 'parsed' });
          },
        };
      },
    },
  },
};
