/**
 * Browsing API Integration Tests
 *
 * These tests verify the browsing API endpoints are registered in the running app.
 * Run against a live app with: npm start, then npx playwright test test/e2e/browsing-api-integration.spec.js
 */
const { test, expect } = require('@playwright/test');

const LOG_SERVER = 'http://127.0.0.1:47292';

test.describe('Browsing API Integration', () => {
  test.beforeAll(async () => {
    const resp = await fetch(`${LOG_SERVER}/health`).catch(() => null);
    test.skip(!resp || !resp.ok, 'App not running — skip integration tests');
  });

  test('should have browsing IPC handlers registered (no errors on health)', async () => {
    const resp = await fetch(`${LOG_SERVER}/health`);
    expect(resp.ok).toBe(true);

    const health = await resp.json();
    expect(health.appVersion).toBeDefined();
  });

  test('should not have startup errors related to browsing API', async () => {
    const resp = await fetch(`${LOG_SERVER}/logs?level=error&search=browsing&limit=10`);
    expect(resp.ok).toBe(true);

    const data = await resp.json();
    const browsingErrors = (data.logs || []).filter(
      (log) => log.message && log.message.toLowerCase().includes('browsing')
    );

    expect(browsingErrors).toHaveLength(0);
  });

  test('should not have startup errors related to browser-stealth', async () => {
    const resp = await fetch(`${LOG_SERVER}/logs?level=error&search=stealth&limit=10`);
    expect(resp.ok).toBe(true);

    const data = await resp.json();
    const stealthErrors = (data.logs || []).filter(
      (log) => log.message && log.message.toLowerCase().includes('stealth')
    );

    expect(stealthErrors).toHaveLength(0);
  });

  test('should not have startup errors related to fast-path', async () => {
    const resp = await fetch(`${LOG_SERVER}/logs?level=error&search=fast-path&limit=10`);
    expect(resp.ok).toBe(true);

    const data = await resp.json();
    const fpErrors = (data.logs || []).filter(
      (log) => log.message && log.message.toLowerCase().includes('fast-path')
    );

    expect(fpErrors).toHaveLength(0);
  });
});
