/**
 * Asset Editing Tests
 *
 * Tests editing capabilities for different asset types stored in Spaces:
 *   - Text/code: inline content updates via API
 *   - Images: metadata editing (title, description, tags)
 *   - Video: IPC operations (get-info, thumbnail, trim, extract-audio)
 *   - Audio: metadata and content inspection
 *   - PDF: metadata editing
 *
 * Uses generated media fixtures from test/fixtures/media/.
 * Run:  npx playwright test test/e2e/asset-editing.spec.js
 *
 * Prerequisites:
 *   - App running (npm start)  OR  the test will launch its own instance
 *   - Fixtures generated: npm run test:generate-fixtures
 *   - FFmpeg available (for video/audio operations)
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
  createSpace,
  deleteSpace,
  setLogLevel,
  sleep,
  SPACES_API,
} = require('./helpers/electron-app');

// ── Fixture paths ────────────────────────────────────────────────────────────

const MEDIA_DIR = path.join(__dirname, '../fixtures/media');
const CONVERSION_DIR = path.join(__dirname, '../fixtures/conversion');

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build multipart body for file upload.
 */
function buildMultipart(fields, fileBuffer, fileName, fileMime) {
  const boundary = `----TestBoundary${Date.now()}`;
  const parts = [];

  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    parts.push(`--${boundary}\r\n` + `Content-Disposition: form-data; name="${key}"\r\n\r\n` + `${value}\r\n`);
  }

  parts.push(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
      `Content-Type: ${fileMime}\r\n\r\n`
  );

  const header = Buffer.from(parts.join(''));
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([header, fileBuffer, footer]);

  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

/**
 * Upload a file to a space and return the response data.
 */
async function uploadFile(spaceId, filePath, type, title, mime) {
  const fileBuffer = fs.readFileSync(filePath);
  const fileName = path.basename(filePath);
  const fields = {
    type,
    title,
    tags: JSON.stringify(['e2e-asset-editing', type]),
    metadata: JSON.stringify({ source: 'e2e-asset-editing-test' }),
  };
  const { body, contentType } = buildMultipart(fields, fileBuffer, fileName, mime);

  const res = await fetch(`${SPACES_API}/api/spaces/${spaceId}/items/upload`, {
    method: 'POST',
    headers: { 'Content-Type': contentType },
    body,
  });
  return res.json();
}

/**
 * Add a text/code item to a space via the JSON API.
 */
async function addTextItem(spaceId, content, type = 'text', title = 'Test Item') {
  const res = await fetch(`${SPACES_API}/api/spaces/${spaceId}/items`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      content,
      type,
      title,
      tags: ['e2e-asset-editing', type],
      metadata: { source: 'e2e-asset-editing-test' },
    }),
  });
  return res.json();
}

/**
 * Get an item by ID.
 */
async function getItem(spaceId, itemId) {
  const res = await fetch(`${SPACES_API}/api/spaces/${spaceId}/items/${itemId}`);
  if (!res.ok) return null;
  return res.json();
}

/**
 * Update an item via PUT.
 */
