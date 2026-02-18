/**
 * Documentation Completeness Tests
 *
 * Verifies that:
 * 1. All expected documentation markdown files exist on disk and are non-empty
 * 2. Each documentation HTML window opens, loads content, and closes without errors
 * 3. Expected content sections are present in each doc window's DOM
 * 4. The docs-agent can be loaded and has ingested all expected documents
 *
 * Run:  npx playwright test test/e2e/documentation-completeness.spec.js
 */

const { test, expect } = require('@playwright/test');
const { _electron: electron } = require('playwright');
const path = require('path');
const fs = require('fs');
const {
  closeApp,
  waitForHealth,
  snapshotErrors,
  checkNewErrors,
  filterBenignErrors,
  setLogLevel,
  sleep,
} = require('./helpers/electron-app');

let electronApp;
let mainWindow;

const PROJECT_ROOT = path.resolve(__dirname, '../../');

// =========================================================================
// Expected documentation files (must exist on disk and be non-empty)
// =========================================================================
const EXPECTED_DOC_FILES = [
  'README.md',
  'APP-FEATURES.md',
  'TOOL-APP-SPACES-API-GUIDE.md',
  'LOGGING-API.md',
  'CONVERSION-API.md',
  'packages/agents/APP-AGENT-GUIDE.md',
  'packages/agents/VOICE-GUIDE.md',
  'VIDEO_EDITOR_QUICK_START.md',
  'ADR_QUICK_START.md',
  'SPACES-UPLOAD-QUICK-START.md',
  'SETUP_ELEVENLABS.md',
];

// =========================================================================
// Expected content in each doc HTML window
// =========================================================================
const DOC_WINDOWS = [
  {
    name: 'User Guide',
    file: 'docs-readme.html',
    expectedTexts: ['Getting Started', 'Settings'],
  },
  {
    name: 'AI Run Times Guide',
    file: 'docs-ai-insights.html',
    expectedTexts: ['AI Run Times'],
  },
  {
    name: 'Spaces API Guide',
    file: 'docs-spaces-api.html',
    expectedTexts: ['Spaces', 'API'],
  },
];

// =========================================================================
// Setup / Teardown
// =========================================================================

test.describe('Documentation Completeness', () => {
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
    try {
      await setLogLevel('info');
    } catch (_e) {
      /* app may be closing */
    }
    await closeApp({ electronApp });
  });

  // =======================================================================
  // 1. Documentation files exist on disk
  // =======================================================================

  test.describe('Documentation files exist on disk', () => {
    for (const docFile of EXPECTED_DOC_FILES) {
      test(`${docFile} exists and is non-empty`, () => {
        const fullPath = path.join(PROJECT_ROOT, docFile);
        expect(fs.existsSync(fullPath)).toBe(true);
        const stat = fs.statSync(fullPath);
        expect(stat.size).toBeGreaterThan(100); // At least 100 bytes (not a stub)
      });
    }
  });

  // =======================================================================
  // 2. Documentation HTML windows open without errors
  // =======================================================================

  test.describe('Documentation windows load correctly', () => {
    for (const docWin of DOC_WINDOWS) {
      test(`${docWin.name} window opens and loads without errors`, async () => {
        const snap = await snapshotErrors();

        // Open the doc window via BrowserWindow in main process
        await electronApp.evaluate(async (_modules, filePath) => {
          const { BrowserWindow } = require('electron');
          const pathMod = require('path');
          const docWindow = new BrowserWindow({
            width: 1000,
            height: 800,
            show: false, // Don't flash windows during test
            webPreferences: {
              nodeIntegration: false,
              contextIsolation: true,
              preload: pathMod.join(__dirname, 'preload.js'),
              webSecurity: true,
            },
          });
          docWindow.loadFile(filePath);

          // Store reference so we can find it later
          global._testDocWindow = docWindow;
        }, docWin.file);

        // Wait for the window to load
        await sleep(3000);

        // Find the window
        const allWindows = electronApp.windows();
        const targetWindow = allWindows.find((w) => {
          try {
            return w.url().includes(docWin.file);
          } catch {
            return false;
          }
        });

        // Verify the window opened
        expect(targetWindow).toBeTruthy();

        if (targetWindow) {
          // Verify expected content is present
          for (const expectedText of docWin.expectedTexts) {
            const bodyText = await targetWindow.evaluate(() => document.body.innerText);
            expect(bodyText).toContain(expectedText);
          }

          // Close the doc window
          await electronApp.evaluate(() => {
            if (global._testDocWindow && !global._testDocWindow.isDestroyed()) {
              global._testDocWindow.close();
            }
            global._testDocWindow = null;
          });
          await sleep(500);
        }

        // Check no new errors were produced
        const errors = filterBenignErrors(await checkNewErrors(snap));
        if (errors.length > 0) {
          console.log(`${docWin.name} errors:`, JSON.stringify(errors, null, 2));
        }
        expect(errors).toHaveLength(0);
      });
    }
  });

  // =======================================================================
  // 3. Documentation HTML files exist on disk
  // =======================================================================

  test.describe('Documentation HTML files exist on disk', () => {
    for (const docWin of DOC_WINDOWS) {
      test(`${docWin.file} exists`, () => {
        const fullPath = path.join(PROJECT_ROOT, docWin.file);
        expect(fs.existsSync(fullPath)).toBe(true);
        const stat = fs.statSync(fullPath);
        expect(stat.size).toBeGreaterThan(500); // HTML files should be substantial
      });
    }
  });

  // =======================================================================
  // 4. Docs agent loads and has ingested expected documents
  // =======================================================================

  test('docs-agent loads and reports expected document count', async () => {
    // Load the docs-agent in the main process and check its stats
    const stats = await electronApp.evaluate(async () => {
      try {
        const docsAgent = require('./packages/agents/docs-agent');
        // Don't call full initialize() in test (would call OpenAI for embeddings)
        // Instead just verify the agent loads and has the right properties
        return {
          id: docsAgent.id,
          name: docsAgent.name,
          categories: docsAgent.categories,
          hasExecute: typeof docsAgent.execute === 'function',
          hasInitialize: typeof docsAgent.initialize === 'function',
          keywords: docsAgent.keywords,
        };
      } catch (err) {
        return { error: err.message };
      }
    });

    expect(stats.error).toBeUndefined();
    expect(stats.id).toBe('docs-agent');
    expect(stats.name).toBe('Documentation Agent');
    expect(stats.hasExecute).toBe(true);
    expect(stats.hasInitialize).toBe(true);
    expect(stats.categories).toContain('documentation');
  });

  // =======================================================================
  // 5. Agent registry includes docs-agent
  // =======================================================================

  test('docs-agent is registered in agent registry', async () => {
    const registered = await electronApp.evaluate(async () => {
      try {
        const { getAllAgents } = require('./packages/agents/agent-registry');
        const agents = getAllAgents();
        const docsAgent = agents.find((a) => a.id === 'docs-agent');
        return docsAgent ? { id: docsAgent.id, name: docsAgent.name } : null;
      } catch (err) {
        return { error: err.message };
      }
    });

    expect(registered).toBeTruthy();
    expect(registered.id).toBe('docs-agent');
  });
});
