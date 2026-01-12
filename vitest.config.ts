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
      'build/**'
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

