/**
 * The ESLint pair `scan` measures against: the current latest and the
 * maintenance line the board also tests. ESLint 9 went end of life on
 * 2026-08-06, so 9.x is a baseline for "was it already broken", not a target.
 */
export const TESTED_ESLINT = { v9: '9.39.5', v10: '10.10.0' } as const;
