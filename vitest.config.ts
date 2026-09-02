import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // `.claude/` holds git worktrees — full checkouts nested inside this one. Without this
    // every test file is collected twice, once at its real path and once through the
    // worktree, so the suite silently doubles and a failure can be reported against a
    // checkout you are not editing.
    exclude: ['**/node_modules/**', '**/dist/**', '.claude/**'],
  },
});
