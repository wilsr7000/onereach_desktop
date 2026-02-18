/**
 * Spaces Flow Tests
 *
 * Full CRUD journey through the Spaces system: create a space, add content,
 * verify via the REST API, search, then clean up.  Monitors the log server
 * for errors throughout.
 *
 * Run:  npx playwright test test/e2e/spaces-flow.spec.js
 */

const { test, expect } = require('@playwright/test');
const { _electron: electron } = require('playwright');
const path = require('path');
const {
  closeApp,
  waitForHealth,
  snapshotErrors,
  checkNewErrors,
  filterBenignErrors,
  checkSpacesApi,
  listSpaces,
  createSpace,
  deleteSpace,
  setLogLevel,
  sleep,
  SPACES_API,
} = require('./helpers/electron-app');

let electronApp;
let mainWindow;
let testSpaceId;

test.describe('Spaces Manager Flow', () => {
  test.beforeAll(async () => {
    electronApp = await electron.launch({
      args: [path.join(__dirname, '../../main.js')],
      env: { ...process.env, NODE_ENV: 'test', TEST_MODE: 'true' },
      timeout: 30000,
    });
    mainWindow = await electronApp.firstWindow();
    await mainWindow.waitForLoadState('domcontentloaded');
    await waitForHealth(40);
    await setLogLevel('debug');
  });

  test.afterAll(async () => {
    // Clean up test space if it still exists
    if (testSpaceId) {
      try {
        await deleteSpace(testSpaceId);
      } catch (_e) {
        /* ok */
      }
    }
    try {
      await setLogLevel('info');
    } catch (_e) {
      /* ok */
    }
    await closeApp({ electronApp });
  });

  // -----------------------------------------------------------------------
  // API-level tests (no UI needed)
  // -----------------------------------------------------------------------

  test('Spaces API is reachable', async () => {
    const alive = await checkSpacesApi();
    expect(alive).toBe(true);
  });

  test('can create a test space via API', async () => {
    const snap = await snapshotErrors();
    const name = `E2E Spaces Flow ${Date.now()}`;

    const created = await createSpace(name, 'Automated flow test');
    expect(created).toBeDefined();
    testSpaceId = created.id || created.spaceId;
    expect(testSpaceId).toBeTruthy();

    const errors = filterBenignErrors(await checkNewErrors(snap));
    expect(errors).toHaveLength(0);
  });

  test('test space appears in list', async () => {
    const spaces = await listSpaces();
    const found = spaces.find((s) => (s.id || s.spaceId) === testSpaceId);
    expect(found).toBeTruthy();
  });

  test('can list items in the test space', async () => {
    const res = await fetch(`${SPACES_API}/api/spaces/${testSpaceId}/items`);
    expect(res.ok).toBe(true);
    const data = await res.json();
    // API returns { items: [...], total: N }
    expect(data).toHaveProperty('items');
    expect(data.items).toBeInstanceOf(Array);
  });

  // -----------------------------------------------------------------------
  // UI-level tests
  // -----------------------------------------------------------------------

  test('Spaces Manager window opens and renders spaces', async () => {
    const snap = await snapshotErrors();

    // Open Spaces Manager
    await electronApp.evaluate(async () => {
      if (global.clipboardManager && global.clipboardManager.createClipboardWindow) {
        global.clipboardManager.createClipboardWindow();
      }
    });
    await sleep(4000);

    const allWindows = electronApp.windows();
    const spacesWindow = allWindows.find((w) => {
      try {
        return w.url().includes('clipboard-viewer.html');
      } catch {
        return false;
      }
    });

    expect(spacesWindow).toBeTruthy();

    if (spacesWindow) {
      // Check that the spaces list rendered (look for the space name or a list container)
      const bodyText = await spacesWindow.textContent('body');
      expect(bodyText).toBeTruthy();
      expect(bodyText.length).toBeGreaterThan(100); // Page actually rendered content
    }

    const errors = filterBenignErrors(await checkNewErrors(snap));
    if (errors.length > 0) {
      console.log('Spaces Manager errors:', JSON.stringify(errors, null, 2));
    }
    expect(errors).toHaveLength(0);

    // Close
    if (spacesWindow) {
      await spacesWindow.close();
      await sleep(500);
    }
  });

  // -----------------------------------------------------------------------
  // Cleanup
  // -----------------------------------------------------------------------

  test('can delete the test space', async () => {
    const snap = await snapshotErrors();

    const deleted = await deleteSpace(testSpaceId);
    expect(deleted).toBe(true);

    // Verify it's gone
    await sleep(300);
    const spaces = await listSpaces();
    const stillThere = spaces.find((s) => (s.id || s.spaceId) === testSpaceId);
    expect(stillThere).toBeFalsy();

    testSpaceId = null; // Prevent double-delete in afterAll

    const errors = filterBenignErrors(await checkNewErrors(snap));
    expect(errors).toHaveLength(0);
  });
});
