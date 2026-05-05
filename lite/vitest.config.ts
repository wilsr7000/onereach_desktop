import { defineConfig } from 'vitest/config';
import * as path from 'node:path';

export default defineConfig({
  test: {
    name: 'lite',
    root: path.resolve(__dirname),
    include: ['test/unit/**/*.test.ts', 'test/integration/**/*.test.ts'],
    exclude: ['test/e2e/**', 'test/harness/**', 'node_modules/**'],
    environment: 'node',
    globals: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['**/*.ts'],
      exclude: [
        'test/**',
        '**/*.test.ts',
        '**/*.config.ts',
        '**/*.config.mjs',
        'esbuild.config.mjs',
        'scripts/**',
      ],
      // Test harness modules live under test/harness/ and are already
      // excluded by the test/** glob above; listed here for clarity.
      thresholds: {
        lines: 80,
        branches: 75,
        functions: 80,
        statements: 80,
      },
    },
    testTimeout: 5000,
  },
});
