import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Environment settings
    environment: 'node',
    
    // Include patterns for test files
    include: [
      'test/**/*.test.{js,ts}',
      'test/**/*.eval.{js,ts}'
    ],
    
    // Exclude patterns
    exclude: [
      'node_modules/**',
      'dist/**',
      'build/**',
      // Standalone integration harnesses named *.test.js but NOT vitest suites
      // (no describe/it; own main()+process.exit; require live Edison/LLM creds).
      // They remain runnable via their documented `node`/`electron` commands.
      'test/unit/evaluate-flow-logs.test.js',
      'test/unit/flow-library-suggestions.test.js',
      'test/unit/tickets-intent-corpus.test.js'
    ],
    
    // Setup files run before each test file
    setupFiles: ['./test/setup.js'],
    
    // Longer timeout for LLM calls in evals
    testTimeout: 60000,
    
    // Coverage configuration
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: './coverage',
      threshold: {
        global: {
          lines: 80,
          functions: 80,
          branches: 70,
          statements: 80
        }
      },
      exclude: [
        'test/**',
        '**/*.test.js',
        '**/*.eval.js',
        'node_modules/**',
        'dist/**',
        'build/**'
      ]
    },
    
    // Reporter configuration
    reporters: ['verbose'],
    
    // Global test options
    globals: true
  }
});


