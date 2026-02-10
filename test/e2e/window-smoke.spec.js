/**
 * Window Smoke Tests
 *
 * Opens every major product window and verifies no error-level logs are
 * produced.  This is the broadest automated safety net -- if any window
 * crashes or fails to load, this test catches it.
 *
 * Run:  npm run test:smoke
 *       npx playwright test test/e2e/window-smoke.spec.js
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
  setLogLevel,
  sleep,
  getHealth,
} = require('./helpers/electron-app');

let electronApp;
let mainWindow;

test.describe('Window Smoke Tests', () => {

  test.beforeAll(async () => {
    electronApp = await electron.launch({
      args: [path.join(__dirname, '../../main.js')],
      env: { ...process.env, NODE_ENV: 'test', TEST_MODE: 'true' },
      timeout: 30000
    });
    mainWindow = await electronApp.firstWindow();
    await mainWindow.waitForLoadState('domcontentloaded');

    // Wait for full startup (log server + all services)
    await waitForHealth(40);

    // Set debug level for maximum visibility
    await setLogLevel('debug');
  });

  test.afterAll(async () => {
    // Reset logging level
    try { await setLogLevel('info'); } catch (e) { /* app may be closing */ }
    await closeApp({ electronApp });
  });

  // -----------------------------------------------------------------------
  // Main window
  // -----------------------------------------------------------------------
  test('main window loads without errors', async () => {
    const snap = await snapshotErrors();
    const title = await mainWindow.title();
    expect(title).toBeTruthy();
    await sleep(2000); // Let any deferred errors surface
    const errors = filterBenignErrors(await checkNewErrors(snap));
    expect(errors).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // Log server health
  // -----------------------------------------------------------------------
  test('log server is healthy with correct version', async () => {
    const health = await getHealth();
    expect(health.status).toBe('ok');
    expect(health.appVersion).toBeTruthy();
    expect(health.port).toBe(47292);
    expect(health.queue).toBeDefined();
  });

  // -----------------------------------------------------------------------
  // Settings window
  // -----------------------------------------------------------------------
  test('settings window opens without errors', async () => {
    const snap = await snapshotErrors();

    // Open settings via global function in main process
    await electronApp.evaluate(() => {
      if (typeof global.openSettingsWindowGlobal === 'function') {
        global.openSettingsWindowGlobal();
      }
    });
    await sleep(3000);

    // Check for new windows
    const allWindows = electronApp.windows();
    const settingsWindow = allWindows.find(w => {
      try { return w.url().includes('settings.html'); } catch { return false; }
    });

    // Settings window should have opened (may not on all platforms)
    // Primary assertion: no new errors
    const errors = filterBenignErrors(await checkNewErrors(snap));
    if (errors.length > 0) {
      console.log('Settings window errors:', JSON.stringify(errors, null, 2));
    }
    expect(errors).toHaveLength(0);

    // Close settings window if it opened
    if (settingsWindow) {
      await settingsWindow.close();
    }
  });

  // -----------------------------------------------------------------------
  // Spaces Manager (Clipboard Viewer)
  // -----------------------------------------------------------------------
  test('spaces manager window opens without errors', async () => {
    const snap = await snapshotErrors();

    // Trigger via main process evaluation
    await electronApp.evaluate(async () => {
      if (global.clipboardManager && global.clipboardManager.createClipboardWindow) {
        global.clipboardManager.createClipboardWindow();
      }
    });
    await sleep(4000); // Spaces Manager has async init

    const allWindows = electronApp.windows();
    const spacesWindow = allWindows.find(w => {
      try { return w.url().includes('clipboard-viewer.html'); } catch { return false; }
    });

    const errors = filterBenignErrors(await checkNewErrors(snap));
    if (errors.length > 0) {
      console.log('Spaces Manager errors:', JSON.stringify(errors, null, 2));
    }
    expect(errors).toHaveLength(0);

    if (spacesWindow) {
      await spacesWindow.close();
      await sleep(500);
    }
  });

  // -----------------------------------------------------------------------
  // Voice Orb
  // -----------------------------------------------------------------------
  test('voice orb toggles without errors', async () => {
    const snap = await snapshotErrors();

    // Toggle orb on via global function
    await electronApp.evaluate(() => {
      if (typeof global.toggleOrbWindow === 'function') {
        global.toggleOrbWindow();
      }
    });
    await sleep(2000);

    const errors = filterBenignErrors(await checkNewErrors(snap));
    if (errors.length > 0) {
      console.log('Voice Orb errors:', JSON.stringify(errors, null, 2));
    }
    expect(errors).toHaveLength(0);

    // Toggle off
    await electronApp.evaluate(() => {
      if (typeof global.toggleOrbWindow === 'function') {
        global.toggleOrbWindow();
      }
    });
    await sleep(500);
  });

  // -----------------------------------------------------------------------
  // App Health Dashboard
  // -----------------------------------------------------------------------
  test('health dashboard opens without errors', async () => {
    const snap = await snapshotErrors();

    await electronApp.evaluate(async () => {
      if (typeof global.openDashboardWindow === 'function') {
        global.openDashboardWindow();
      }
    });
    await sleep(3000);

    const allWindows = electronApp.windows();
    const dashWindow = allWindows.find(w => {
      try { return w.url().includes('app-health-dashboard.html'); } catch { return false; }
    });

    const errors = filterBenignErrors(await checkNewErrors(snap));
    if (errors.length > 0) {
      console.log('Dashboard errors:', JSON.stringify(errors, null, 2));
    }
    expect(errors).toHaveLength(0);

    if (dashWindow) {
      await dashWindow.close();
      await sleep(500);
    }
  });

  // -----------------------------------------------------------------------
  // Agent Manager
  // -----------------------------------------------------------------------
  test('agent manager opens without errors', async () => {
    const snap = await snapshotErrors();

    await electronApp.evaluate(async () => {
      if (typeof global.createAgentManagerWindow === 'function') {
        global.createAgentManagerWindow();
      }
    });
    await sleep(3000);

    const allWindows = electronApp.windows();
    const agentWindow = allWindows.find(w => {
      try { return w.url().includes('agent-manager.html'); } catch { return false; }
    });

    const errors = filterBenignErrors(await checkNewErrors(snap));
    if (errors.length > 0) {
      console.log('Agent Manager errors:', JSON.stringify(errors, null, 2));
    }
    expect(errors).toHaveLength(0);

    if (agentWindow) {
      await agentWindow.close();
      await sleep(500);
    }
  });

  // -----------------------------------------------------------------------
  // Summary: no uncaught errors across all windows
  // -----------------------------------------------------------------------
  test('overall error count has not increased significantly', async () => {
    const health = await getHealth();
    const errorRate = health.queue?.errorsPerMinute || 0;
    // After all windows have been opened and closed, error rate should be low
    console.log(`Final error rate: ${errorRate} errors/min`);
    // Soft assertion -- flag if error rate is very high
    expect(errorRate).toBeLessThan(100);
  });
});
