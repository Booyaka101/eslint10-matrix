/** Reports on essentially every node, so a clean verdict has to survive a flood of lint errors. */
export default {
  meta: { name: 'eslint-plugin-fixture-reporting', version: '1.0.0' },
  rules: {
    'no-identifiers-at-all': {
      meta: { type: 'suggestion', schema: [] },
      create(context) {
        return {
          Identifier(node) {
            context.report({ node, message: `identifier "${node.name}" is not allowed` });
          },
        };
      },
    },
    'no-literals-at-all': {
      meta: { type: 'suggestion', schema: [] },
      create(context) {
        return {
          Literal(node) {
            context.report({ node, message: 'literals are not allowed' });
          },
        };
      },
    },
  },
};
