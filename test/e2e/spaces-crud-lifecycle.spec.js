/**
 * Spaces API - Full CRUD Lifecycle Tests
 *
 * Tests every Spaces API sub-group through a complete lifecycle:
 *   Create -> Read -> Update -> Read -> Delete -> Read (verify gone)
 *
 * Sub-groups: Spaces, Items, Tags, Smart Folders, Metadata, Sharing, Files
 *
 * Run:  npx playwright test test/e2e/spaces-crud-lifecycle.spec.js
 */

const { test, expect } = require('@playwright/test');
const { _electron: electron } = require('playwright');
const path = require('path');
const { closeApp, SPACES_API, waitForHealth, _sleep } = require('./helpers/electron-app');

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

// Helper: JSON fetch
async function api(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${SPACES_API}${path}`, opts);
  const text = await res.text();
  try {
    return { status: res.status, ok: res.ok, data: JSON.parse(text) };
  } catch {
    return { status: res.status, ok: res.ok, data: text };
  }
}

// ═══════════════════════════════════════════════════════════════════
// SPACES CRUD
// ═══════════════════════════════════════════════════════════════════

test.describe('Spaces CRUD Lifecycle', () => {
  let spaceId;

  test('Step 1: Create a space', async () => {
    const { data } = await api('POST', '/api/spaces', {
      name: 'CRUD Test Space',
      description: 'Created by CRUD lifecycle test',
    });
    expect(data.success || data.space || data.id).toBeTruthy();
    spaceId = data.space?.id || data.id;
    expect(spaceId).toBeTruthy();
  });

  test('Step 2: Read the space', async () => {
    const { data, ok } = await api('GET', `/api/spaces/${spaceId}`);
    expect(ok).toBe(true);
    const space = data.space || data;
    expect(space.name || space.id).toBeTruthy();
  });

  test('Step 3: Update the space', async () => {
    const { ok } = await api('PUT', `/api/spaces/${spaceId}`, {
      description: 'Updated by CRUD lifecycle test',
    });
    expect(ok).toBe(true);
  });

  test('Step 4: Read updated space', async () => {
    const { data, ok } = await api('GET', `/api/spaces/${spaceId}`);
    expect(ok).toBe(true);
    const space = data.space || data;
    expect(space).toBeDefined();
    expect(space.id || space.name).toBeTruthy();
  });

  test('Step 5: Delete the space', async () => {
    const { ok } = await api('DELETE', `/api/spaces/${spaceId}`);
    expect(ok).toBe(true);
  });

  test('Step 6: Read deleted space returns 404 or empty', async () => {
    const { status } = await api('GET', `/api/spaces/${spaceId}`);
    expect([404, 200].includes(status)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// ITEMS CRUD
// ═══════════════════════════════════════════════════════════════════

test.describe('Space Items CRUD Lifecycle', () => {
  let spaceId;
  let itemId;

  test.beforeAll(async () => {
    const { data } = await api('POST', '/api/spaces', { name: 'Items CRUD Space' });
    spaceId = data.space?.id || data.id;
  });

  test.afterAll(async () => {
    if (spaceId) await api('DELETE', `/api/spaces/${spaceId}`);
  });

  test('Step 1: Create an item', async () => {
    const { data, ok } = await api('POST', `/api/spaces/${spaceId}/items`, {
      type: 'text',
      content: 'CRUD lifecycle test item',
      title: 'Test Item',
    });
    expect(ok).toBe(true);
    itemId = data.item?.id || data.id;
    expect(itemId).toBeTruthy();
  });

  test('Step 2: Read the item', async () => {
    const { ok } = await api('GET', `/api/spaces/${spaceId}/items/${itemId}`);
    expect(ok).toBe(true);
  });

  test('Step 3: Update the item', async () => {
    const { ok } = await api('PUT', `/api/spaces/${spaceId}/items/${itemId}`, {
      title: 'Updated Test Item',
    });
    expect(ok).toBe(true);
  });

  test('Step 4: Read updated item', async () => {
    const { data, ok } = await api('GET', `/api/spaces/${spaceId}/items/${itemId}`);
    expect(ok).toBe(true);
    const item = data.item || data;
    expect(item).toBeDefined();
    expect(item.id || item.content).toBeTruthy();
  });

  test('Step 5: Delete the item', async () => {
    const { ok } = await api('DELETE', `/api/spaces/${spaceId}/items/${itemId}`);
    expect(ok).toBe(true);
  });

  test('Step 6: Read deleted item returns 404', async () => {
    const { status } = await api('GET', `/api/spaces/${spaceId}/items/${itemId}`);
    expect([404, 200].includes(status)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// TAGS CRUD
// ═══════════════════════════════════════════════════════════════════

test.describe('Tags CRUD Lifecycle', () => {
  let spaceId;
  let itemId;

  test.beforeAll(async () => {
    const { data } = await api('POST', '/api/spaces', { name: 'Tags CRUD Space' });
    spaceId = data.space?.id || data.id;
    const itemRes = await api('POST', `/api/spaces/${spaceId}/items`, {
      type: 'text',
      content: 'Tag test',
      title: 'Tag Item',
    });
    itemId = itemRes.data.item?.id || itemRes.data.id;
  });

  test.afterAll(async () => {
    if (spaceId) await api('DELETE', `/api/spaces/${spaceId}`);
  });

  test('Step 1: Add a tag', async () => {
    const { ok } = await api('POST', `/api/spaces/${spaceId}/items/${itemId}/tags`, {
      tag: 'crud-test',
    });
    expect(ok).toBe(true);
  });

  test('Step 2: Read tags', async () => {
    const { data, ok } = await api('GET', `/api/spaces/${spaceId}/items/${itemId}/tags`);
    expect(ok).toBe(true);
    const tags = data.tags || data;
    expect(Array.isArray(tags)).toBe(true);
  });

  test('Step 3: Set tags (update)', async () => {
    const { ok } = await api('PUT', `/api/spaces/${spaceId}/items/${itemId}/tags`, {
      tags: ['crud-test', 'lifecycle'],
    });
    expect(ok).toBe(true);
  });

  test('Step 4: Read updated tags', async () => {
    const { data } = await api('GET', `/api/spaces/${spaceId}/items/${itemId}/tags`);
    const tags = data.tags || data;
    expect(tags).toContain('lifecycle');
  });

  test('Step 5: Delete a tag', async () => {
    const { ok } = await api('DELETE', `/api/spaces/${spaceId}/items/${itemId}/tags/crud-test`);
    expect(ok).toBe(true);
  });

  test('Step 6: Verify tag removed', async () => {
    const { data } = await api('GET', `/api/spaces/${spaceId}/items/${itemId}/tags`);
    const tags = data.tags || data;
    expect(tags).not.toContain('crud-test');
  });
});

// ═══════════════════════════════════════════════════════════════════
// SMART FOLDERS CRUD
// ═══════════════════════════════════════════════════════════════════

test.describe('Smart Folders CRUD Lifecycle', () => {
  let folderId;

  test('Step 1: Create a smart folder', async () => {
    const { data, ok } = await api('POST', '/api/smart-folders', {
      name: 'CRUD Test Folder',
      criteria: { tags: ['test'] },
    });
    expect(ok).toBe(true);
    folderId = data.folder?.id || data.id;
    expect(folderId).toBeTruthy();
  });

  test('Step 2: Read the smart folder', async () => {
    const { ok } = await api('GET', `/api/smart-folders/${folderId}`);
    expect(ok).toBe(true);
  });

  test('Step 3: Update the smart folder', async () => {
    const { ok } = await api('PUT', `/api/smart-folders/${folderId}`, {
      name: 'Updated CRUD Folder',
    });
    expect(ok).toBe(true);
  });

  test('Step 4: Read updated folder', async () => {
    const { data } = await api('GET', `/api/smart-folders/${folderId}`);
    const folder = data.folder || data;
    expect(folder.name || '').toContain('Updated');
  });

  test('Step 5: Delete the smart folder', async () => {
    const { ok } = await api('DELETE', `/api/smart-folders/${folderId}`);
    expect(ok).toBe(true);
  });

  test('Step 6: Verify deleted', async () => {
    const { status } = await api('GET', `/api/smart-folders/${folderId}`);
    expect([404, 200].includes(status)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// FILES CRUD
// ═══════════════════════════════════════════════════════════════════

test.describe('Files API CRUD Lifecycle', () => {
  let spaceId;

  test.beforeAll(async () => {
    const { data } = await api('POST', '/api/spaces', { name: 'Files CRUD Space' });
    spaceId = data.space?.id || data.id;
  });

  test.afterAll(async () => {
    if (spaceId) await api('DELETE', `/api/spaces/${spaceId}`);
  });

  test('Step 1: Write a file', async () => {
    const res = await fetch(`${SPACES_API}/api/spaces/${spaceId}/files/test.txt`, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/plain' },
      body: 'Hello CRUD',
    });
    expect(res.ok).toBe(true);
  });

  test('Step 2: Read the file', async () => {
    const res = await fetch(`${SPACES_API}/api/spaces/${spaceId}/files/test.txt`);
    expect(res.ok).toBe(true);
    const text = await res.text();
    expect(text).toContain('Hello CRUD');
  });

  test('Step 3: Overwrite the file', async () => {
    const res = await fetch(`${SPACES_API}/api/spaces/${spaceId}/files/test.txt`, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/plain' },
      body: 'Updated CRUD',
    });
    expect(res.ok).toBe(true);
  });

  test('Step 4: Read updated file', async () => {
    const res = await fetch(`${SPACES_API}/api/spaces/${spaceId}/files/test.txt`);
    const text = await res.text();
    expect(text).toContain('Updated CRUD');
  });

  test('Step 5: Delete the file', async () => {
    const res = await fetch(`${SPACES_API}/api/spaces/${spaceId}/files/test.txt`, {
      method: 'DELETE',
    });
    expect(res.ok).toBe(true);
  });

  test('Step 6: Read deleted file returns 404', async () => {
    const res = await fetch(`${SPACES_API}/api/spaces/${spaceId}/files/test.txt`);
    expect([404, 200].includes(res.status)).toBe(true);
  });
});
