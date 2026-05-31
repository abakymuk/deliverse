import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // vitest does not read tsconfig `paths`, so mirror the `@/*` alias here or
  // unit tests that import via `@/...` fail at module resolution.
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    exclude: ['node_modules', '.next', 'tests/e2e/**'],
    passWithNoTests: true,
  },
});
