import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // viewer/ and scripts/ are plain browser/node JS, outside the TS program. Linted for
  // syntax, but the type-aware rules cannot see them.
  // `.claude/` holds git worktrees, which are full checkouts nested inside this one. Without
  // it eslint walks into them and reports every file twice -- once at its real path and once
  // under the worktree, where the ignore patterns above no longer match and the type-aware
  // rules have no tsconfig to work from.
  { ignores: ['node_modules/', 'dist/', 'reports/', 'tests/fixtures/', 'viewer/', 'scripts/', '.claude/'] },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  // This file isn't part of the TS program, so the type-aware rules can't run on it.
  { files: ['eslint.config.js'], ...tseslint.configs.disableTypeChecked },

  {
    languageOptions: {
      parserOptions: {
        // Neither config file is part of the TS program; let the parser handle them anyway
        // rather than leaving the tooling config itself unlinted.
        projectService: { allowDefaultProject: ['eslint.config.js', 'vitest.config.ts'] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Surfacing an unawaited promise matters here: a dropped `await` on a page visit or a
      // link probe would silently skip work and still report a clean run.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',

      // An underscore prefix marks a deliberately unused binding.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],

      // Empty catch blocks are load-bearing in the browser-interaction code (a selector that
      // doesn't resolve, storage that isn't available). Each one carries a comment saying so.
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },

  {
    // page.evaluate() bodies run in the browser, where the DOM types are honest but
    // TypeScript's view of the return value is necessarily loose.
    files: ['src/crawler.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
    },
  },

  {
    files: ['tests/**'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
    },
  },
);
