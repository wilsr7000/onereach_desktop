import { defineConfig } from '@playwright/test';
import * as path from 'node:path';

const liteRoot = __dirname;

export default defineConfig({
  testDir: path.join(liteRoot, 'test', 'e2e'),
  fullyParallel: false, // Electron tests should run serially -- only one app launch at a time
  workers: 1,
  reporter: process.env.CI ? [['list'], ['junit', { outputFile: 'test-results/junit.xml' }]] : 'list',
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 5_000 },
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
