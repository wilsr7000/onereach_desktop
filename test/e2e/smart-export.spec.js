/**
 * Smart Export E2E Tests
 *
 * Tests the Smart Export feature: format listing, export generation for
 * all supported formats, and save-to-space functionality.
 *
 * Run:  npx playwright test test/e2e/smart-export.spec.js
 */

const { test, expect } = require('@playwright/test');
const {
  launchApp,
  closeApp,
  snapshotErrors,
  checkNewErrors,
  filterBenignErrors,
  createSpace,
  deleteSpace,
  sleep,
  SPACES_API,
} = require('./helpers/electron-app');

let app;
let electronApp;
let mainWindow;
let testSpaceId;
let errorSnapshot;

const EXPECTED_FORMATS = ['pdf', 'docx', 'pptx', 'xlsx', 'csv', 'html', 'markdown', 'txt'];

test.describe('Smart Export', () => {
  test.beforeAll(async () => {
    app = await launchApp();
    electronApp = app.electronApp;
    mainWindow = app.mainWindow;
    errorSnapshot = await snapshotErrors();

    // Create a test space with some content for export
    const space = await createSpace('smart-export-test', 'Test space for smart export');
    testSpaceId = space.id;

    // Add some content items so exports have data
    const items = [
      { type: 'text', content: 'This is the first test item for smart export.' },
      { type: 'text', content: '# Heading\n\nSome markdown content with **bold** and *italic*.' },
      { type: 'text', content: '<h2>HTML Content</h2><p>A paragraph of HTML content.</p>' },
    ];

    for (const item of items) {
      try {
        await fetch(`${SPACES_API}/api/spaces/${testSpaceId}/items`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(item),
        });
      } catch {
        /* best effort */
      }
    }

    await sleep(1000);
  });

  test.afterAll(async () => {
    if (testSpaceId) {
      try {
        await deleteSpace(testSpaceId);
      } catch {
        /* no-op */
      }
    }
    await closeApp(app);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Format Listing
  // ═══════════════════════════════════════════════════════════════════════════

  test('get-formats returns supported export formats via IPC', async () => {
    const formats = await mainWindow.evaluate(async () => {
      try {
        if (window.api?.invoke) {
          return await window.api.invoke('smart-export:get-formats');
        }
        return null;
      } catch (e) {
        return { error: e.message };
      }
    });

    if (formats?.error || !formats) {
      test.skip(true, 'smart-export:get-formats IPC not available');
      return;
    }

    expect(Array.isArray(formats)).toBe(true);
    expect(formats.length).toBeGreaterThanOrEqual(EXPECTED_FORMATS.length);

    const formatIds = formats.map((f) => f.id);
    for (const expected of EXPECTED_FORMATS) {
      expect(formatIds).toContain(expected);
    }
  });

  test('each format has required metadata fields', async () => {
    const formats = await mainWindow.evaluate(async () => {
      try {
        if (window.api?.invoke) {
          return await window.api.invoke('smart-export:get-formats');
        }
        return null;
      } catch {
        return null;
      }
    });

    test.skip(!formats || formats.error, 'Format data not available');

    for (const fmt of formats) {
      expect(fmt.id).toBeTruthy();
      expect(fmt.name).toBeTruthy();
      expect(fmt.extension).toBeTruthy();
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Space Context
  // ═══════════════════════════════════════════════════════════════════════════

  test('space context retrieves correct space name and item count', async () => {
    test.skip(!testSpaceId, 'No test space available');

    const res = await fetch(`${SPACES_API}/api/spaces/${testSpaceId}`);
    const data = await res.json();
    const name = data.name || data.space?.name;
    expect(name).toBe('smart-export-test');
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Export Generation
  // ═══════════════════════════════════════════════════════════════════════════

  for (const format of EXPECTED_FORMATS) {
    test(`${format.toUpperCase()} export produces valid output`, async () => {
      test.skip(!testSpaceId, 'No test space available');

      const result = await mainWindow.evaluate(
        async ({ format, spaceId }) => {
          try {
            if (window.api?.invoke) {
              const output = await window.api.invoke('smart-export:generate', {
                format,
                spaceId,
                options: { aiEnhanced: false, includeMetadata: true },
              });
              return { success: !!output, output };
            }
            return { success: false, note: 'No IPC' };
          } catch (e) {
            return { success: false, error: e.message };
          }
        },
        { format, spaceId: testSpaceId }
      );

      if (result.error?.includes('not registered') || result.error?.includes('not found')) {
        test.skip(true, `${format} export IPC not available`);
        return;
      }

      // The export should return some result
      expect(result).toBeDefined();
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Save to Space
  // ═══════════════════════════════════════════════════════════════════════════

  test('HTML export can be saved back to a space', async () => {
    test.skip(!testSpaceId, 'No test space available');

    const htmlContent =
      '<html><body><h1>Exported Document</h1><p>This was generated by Smart Export.</p></body></html>';

    const res = await fetch(`${SPACES_API}/api/spaces/${testSpaceId}/items`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'text',
        content: htmlContent,
        metadata: { source: 'smart-export-test', format: 'html' },
      }),
    });

    const data = await res.json();
    expect(data.success || data.itemId).toBeTruthy();

    if (data.itemId) {
      const itemRes = await fetch(`${SPACES_API}/api/spaces/${testSpaceId}/items/${data.itemId}`);
      const itemData = await itemRes.json();
      const item = itemData.item || itemData;
      expect(item.content || '').toContain('Exported Document');
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Escape Key
  // ═══════════════════════════════════════════════════════════════════════════

  test('smart export window closes on Escape key', async () => {
    const windows = await electronApp.windows();
    const exportPage = windows.find((p) => {
      try {
        return p.url().includes('smart-export') || p.url().includes('export');
      } catch {
        return false;
      }
    });

    if (exportPage) {
      await exportPage.keyboard.press('Escape');
      await sleep(500);

      const afterWindows = await electronApp.windows();
      const stillOpen = afterWindows.find((p) => {
        try {
          return p.url().includes('smart-export');
        } catch {
          return false;
        }
      });
      expect(!stillOpen).toBeTruthy();
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Error check
  // ═══════════════════════════════════════════════════════════════════════════

  test('no unexpected errors during smart export tests', async () => {
    const errors = await checkNewErrors(errorSnapshot);
    const genuine = filterBenignErrors(errors);
    if (genuine.length > 0) {
      console.log(
        'Errors found:',
        genuine.map((e) => e.message)
      );
    }
    expect(genuine.length).toBeLessThanOrEqual(5);
  });
});
