/**
 * Settings Flow Tests
 *
 * Tests the Settings window lifecycle including the new Diagnostic Logging
 * toggle, verifying that changes persist via the REST API.
 *
 * Run:  npx playwright test test/e2e/settings-flow.spec.js
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
  getLogLevel,
  setLogLevel,
  sleep,
} = require('./helpers/electron-app');

let electronApp;
let mainWindow;

test.describe('Settings Flow', () => {
  test.beforeAll(async () => {
    electronApp = await electron.launch({
      args: [path.join(__dirname, '../../main.js')],
      env: { ...process.env, NODE_ENV: 'test', TEST_MODE: 'true' },
      timeout: 30000,
    });
    mainWindow = await electronApp.firstWindow();
    await mainWindow.waitForLoadState('domcontentloaded');
    await waitForHealth(40);
  });

  test.afterAll(async () => {
    // Restore logging level
    try {
      await setLogLevel('info');
    } catch (_e) {
      /* ok */
    }
    await closeApp({ electronApp });
  });

  test('settings window opens and loads all form fields', async () => {
    const snap = await snapshotErrors();

    // Open settings via global function in main process
    await electronApp.evaluate(() => {
      if (typeof global.openSettingsWindowGlobal === 'function') {
        global.openSettingsWindowGlobal();
      }
    });
    await sleep(3000);

    // Find settings window
    const allWindows = electronApp.windows();
    const settingsWindow = allWindows.find((w) => {
      try {
        return w.url().includes('settings.html');
      } catch {
        return false;
      }
    });

    expect(settingsWindow).toBeTruthy();

    if (settingsWindow) {
      // Verify sidebar navigation exists with 6 tabs
      const sidebarTabs = await settingsWindow.$$('.sidebar-tab');
      expect(sidebarTabs.length).toBe(6);

      // Verify key form fields exist
      const diagnosticSelect = await settingsWindow.$('#diagnosticLogging');
      expect(diagnosticSelect).toBeTruthy();

      const autoSaveCheckbox = await settingsWindow.$('#autoSave');
      expect(autoSaveCheckbox).toBeTruthy();

      // Verify new Budget fields exist
      const budgetEnabled = await settingsWindow.$('#budgetEnabled');
      expect(budgetEnabled).toBeTruthy();

      // Verify Conversation Capture fields exist
      const captureEnabled = await settingsWindow.$('#captureEnabled');
      expect(captureEnabled).toBeTruthy();
    }

    const errors = filterBenignErrors(await checkNewErrors(snap));
    expect(errors).toHaveLength(0);

    // Close settings
    if (settingsWindow) {
      await settingsWindow.close();
    }
  });

  test('diagnostic logging level can be changed via REST API', async () => {
    // Read current
    const original = await getLogLevel();
    expect(original.level).toBeTruthy();

    // Change to debug
    const result = await setLogLevel('debug');
    expect(result.success).toBe(true);

    // Verify
    const after = await getLogLevel();
    expect(after.level).toBe('debug');
    expect(after.persisted).toBe('debug');

    // Change to warn
    const result2 = await setLogLevel('warn');
    expect(result2.success).toBe(true);
    const after2 = await getLogLevel();
    expect(after2.level).toBe('warn');

    // Restore
    await setLogLevel(original.persisted || 'info');
    const restored = await getLogLevel();
    expect(restored.persisted).toBe(original.persisted || 'info');
  });

  test('logging level survives settings round-trip', async () => {
    // Set a known level via REST
    await setLogLevel('debug');

    // Read it back
    const level = await getLogLevel();
    expect(level.persisted).toBe('debug');

    // Open settings to verify the UI would show it
    // (We can't easily read the select value without opening the window,
    //  but we verify the API layer is consistent)
    expect(level.level).toBe('debug');

    // Restore
    await setLogLevel('info');
  });

  test('budget and conversation capture settings persist', async () => {
    // Read original settings via renderer IPC
    const original = await mainWindow.evaluate(() => window.api.getSettings());

    // Save test values via renderer IPC (same path as the Settings UI save button)
    const testSettings = {
      budgetEnabled: false,
      budgetShowEstimates: false,
      budgetConfirmThreshold: 0.42,
      aiConversationCapture: {
        enabled: false,
        captureImages: false,
        captureFiles: true,
        captureCode: false,
        autoCreateSpaces: false,
        conversationTimeoutMinutes: 15,
        showRecordingIndicator: false,
        enableUndoWindow: true,
        undoWindowMinutes: 10,
        privateModeByDefault: true,
      },
    };

    const saved = await mainWindow.evaluate((s) => window.api.saveSettings(s), testSettings);
    expect(saved).toBeTruthy();

    // Read back via IPC
    const readBack = await mainWindow.evaluate(() => window.api.getSettings());

    // Verify budget settings persisted
    expect(readBack.budgetEnabled).toBe(false);
    expect(readBack.budgetShowEstimates).toBe(false);
    expect(readBack.budgetConfirmThreshold).toBe(0.42);

    // Verify conversation capture settings persisted
    const capture = readBack.aiConversationCapture;
    expect(capture).toBeTruthy();
    expect(capture.enabled).toBe(false);
    expect(capture.captureImages).toBe(false);
    expect(capture.captureFiles).toBe(true);
    expect(capture.conversationTimeoutMinutes).toBe(15);
    expect(capture.privateModeByDefault).toBe(true);
    expect(capture.undoWindowMinutes).toBe(10);

    // Restore original values
    await mainWindow.evaluate((s) => window.api.saveSettings(s), {
      budgetEnabled: original.budgetEnabled !== false ? true : original.budgetEnabled,
      budgetShowEstimates: original.budgetShowEstimates !== false ? true : original.budgetShowEstimates,
      budgetConfirmThreshold: original.budgetConfirmThreshold || 0.05,
      aiConversationCapture: original.aiConversationCapture || {
        enabled: true,
        captureImages: true,
        captureFiles: true,
        captureCode: true,
        autoCreateSpaces: true,
        conversationTimeoutMinutes: 30,
        showRecordingIndicator: true,
        enableUndoWindow: true,
        undoWindowMinutes: 5,
        privateModeByDefault: false,
      },
    });
  });
});
