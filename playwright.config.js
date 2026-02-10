const { defineConfig, devices } = require('@playwright/test');

/**
 * Playwright configuration for Onereach.ai E2E tests
 *
 * Test structure:
 *   test/e2e/              -- Legacy & smoke tests (window-smoke, api-integration, etc.)
 *   test/e2e/products/     -- Consolidated product-level test suites
 *
 * Commands:
 *   npm run test:e2e           -- All E2E tests (both legacy and product suites)
 *   npm run test:e2e:products  -- Only product-level suites
 *   npm run test:e2e:smoke     -- Quick smoke tests (windows + API)
 *   npm run test:e2e:journey   -- Full journey (smoke + spaces + settings)
 *
 * @see https://playwright.dev/docs/test-configuration
 */
module.exports = defineConfig({
  testDir: './test/e2e',

  /* Maximum time one test can run for */
  timeout: 60 * 1000,

  /* Global setup/teardown timeout (covers Electron launch + close) */
  globalTimeout: 15 * 60 * 1000, // 15 minutes for the full suite

  /* Run tests in files in parallel */
  fullyParallel: false,

  /* Fail the build on CI if you accidentally left test.only in the source code */
  forbidOnly: !!process.env.CI,

  /* Retry on CI only */
  retries: process.env.CI ? 2 : 0,

  /* Opt out of parallel tests on CI */
  workers: 1, // Electron tests must be serial (single app instance)

  /* Reporter to use */
  reporter: [
    ['html', { outputFolder: 'test-results/html' }],
    ['json', { outputFile: 'test-results/results.json' }],
    ['list']
  ],

  /* Shared settings for all the projects below */
  use: {
    /* Base URL for API testing */
    baseURL: 'http://localhost:47292',

    /* Collect trace when retrying the failed test */
    trace: 'on-first-retry',

    /* Screenshot on failure */
    screenshot: 'only-on-failure',

    /* Video on failure */
    video: 'retain-on-failure',
  },

  /* Configure projects */
  projects: [
    {
      name: 'electron',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1400, height: 900 },
      },
    },
  ],

  /* Folder for test artifacts such as screenshots, videos, traces, etc. */
  outputDir: 'test-results/artifacts',

  /* Expect configuration */
  expect: {
    timeout: 10000,
  },
});