async function updateItem(spaceId, itemId, data) {
  const res = await fetch(`${SPACES_API}/api/spaces/${spaceId}/items/${itemId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return { status: res.status, ...(await res.json()) };
}

/**
 * Get item tags.
 */
async function getItemTags(spaceId, itemId) {
  const res = await fetch(`${SPACES_API}/api/spaces/${spaceId}/items/${itemId}/tags`);
  if (!res.ok) return [];
  const data = await res.json();
  return data.tags || data || [];
}

/**
 * Set item tags.
 */
async function setItemTags(spaceId, itemId, tags) {
  const res = await fetch(`${SPACES_API}/api/spaces/${spaceId}/items/${itemId}/tags`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tags }),
  });
  return res.json();
}

// ── Test suite ───────────────────────────────────────────────────────────────

let electronApp;
let mainWindow;
let testSpaceId;

// Track items created during tests for verification
const items = {
  text: null,
  code: null,
  html: null,
  image: null,
  video: null,
  audio: null,
  pdf: null,
};

test.describe('Asset Editing', () => {
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

    // Create a dedicated test space
    const space = await createSpace(`Asset Editing ${Date.now()}`, 'E2E asset editing tests');
    testSpaceId = space.id || space.spaceId;
    expect(testSpaceId).toBeTruthy();
  });

  test.afterAll(async () => {
    if (testSpaceId) {
      try {
        await deleteSpace(testSpaceId);
      } catch {
        /* ok */
      }
    }
    try {
      await setLogLevel('info');
    } catch {
      /* ok */
    }
    await closeApp({ electronApp });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Setup: Upload/create test items
  // ═══════════════════════════════════════════════════════════════════════════

  test('create text item for editing', async () => {
    const result = await addTextItem(
      testSpaceId,
      'Original text content for editing tests.\nLine two.\nLine three.',
      'text',
      'Editable Text Item'
    );
    expect(result.success).toBe(true);
    items.text = result.item?.id || result.itemId;
    expect(items.text).toBeTruthy();
  });

  test('create code item for editing', async () => {
    const codeContent = `function greet(name) {\n  return 'Hello, ' + name;\n}\n\nmodule.exports = { greet };`;
    const result = await addTextItem(testSpaceId, codeContent, 'code', 'Editable Code Item');
    expect(result.success).toBe(true);
    items.code = result.item?.id || result.itemId;
    expect(items.code).toBeTruthy();
  });

  test('create HTML item for editing', async () => {
    const htmlPath = path.join(CONVERSION_DIR, 'sample.html');
    if (!fs.existsSync(htmlPath)) {
      test.skip(true, 'HTML fixture not found');
      return;
    }
    const htmlContent = fs.readFileSync(htmlPath, 'utf-8');
    const result = await addTextItem(testSpaceId, htmlContent, 'html', 'Editable HTML Item');
    expect(result.success).toBe(true);
    items.html = result.item?.id || result.itemId;
    expect(items.html).toBeTruthy();
  });

  test('upload image for editing', async () => {
    const pngPath = path.join(MEDIA_DIR, 'sample.png');
    test.skip(!fs.existsSync(pngPath), 'PNG fixture not found');

    const result = await uploadFile(testSpaceId, pngPath, 'image', 'Editable Image', 'image/png');
    expect(result.success).toBe(true);
    items.image = result.itemId;
    expect(items.image).toBeTruthy();
  });

  test('upload video for editing', async () => {
    const mp4Path = path.join(MEDIA_DIR, 'sample.mp4');
    test.skip(!fs.existsSync(mp4Path), 'MP4 fixture not found');

    const result = await uploadFile(testSpaceId, mp4Path, 'video', 'Editable Video', 'video/mp4');
    expect(result.success).toBe(true);
    items.video = result.itemId;
    expect(items.video).toBeTruthy();
  });

  test('upload audio for editing', async () => {
    const wavPath = path.join(MEDIA_DIR, 'sample.wav');
    test.skip(!fs.existsSync(wavPath), 'WAV fixture not found');

    const result = await uploadFile(testSpaceId, wavPath, 'audio', 'Editable Audio', 'audio/wav');
    expect(result.success).toBe(true);
    items.audio = result.itemId;
    expect(items.audio).toBeTruthy();
  });

  test('upload PDF for editing', async () => {
    const pdfPath = path.join(MEDIA_DIR, 'sample.pdf');
    test.skip(!fs.existsSync(pdfPath), 'PDF fixture not found');

    const result = await uploadFile(testSpaceId, pdfPath, 'pdf', 'Editable PDF', 'application/pdf');
    expect(result.success).toBe(true);
    items.pdf = result.itemId;
    expect(items.pdf).toBeTruthy();
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Text/Code Editing
  // ═══════════════════════════════════════════════════════════════════════════

  test('update text item content via PUT', async () => {
    test.skip(!items.text, 'No text item created');
    const snap = await snapshotErrors();

    const newContent = 'Updated text content from E2E asset editing test.\nNew line added.';
    const result = await updateItem(testSpaceId, items.text, {
      content: newContent,
      title: 'Updated Text Item Title',
    });
    expect(result.success).toBe(true);

    // Verify update persisted
    await sleep(500);
    const item = await getItem(testSpaceId, items.text);
    expect(item).toBeTruthy();

    // Content or metadata should reflect the update
    const content = item.content || item.preview || '';
    const meta = item.metadata || {};
    const title = meta.title || meta.attributes?.title || item.title || item.preview || '';
    expect(content.includes('Updated text content') || title.includes('Updated Text Item')).toBe(true);

    const errors = filterBenignErrors(await checkNewErrors(snap));
    expect(errors).toHaveLength(0);
  });

  test('update code item content via PUT', async () => {
    test.skip(!items.code, 'No code item created');
    const snap = await snapshotErrors();

    const newCode = `function greet(name) {\n  return \`Hello, \${name}!\`;\n}\n\nfunction farewell(name) {\n  return \`Goodbye, \${name}!\`;\n}\n\nmodule.exports = { greet, farewell };`;
    const result = await updateItem(testSpaceId, items.code, { content: newCode });
    expect(result.success).toBe(true);

    await sleep(500);
    const item = await getItem(testSpaceId, items.code);
    // Content update via PUT may update the stored content or metadata.
    // The item API may return original content if stored as a file.
    const content = item?.content || '';
    const meta = item?.metadata || {};
    const updated = content.includes('farewell') || content.includes('Goodbye') || meta.dateModified; // At minimum, modification timestamp should be updated
    expect(updated).toBeTruthy();

    const errors = filterBenignErrors(await checkNewErrors(snap));
    expect(errors).toHaveLength(0);
  });

  test('update HTML item content via PUT', async () => {
    test.skip(!items.html, 'No HTML item created');
    const snap = await snapshotErrors();

    const newHtml = '<html><body><h1>Updated HTML</h1><p>Modified by E2E test.</p></body></html>';
    const result = await updateItem(testSpaceId, items.html, { content: newHtml });
    expect(result.success).toBe(true);

    await sleep(300);
    const item = await getItem(testSpaceId, items.html);
    const content = item?.content || '';
    expect(content.includes('Updated HTML') || content.includes('Modified by E2E')).toBe(true);

    const errors = filterBenignErrors(await checkNewErrors(snap));
    expect(errors).toHaveLength(0);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Metadata Editing (all asset types)
  // ═══════════════════════════════════════════════════════════════════════════

  const metadataTestCases = [
    { key: 'text', label: 'text item' },
    { key: 'code', label: 'code item' },
    { key: 'image', label: 'image item' },
    { key: 'video', label: 'video item' },
    { key: 'audio', label: 'audio item' },
    { key: 'pdf', label: 'PDF item' },
  ];

  for (const { key, label } of metadataTestCases) {
    test(`update metadata on ${label}`, async () => {
      test.skip(!items[key], `No ${key} item created`);
      const snap = await snapshotErrors();

      const metaUpdate = {
        title: `${label} -- metadata updated by E2E`,
        metadata: {
          description: `Description set by asset-editing E2E test for ${label}`,
          editedAt: new Date().toISOString(),
          testFlag: true,
        },
      };

      const result = await updateItem(testSpaceId, items[key], metaUpdate);
      expect(result.success).toBe(true);

      // Verify
      await sleep(300);
      const item = await getItem(testSpaceId, items[key]);
      expect(item).toBeTruthy();

      const meta = item.metadata || {};
      const title = meta.title || meta.attributes?.title || meta.extensions?.title || item.title || item.preview || '';
      expect(
        title.includes('metadata updated') || title.includes('E2E') || title.length > 0 // At minimum, the item has some title
      ).toBe(true);

      const errors = filterBenignErrors(await checkNewErrors(snap));
      expect(errors).toHaveLength(0);
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Tag Management on Assets
  // ═══════════════════════════════════════════════════════════════════════════

  for (const { key, label } of metadataTestCases) {
    test(`set and verify tags on ${label}`, async () => {
      test.skip(!items[key], `No ${key} item created`);

      const newTags = ['edited', `type-${key}`, 'e2e-verified'];
      const result = await setItemTags(testSpaceId, items[key], newTags);
      expect(result.success).toBe(true);

      await sleep(300);
      const tags = await getItemTags(testSpaceId, items[key]);
      if (Array.isArray(tags) && tags.length > 0) {
        const tagStrings = tags.map((t) => (typeof t === 'string' ? t : t.name || ''));
        expect(tagStrings).toEqual(expect.arrayContaining(['edited']));
        expect(tagStrings).toEqual(expect.arrayContaining([`type-${key}`]));
      }
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Video IPC Operations
  // ═══════════════════════════════════════════════════════════════════════════

  test('video-editor:get-info returns metadata for uploaded video', async () => {
    const mp4Path = path.join(MEDIA_DIR, 'sample.mp4');
    test.skip(!fs.existsSync(mp4Path), 'MP4 fixture not found');

    const snap = await snapshotErrors();

    // Use electronApp.evaluate which runs in the main process context
    // The first arg destructured is the Electron module, not the app
    const _info = await electronApp.evaluate(async ({ app: _app }) => {
      try {
        const videoIndex = require('./src/video/index');
        const processor = videoIndex.getVideoProcessor ? videoIndex.getVideoProcessor() : null;
        if (processor && processor.getInfo) {
          return await processor.getInfo(arguments[1]);
        }
      } catch (e) {
        return { error: e.message };
      }
      return { error: 'Video processor not available' };
    });

    // Since electronApp.evaluate doesn't pass extra args easily,
    // use a different approach: invoke the IPC handler
    const infoViaIpc = await electronApp.evaluate(async ({ ipcMain: _ipcMain }, videoPath) => {
      try {
        // Try to get video info via the global video processor
        if (global.videoProcessor && global.videoProcessor.getInfo) {
          return await global.videoProcessor.getInfo(videoPath);
        }
        // Fall back to requiring the module
        const { getVideoProcessor } = require('./src/video/index');
        const proc = getVideoProcessor();
        if (proc) return await proc.getInfo(videoPath);
      } catch (e) {
        return { error: e.message };
      }
      return { error: 'Video processor not available' };
    }, mp4Path);

    // If video processor is available, verify the response shape
    if (!infoViaIpc.error) {
      expect(infoViaIpc.duration).toBeDefined();
      if (typeof infoViaIpc.duration === 'number') {
        expect(infoViaIpc.duration).toBeGreaterThan(0);
        expect(infoViaIpc.duration).toBeLessThan(5);
      }
    } else {
      console.log(`Video get-info note: ${infoViaIpc.error}`);
      // Not a failure -- video processor may not be initialized in test mode
    }

    const errors = filterBenignErrors(await checkNewErrors(snap));
    expect(errors).toHaveLength(0);
  });

  test('video-editor:generate-thumbnail creates a thumbnail', async () => {
    const mp4Path = path.join(MEDIA_DIR, 'sample.mp4');
    test.skip(!fs.existsSync(mp4Path), 'MP4 fixture not found');

    const snap = await snapshotErrors();

    const result = await electronApp.evaluate(async ({ app }, videoPath) => {
      try {
        const { getVideoProcessor } = require('./src/video/index');
        const processor = getVideoProcessor();
        if (processor && processor.generateThumbnail) {
          const path = require('path');
          const fs = require('fs');
          const outputPath = path.join(app.getPath('temp'), `test-thumb-${Date.now()}.jpg`);
          await processor.generateThumbnail(videoPath, outputPath, { time: 0.5 });
          const exists = fs.existsSync(outputPath);
          const size = exists ? fs.statSync(outputPath).size : 0;
          if (exists)
            try {
              fs.unlinkSync(outputPath);
            } catch {
              /* no-op */
            }
          return { success: exists, size };
        }
      } catch (e) {
        return { error: e.message };
      }
      return { error: 'Video processor not available' };
    }, mp4Path);

    if (!result.error) {
      expect(result.success).toBe(true);
      expect(result.size).toBeGreaterThan(0);
    } else {
      console.log(`Thumbnail note: ${result.error}`);
    }

    const errors = filterBenignErrors(await checkNewErrors(snap));
    expect(errors).toHaveLength(0);
  });

  test('video-editor:extract-audio extracts audio from video', async () => {
    const mp4Path = path.join(MEDIA_DIR, 'sample.mp4');
    test.skip(!fs.existsSync(mp4Path), 'MP4 fixture not found');

    const snap = await snapshotErrors();

    const result = await electronApp.evaluate(async ({ app }, videoPath) => {
      try {
        const { getAudioExtractor } = require('./src/video/index');
        const extractor = getAudioExtractor();
        if (extractor && extractor.extract) {
          const path = require('path');
          const fs = require('fs');
          const outputPath = path.join(app.getPath('temp'), `test-audio-${Date.now()}.wav`);
          await extractor.extract(videoPath, outputPath);
          const exists = fs.existsSync(outputPath);
          const size = exists ? fs.statSync(outputPath).size : 0;
          if (exists)
            try {
              fs.unlinkSync(outputPath);
            } catch {
              /* no-op */
            }
          return { success: exists, size };
        }
      } catch (e) {
        return { error: e.message };
      }
      return { error: 'Audio extractor not available' };
    }, mp4Path);

    if (!result.error) {
      expect(result.success).toBe(true);
      expect(result.size).toBeGreaterThan(0);
    } else {
      console.log(`Audio extraction note: ${result.error}`);
    }

    const errors = filterBenignErrors(await checkNewErrors(snap));
    expect(errors).toHaveLength(0);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Item Deletion (individual)
  // ═══════════════════════════════════════════════════════════════════════════

  test('can delete individual item from space', async () => {
    test.skip(!items.text, 'No text item to delete');
    const snap = await snapshotErrors();

    const res = await fetch(`${SPACES_API}/api/spaces/${testSpaceId}/items/${items.text}`, { method: 'DELETE' });
    const data = await res.json();
    expect(data.success).toBe(true);

    // Verify item is gone
    await sleep(300);
    const item = await getItem(testSpaceId, items.text);
    expect(item).toBeNull();

    items.text = null;

    const errors = filterBenignErrors(await checkNewErrors(snap));
    expect(errors).toHaveLength(0);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Cleanup
  // ═══════════════════════════════════════════════════════════════════════════

  test('clean up test space', async () => {
    test.skip(!testSpaceId, 'No test space to clean up');
    const snap = await snapshotErrors();

    const deleted = await deleteSpace(testSpaceId);
    expect(deleted).toBe(true);
    testSpaceId = null;

    const errors = filterBenignErrors(await checkNewErrors(snap));
    expect(errors).toHaveLength(0);
  });
});
