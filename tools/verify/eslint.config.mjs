// =============================================================================
// LINT — catch the one class of bug that has taken this app down twice.
//
// Both times it was a name that did not exist. `fixedPool`, left behind when a
// replacement matched inside the wrong function. `path`, left behind when
// buildPowerupVia stopped computing a route itself. Both parse perfectly: a
// syntax check has nothing to say about them, and the first anyone hears is a
// white page and a screenshot from the user.
//
// So this is deliberately narrow. It is not a style opinion and it does not
// care about formatting — it answers one question, does every name resolve, and
// the same for unreachable code and duplicate keys, which are always mistakes
// rather than choices. Anything that would produce noise a reader learns to
// scroll past is off, because a check nobody reads is not a check.
// =============================================================================

import globals from 'globals';

export default [
  {
    files: ['js/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        // Loaded from a CDN at runtime and referenced by name.
        ResizeObserver: 'readonly',
        // These modules are imported by the node tools as well as the page, so
        // a few of them ask whether they are in node at all. Every use is
        // behind `typeof process !== 'undefined'`, which is the correct guard —
        // the linter simply has no way to see that from the identifier.
        process: 'readonly',
      },
    },
    linterOptions: { reportUnusedDisableDirectives: true },
    rules: {
      'no-undef': 'error',
      'no-unreachable': 'error',
      'no-dupe-keys': 'error',
      'no-dupe-args': 'error',
      'no-dupe-else-if': 'error',
      'no-duplicate-case': 'error',
      'no-func-assign': 'error',
      'no-import-assign': 'error',
      'no-obj-calls': 'error',
      'no-self-assign': 'error',
      'no-setter-return': 'error',
      'no-sparse-arrays': 'error',
      'no-unsafe-negation': 'error',
      'use-isnan': 'error',
      'valid-typeof': 'error',
      // A variable assigned and never read is usually a rename that only got
      // half done — the same shape as the two crashes above. Arguments are
      // exempt: a handler that ignores its event is normal and correct.
      'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }],
    },
  },
  {
    files: ['tools/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser },
    },
    rules: { 'no-undef': 'error', 'no-unreachable': 'error', 'no-dupe-keys': 'error' },
  },
];
