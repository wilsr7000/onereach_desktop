import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'core', include: ['packages/core/src/**/*.test.ts'], environment: 'node' } },
      {
        plugins: [],
        test: { name: 'react', include: ['packages/react/src/**/*.test.tsx', 'packages/react/src/**/*.test.ts'], environment: 'jsdom', setupFiles: ['packages/react/src/test-setup.ts'] },
        esbuild: { jsx: 'automatic' },
      },
    ],
  },
});
