/**
 * Log Server - CRUD Lifecycle Tests
 *
 * Lifecycle: POST log -> GET verify -> GET stats -> POST level change -> GET level -> Reset
 *
 * Run:  npx playwright test test/e2e/log-server-crud.spec.js
 */

const { test, expect } = require('@playwright/test');
const { _electron: electron } = require('playwright');
const path = require('path');
const {
  closeApp,
  LOG_SERVER,
  waitForHealth,
  getHealth,
  getStats,
  getLogLevel,
  setLogLevel,
  queryLogs,
} = require('./helpers/electron-app');

let electronApp;

test.beforeAll(async () => {
  electronApp = await electron.launch({
    args: [path.join(__dirname, '../../main.js')],
    env: { ...process.env, NODE_ENV: 'test', TEST_MODE: 'true', ELECTRON_RUN_AS_NODE: undefined },
    timeout: 30000,
  });
  await electronApp.firstWindow();
  await waitForHealth(40);
});

test.afterAll(async () => {
  // Reset to info level
  try {
    await setLogLevel('info');
  } catch {
    /* ok */
  }
  await closeApp({ electronApp });
});

// ═══════════════════════════════════════════════════════════════════
// LOG CRUD LIFECYCLE
// ═══════════════════════════════════════════════════════════════════

test.describe('Log Server CRUD Lifecycle', () => {
  test('Step 1: Create - POST a log event', async () => {
    const res = await fetch(`${LOG_SERVER}/logs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        level: 'info',
        category: 'crud-test',
        message: 'CRUD lifecycle test log entry',
        data: { testId: 'crud-lifecycle' },
      }),
    });
    expect(res.ok).toBe(true);
  });

  test('Step 2: Read - GET /logs with search', async () => {
    const logs = await queryLogs({ search: 'CRUD lifecycle test', limit: 5 });
    expect(logs).toBeDefined();
    const arr = logs?.logs ?? logs?.data ?? (Array.isArray(logs) ? logs : null);
    expect(arr != null && Array.isArray(arr)).toBe(true);
  });

  test('Step 3: Read - GET /logs/stats shows counts', async () => {
    const stats = await getStats();
    expect(stats).toBeDefined();
    expect(stats.byLevel || stats.total !== undefined).toBeTruthy();
  });

  test('Step 4: Update - POST /logging/level to debug', async () => {
    await setLogLevel('debug');
    const level = await getLogLevel();
    expect(level.level || level).toBe('debug');
  });

  test('Step 5: Read - GET /logging/level verifies change', async () => {
    const level = await getLogLevel();
    expect(level.level || level).toBe('debug');
  });

  test('Step 6: Reset - POST /logging/level back to info', async () => {
    await setLogLevel('info');
    const level = await getLogLevel();
    expect(level.level || level).toBe('info');
  });
});

// ═══════════════════════════════════════════════════════════════════
// HEALTH ENDPOINT
// ═══════════════════════════════════════════════════════════════════

test.describe('Log Server Health', () => {
  test('GET /health returns structured data', async () => {
    const health = await getHealth();
    expect(health.status).toBe('ok');
    expect(health.appVersion).toBeTruthy();
    expect(health.uptime).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════
// LOG EXPORT
// ═══════════════════════════════════════════════════════════════════

test.describe('Log Export', () => {
  test('GET /logs/export returns data', async () => {
    const res = await fetch(`${LOG_SERVER}/logs/export?format=json&limit=10`);
    expect(res.ok).toBe(true);
    const text = await res.text();
    expect(text.length).toBeGreaterThan(0);
  });
});
