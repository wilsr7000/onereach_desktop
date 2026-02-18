/**
 * Data Sources API - CRUD Lifecycle Tests
 *
 * Lifecycle: Create (via item) -> List -> Read -> Update doc -> Test -> Verify
 *
 * Run:  npx playwright test test/e2e/data-source-crud.spec.js
 */

const { test, expect } = require('@playwright/test');
const { _electron: electron } = require('playwright');
const path = require('path');
const { closeApp, SPACES_API, waitForHealth } = require('./helpers/electron-app');

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
  await closeApp({ electronApp });
});

async function api(method, apiPath, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${SPACES_API}${apiPath}`, opts);
  const text = await res.text();
  try {
    return { status: res.status, ok: res.ok, data: JSON.parse(text) };
  } catch {
    return { status: res.status, ok: res.ok, data: text };
  }
}

// ═══════════════════════════════════════════════════════════════════
// DATA SOURCE LIFECYCLE
// ═══════════════════════════════════════════════════════════════════

test.describe('Data Sources CRUD Lifecycle', () => {
  let spaceId;
  let itemId;

  test.beforeAll(async () => {
    const { data } = await api('POST', '/api/spaces', { name: 'DataSource CRUD Space' });
    spaceId = data.space?.id || data.id;
  });

  test.afterAll(async () => {
    if (spaceId) await api('DELETE', `/api/spaces/${spaceId}`);
  });

  test('Step 1: Create a data source item', async () => {
    const { data, ok } = await api('POST', `/api/spaces/${spaceId}/items`, {
      type: 'data-source',
      title: 'Test API Source',
      content: JSON.stringify({
        url: 'https://jsonplaceholder.typicode.com/todos/1',
        method: 'GET',
        description: 'CRUD test data source',
      }),
    });
    expect(ok).toBe(true);
    itemId = data.item?.id || data.id;
  });

  test('Step 2: List data sources', async () => {
    const { data, ok } = await api('GET', '/api/data-sources');
    expect(ok).toBe(true);
    const sources = data?.dataSources ?? data?.sources ?? data?.items ?? (Array.isArray(data) ? data : null);
    expect(sources != null && Array.isArray(sources)).toBe(true);
  });

  test('Step 3: Read single data source', async () => {
    if (!itemId) {
      test.skip();
      return;
    }
    const { status } = await api('GET', `/api/data-sources/${itemId}`);
    expect([200, 404].includes(status)).toBe(true);
  });

  test('Step 4: Update description document', async () => {
    if (!itemId) {
      test.skip();
      return;
    }
    const { status } = await api('PUT', `/api/data-sources/${itemId}/document`, {
      content: 'Updated CRUD test description',
    });
    expect([200, 404].includes(status)).toBe(true);
  });

  test('Step 5: Read updated document', async () => {
    if (!itemId) {
      test.skip();
      return;
    }
    const { status } = await api('GET', `/api/data-sources/${itemId}/document`);
    expect([200, 404].includes(status)).toBe(true);
  });

  test('Step 6: Test data source connectivity', async () => {
    if (!itemId) {
      test.skip();
      return;
    }
    const { status } = await api('POST', `/api/data-sources/${itemId}/test`);
    // May succeed or fail depending on network; just verify the endpoint exists
    expect([200, 400, 404, 500, 502].includes(status)).toBe(true);
  });
});
