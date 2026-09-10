import lazyImport from 'eslint-plugin-fixture-lazy-import';

export default [
  { ignores: ['build/**'] },
  {
    files: ['**/*.{js,jsx}'],
    plugins: { fixture: lazyImport },
    settings: { fixture: { allowTopLevel: false } },
    rules: { 'fixture/no-lazy-import': 'error' },
  },
];
