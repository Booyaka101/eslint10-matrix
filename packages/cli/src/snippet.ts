import type { PluginRow, RescueResult } from './matrix.js';

/**
 * ESLint's own convention: eslint-plugin-x is referenced as `x`,
 * @scope/eslint-plugin as `@scope`, @scope/eslint-plugin-x as `@scope/x`.
 * Duplicated from the runner because the CLI ships standalone;
 * test/rescue.test.ts pins the two against each other.
 */
export function pluginNamespace(packageName: string): string {
  if (packageName.startsWith('@')) {
    const slash = packageName.indexOf('/');
    const scope = packageName.slice(0, slash);
    const rest = packageName.slice(slash + 1);
    if (rest === 'eslint-plugin') return scope;
    if (rest.startsWith('eslint-plugin-')) return `${scope}/${rest.slice('eslint-plugin-'.length)}`;
    return `${scope}/${rest}`;
  }
  return packageName.startsWith('eslint-plugin-')
    ? packageName.slice('eslint-plugin-'.length)
    : packageName;
}

/** `react` needs no quotes as an object key; `jsx-a11y` and `@typescript-eslint` do. */
function objectKey(namespace: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(namespace) ? namespace : `'${namespace}'`;
}

/** `jsx-a11y` -> jsxA11y, `@typescript-eslint` -> typescriptEslint. */
export function importBinding(namespace: string): string {
  const camel = namespace
    .replace(/^@/, '')
    .split(/[/-]/)
    .filter(Boolean)
    .map((part, i) => (i === 0 ? part : part[0]!.toUpperCase() + part.slice(1)))
    .join('');
  return /^[a-zA-Z_$]/.test(camel) ? camel : `plugin${camel}`;
}

/**
 * The copy-pasteable eslint.config.js wiring for a RESCUABLE or PARTIAL-RESCUE
 * plugin, using whichever @eslint/compat function the matrix measured as the
 * one that worked.
 */
export function rescueSnippet(row: Pick<PluginRow, 'name'>, rescue: RescueResult, eslintV10: string): string {
  const namespace = pluginNamespace(row.name);
  const binding = importBinding(namespace);
  const fn = rescue.fixupFunction ?? 'fixupPluginRules';
  const residual = rescue.residualRules ?? [];

  const rulesOff =
    residual.length > 0
      ? [
          '    rules: {',
          `      // still crash on ESLint ${eslintV10} even wrapped; keep them off`,
          ...residual.map((r) => `      '${namespace}/${r.rule}': 'off',`),
          '    },',
        ]
      : [];

  if (fn === 'fixupConfigRules' && rescue.fixupConfigKey) {
    return [
      `import { fixupConfigRules } from '@eslint/compat';`,
      `import ${binding} from '${row.name}';`,
      '',
      'export default [',
    '  // ...the rest of your config',
      `  ...fixupConfigRules(${binding}.configs['${rescue.fixupConfigKey}']),`,
      ...(rulesOff.length > 0 ? ['  {', ...rulesOff, '  },'] : []),
      '];',
      '',
    ].join('\n');
  }

  return [
    `import { fixupPluginRules } from '@eslint/compat';`,
    `import ${binding} from '${row.name}';`,
    '',
    'export default [',
    '  // ...the rest of your config',
    '  {',
    `    plugins: { ${objectKey(namespace)}: fixupPluginRules(${binding}) },`,
    ...rulesOff,
    '  },',
    '];',
    '',
  ].join('\n');
}
