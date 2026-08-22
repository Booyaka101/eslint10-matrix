import react from './stubs/react.mjs';
import importPlugin from './stubs/import.mjs';
import promise from './stubs/promise.mjs';

export default [
  {
    files: ['**/*.js'],
    plugins: { promise },
    rules: { 'promise/always-return': 'error' },
  },
  [
    {
      files: ['**/*.jsx'],
      plugins: { react },
      settings: { react: { version: 'detect' } },
      rules: { 'react/display-name': 'error' },
    },
  ],
  {
    files: ['**/*.{js,jsx}'],
    plugins: { import: importPlugin },
    rules: { 'import/no-cycle': 'error' },
  },
];
