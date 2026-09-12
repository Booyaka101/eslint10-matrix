/**
 * Stands in for a plugin's own parser: espree plus one field on the Program
 * node, the way @typescript-eslint/parser adds the type information its rules
 * read. A rule that reads that field is fine here and throws under espree.
 */
import * as espree from 'espree';

export function parseForESLint(code, options) {
  const ast = espree.parse(code, { ...options, loc: true, range: true, comment: true, tokens: true });
  ast.parsedByFixtureParser = { files: [options?.filePath ?? '(unknown)'] };
  return { ast, scopeManager: null, visitorKeys: null };
}

export default { parseForESLint };
