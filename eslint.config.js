import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * This repo measures ESLint 10 plugin compatibility, so it lints itself on
 * ESLint 10. Typed rules are deliberately off: they need parserOptions.project,
 * which is the same config prerequisite the matrix classifies separately.
 */
export default [
  {
    ignores: [
      'packages/*/dist/',
      'site/dist/',
      'packages/runner/fixtures/',
      'test/fixtures/',
      'matrix.json',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { console: 'readonly', process: 'readonly', fetch: 'readonly', AbortController: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly', Buffer: 'readonly', URL: 'readonly' },
    },
    rules: {
      'no-console': 'off',
      eqeqeq: ['error', 'smart'],
      'no-var': 'error',
      'prefer-const': 'error',
      'object-shorthand': 'error',
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
];
