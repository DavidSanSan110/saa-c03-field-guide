import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['packages/*', 'tools/*', 'apps/*'],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**', 'tools/*/src/**'],
      // CLI entry points run in a child process (covered by their CLI tests, not measurable here).
      // React components are tested in a real browser (Playwright), not in jsdom (spec 012).
      exclude: ['**/*.test.*', '**/*.d.ts', 'tools/*/src/cli.ts', 'packages/*/src/**/*.tsx'],
      reporter: ['text', 'lcov'],
      // Pure-logic packages carry the core behaviour (PLAN.md §5.4).
      thresholds: { lines: 90, functions: 90, branches: 85, statements: 90 },
    },
  },
});
