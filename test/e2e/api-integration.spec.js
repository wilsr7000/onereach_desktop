/**
 * API Integration Tests
 *
 * Tests the REST API surfaces that the app exposes, without needing any
 * UI interaction.  These are the most automatable and deterministic tests.
 *
 * Launches its own Electron instance so it can run standalone or as part
 * of the full test:journey suite.
 *
 * Run:  npm run test:api
 *       npx playwright test test/e2e/api-integration.spec.js
 */

const { test, expect } = require('@playwright/test');
const { _electron: electron } = require('playwright');
const path = require('path');
const {
  closeApp,
  LOG_SERVER,
  SPACES_API,
  waitForHealth,
  getHealth,
  getStats,
  getLogLevel,
  setLogLevel,
  queryLogs,
  checkSpacesApi,
  listSpaces,
  createSpace,
  deleteSpace,
  sleep,
} = require('./helpers/electron-app');

let electronApp;

test.beforeAll(async () => {
  electronApp = await electron.launch({
    args: [path.join(__dirname, '../../main.js')],
    env: { ...process.env, NODE_ENV: 'test', TEST_MODE: 'true' },
    timeout: 30000
  });
  await electronApp.firstWindow();
  await waitForHealth(40);
});

test.afterAll(async () => {
  await closeApp({ electronApp });
});

test.describe('Log Server API (port 47292)', () => {

  test('GET /health returns status ok', async () => {
    const health = await getHealth();
    expect(health.status).toBe('ok');
    expect(health.appVersion).toBeTruthy();
    expect(health.port).toBe(47292);
    expect(health.uptime).toBeGreaterThan(0);
    expect(health.queue).toBeDefined();
    expect(health.queue.total).toBeGreaterThanOrEqual(0);
    expect(health.connections).toBeDefined();
  });

  test('GET /logs returns log entries', async () => {
    const data = await queryLogs({ limit: 5 });
    expect(data.count).toBeLessThanOrEqual(5);
    expect(data.data).toBeInstanceOf(Array);
    if (data.data.length > 0) {
      const entry = data.data[0];
      expect(entry).toHaveProperty('id');
      expect(entry).toHaveProperty('timestamp');
      expect(entry).toHaveProperty('level');
      expect(entry).toHaveProperty('category');
      expect(entry).toHaveProperty('message');
      expect(entry).toHaveProperty('v'); // Version stamp
    }
  });

  test('GET /logs filters by level', async () => {
    const data = await queryLogs({ level: 'error', limit: 10 });
    expect(data.data).toBeInstanceOf(Array);
    for (const entry of data.data) {
      expect(entry.level).toBe('error');
    }
  });

  test('GET /logs filters by category', async () => {
    const data = await queryLogs({ category: 'app', limit: 10 });
    expect(data.data).toBeInstanceOf(Array);
    for (const entry of data.data) {
      expect(entry.category).toBe('app');
    }
  });

  test('GET /logs/stats returns aggregated counts', async () => {
    const stats = await getStats();
    expect(stats).toHaveProperty('total');
    expect(stats).toHaveProperty('byLevel');
    expect(stats).toHaveProperty('byCategory');
    expect(stats.byLevel).toHaveProperty('info');
    expect(stats.byLevel).toHaveProperty('error');
  });

  test('GET /logging/level returns current level', async () => {
    const levelData = await getLogLevel();
    expect(levelData).toHaveProperty('level');
    expect(levelData).toHaveProperty('persisted');
    expect(levelData).toHaveProperty('validLevels');
    expect(levelData.validLevels).toContain('info');
    expect(levelData.validLevels).toContain('debug');
    expect(levelData.validLevels).toContain('off');
  });

  test('POST /logging/level changes level and persists', async () => {
    // Read original
    const original = await getLogLevel();

    // Change to debug
    const result = await setLogLevel('debug');
    expect(result.success).toBe(true);
    expect(result.level).toBe('debug');

    // Verify
    const after = await getLogLevel();
    expect(after.level).toBe('debug');
    expect(after.persisted).toBe('debug');

    // Restore
    await setLogLevel(original.persisted || 'info');
  });

  test('POST /logging/level rejects invalid level', async () => {
    const res = await fetch(`${LOG_SERVER}/logging/level`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ level: 'invalid' })
    });
    const data = await res.json();
    expect(res.status).toBe(400);
    expect(data.error).toBeTruthy();
  });

  test('POST /logs pushes external event and can query it back', async () => {
    const marker = `test-marker-${Date.now()}`;
    const res = await fetch(`${LOG_SERVER}/logs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        level: 'info',
        category: 'test',
        message: marker,
        source: 'e2e-test'
      })
    });
    expect(res.ok).toBe(true);

    // Query it back
    await sleep(200); // Brief delay for ingestion
    const data = await queryLogs({ search: marker, limit: 5 });
    const found = data.data.find(e => e.message === marker);
    expect(found).toBeTruthy();
    expect(found.source).toBe('external'); // Log server stamps external source
    expect(found.category).toBe('test');
  });
});

test.describe('Spaces API (port 47291)', () => {

  test('Spaces API is reachable', async () => {
    const alive = await checkSpacesApi();
    expect(alive).toBe(true);
  });

  test('GET /api/spaces returns array of spaces', async () => {
    const spaces = await listSpaces();
    expect(spaces).toBeInstanceOf(Array);
  });

  test('CRUD: create, read, delete a test space', async () => {
    const name = `E2E Test Space ${Date.now()}`;

    // Create
    const created = await createSpace(name, 'Automated test space');
    expect(created).toBeDefined();
    const spaceId = created.id || created.spaceId;
    expect(spaceId).toBeTruthy();

    // Verify it appears in the list
    const spaces = await listSpaces();
    const found = spaces.find(s => (s.id || s.spaceId) === spaceId);
    expect(found).toBeTruthy();

    // Delete
    const deleted = await deleteSpace(spaceId);
    expect(deleted).toBe(true);

    // Verify it's gone
    await sleep(300);
    const spacesAfter = await listSpaces();
    const stillThere = spacesAfter.find(s => (s.id || s.spaceId) === spaceId);
    expect(stillThere).toBeFalsy();
  });
});
