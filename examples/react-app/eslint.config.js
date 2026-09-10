import importPlugin from 'eslint-plugin-import';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import promise from 'eslint-plugin-promise';
import react from 'eslint-plugin-react';
import vitest from 'eslint-plugin-vitest';

export default [
  { ignores: ['dist/**', 'coverage/**'] },
  {
    files: ['**/*.{js,jsx}'],
    languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } },
    settings: { react: { version: '18.3' } },
    plugins: { react, 'jsx-a11y': jsxA11y, import: importPlugin, promise },
    rules: {
      'react/display-name': 'error',
      'react/prop-types': 'error',
      'jsx-a11y/alt-text': 'error',
      'import/no-cycle': 'error',
      'promise/always-return': 'error',
    },
  },
  {
    files: ['**/*.test.js'],
    plugins: { vitest },
    rules: {
      'vitest/expect-expect': 'error',
      'vitest/no-identical-title': 'error',
    },
  },
];
