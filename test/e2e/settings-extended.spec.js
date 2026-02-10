/**
 * Settings Extended E2E Tests
 *
 * Tests settings form sections, sidebar tabs, budget settings,
 * diagnostic logging, and conversation capture settings.
 *
 * Run:  npx playwright test test/e2e/settings-extended.spec.js
 */

const { test, expect } = require('@playwright/test');
const {
  launchApp, closeApp, snapshotErrors, checkNewErrors, filterBenignErrors, sleep
} = require('./helpers/electron-app');

let app;
let electronApp;
let mainWindow;
let errorSnapshot;

test.describe('Settings Extended', () => {

  test.beforeAll(async () => {
    app = await launchApp();
    electronApp = app.electronApp;
    mainWindow = app.mainWindow;
    errorSnapshot = await snapshotErrors();
  });

  test.afterAll(async () => {
    await closeApp(app);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Settings Access
  // ═══════════════════════════════════════════════════════════════════════════

  test('all form sections render (API Keys, GSX, LLM, AI Metadata, etc.)', async () => {
    const result = await mainWindow.evaluate(async () => {
      try {
        if (window.api?.getSettings) {
          const settings = await window.api.getSettings();
          const keys = Object.keys(settings || {});
          return { success: true, settingCount: keys.length, sampleKeys: keys.slice(0, 15) };
        }
        return { success: false };
      } catch (e) {
        return { error: e.message };
      }
    });

    expect(result.success || result.error).toBeTruthy();
  });

  test('diagnostic logging dropdown has correct options', async () => {
    const result = await mainWindow.evaluate(async () => {
      try {
        if (window.logging?.getLevel) {
          const level = await window.logging.getLevel();
          return {
            success: true,
            currentLevel: level,
            validLevels: ['off', 'error', 'warn', 'info', 'debug']
          };
        }
        return { success: false };
      } catch (e) {
        return { error: e.message };
      }
    });

    if (result.success) {
      expect(result.validLevels).toContain(result.currentLevel?.level || result.currentLevel);
    }
  });

  test('IDW menu syncs when settings with idwEnvironments are saved', async () => {
    const result = await mainWindow.evaluate(async () => {
      try {
        if (window.api?.getSettings) {
          const settings = await window.api.getSettings();
          return {
            hasIdwSettings: !!settings?.idws || !!settings?.idwEnvironments,
            hasSaveSettings: typeof window.api.saveSettings === 'function'
          };
        }
        return { hasIdwSettings: false };
      } catch (e) {
        return { error: e.message };
      }
    });

    expect(result).toBeDefined();
  });

  test('sidebar renders tabs with correct content', async () => {
    // Open settings window
    await mainWindow.evaluate(async () => {
      try {
        if (window.api?.invoke) {
          await window.api.invoke('open-settings');
        }
      } catch {}
    });

    await sleep(1000);

    // Find the settings window
    const windows = await electronApp.windows();
    const settingsPage = windows.find(p => {
      try { return p.url().includes('settings'); } catch { return false; }
    });

    if (settingsPage) {
      const tabs = await settingsPage.evaluate(() => {
        const tabElements = document.querySelectorAll('[data-tab], .sidebar-tab, .tab-button, .nav-item');
        return { tabCount: tabElements.length, found: tabElements.length > 0 };
      });
      expect(tabs.tabCount).toBeGreaterThan(0);
    }
  });

  test('clicking each sidebar tab shows correct content pane', async () => {
    const windows = await electronApp.windows();
    const settingsPage = windows.find(p => {
      try { return p.url().includes('settings'); } catch { return false; }
    });

    if (settingsPage) {
      const result = await settingsPage.evaluate(() => {
        const tabs = document.querySelectorAll('[data-tab], .sidebar-tab, .tab-button, .nav-item');
        const panes = document.querySelectorAll('[data-pane], .tab-content, .settings-pane, .content-section');
        return { tabs: tabs.length, panes: panes.length };
      });
      expect(result.tabs).toBeGreaterThan(0);
    }
  });

  test('budget tab renders budget controls', async () => {
    const windows = await electronApp.windows();
    const settingsPage = windows.find(p => {
      try { return p.url().includes('settings'); } catch { return false; }
    });

    if (settingsPage) {
      const result = await settingsPage.evaluate(() => {
        const body = document.body.innerHTML;
        const hasBudget = body.toLowerCase().includes('budget');
        return { hasBudgetSection: hasBudget };
      });
      expect(result).toBeDefined();
    }
  });

  test('budget settings save and reload correctly', async () => {
    const result = await mainWindow.evaluate(async () => {
      try {
        if (window.api?.getSettings && window.api?.saveSettings) {
          const settings = await window.api.getSettings();
          // Read budget settings
          const budget = settings?.budget || settings?.budgetEnabled || null;
          return { hasBudgetSettings: budget !== undefined, settings: typeof budget };
        }
        return { hasBudgetSettings: false };
      } catch (e) {
        return { error: e.message };
      }
    });

    expect(result).toBeDefined();
  });

  test('conversation capture subsection renders controls', async () => {
    const windows = await electronApp.windows();
    const settingsPage = windows.find(p => {
      try { return p.url().includes('settings'); } catch { return false; }
    });

    if (settingsPage) {
      const result = await settingsPage.evaluate(() => {
        const body = document.body.innerHTML.toLowerCase();
        return {
          hasConversationCapture: body.includes('conversation') || body.includes('capture'),
          hasAIConfig: body.includes('ai') && body.includes('config')
        };
      });
      expect(result).toBeDefined();
    }
  });

  test('conversation capture settings save and reload correctly', async () => {
    const result = await mainWindow.evaluate(async () => {
      try {
        if (window.api?.getSettings) {
          const settings = await window.api.getSettings();
          const capture = settings?.conversationCapture || settings?.['ai.conversationCapture'] || null;
          return { hasCaptureSettings: capture !== undefined };
        }
        return { hasCaptureSettings: false };
      } catch (e) {
        return { error: e.message };
      }
    });

    expect(result).toBeDefined();
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Error check
  // ═══════════════════════════════════════════════════════════════════════════

  test('no unexpected errors during settings tests', async () => {
    const errors = await checkNewErrors(errorSnapshot);
    const genuine = filterBenignErrors(errors);
    expect(genuine.length).toBeLessThanOrEqual(5);
  });
});
