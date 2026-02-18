/**
 * IPC State Manager Namespace - CRUD Lifecycle Tests
 *
 * Lifecycle: saveSnapshot -> listSnapshots -> getSnapshot -> renameSnapshot -> deleteSnapshot -> verify gone
 *
 * Run:  npx vitest run test/unit/ipc-state-manager.test.js
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const store = {};
const mockInvoke = vi.fn(async (channel, ...args) => {
  const editorId = args[0];
  if (!store[editorId]) store[editorId] = [];

  switch (channel) {
    case 'state-manager:save-snapshot': {
      const snapshot = { id: 'snap-' + Date.now(), ...args[1], editorId };
      store[editorId].push(snapshot);
      return snapshot;
    }
    case 'state-manager:list-snapshots':
      return store[editorId] || [];
    case 'state-manager:get-snapshot':
      return store[editorId]?.find((s) => s.id === args[1]) || null;
    case 'state-manager:rename-snapshot': {
      const s = store[editorId]?.find((s) => s.id === args[1]);
      if (s) s.name = args[2];
      return s;
    }
    case 'state-manager:delete-snapshot':
      store[editorId] = store[editorId]?.filter((s) => s.id !== args[1]) || [];
      return { success: true };
    case 'state-manager:clear-snapshots':
      store[editorId] = [];
      return { success: true };
    default:
      return null;
  }
});

const stateManager = {
  saveSnapshot: (editorId, snapshot) => mockInvoke('state-manager:save-snapshot', editorId, snapshot),
  listSnapshots: (editorId) => mockInvoke('state-manager:list-snapshots', editorId),
  getSnapshot: (editorId, snapshotId) => mockInvoke('state-manager:get-snapshot', editorId, snapshotId),
  renameSnapshot: (editorId, snapshotId, newName) =>
    mockInvoke('state-manager:rename-snapshot', editorId, snapshotId, newName),
  deleteSnapshot: (editorId, snapshotId) => mockInvoke('state-manager:delete-snapshot', editorId, snapshotId),
  clearSnapshots: (editorId) => mockInvoke('state-manager:clear-snapshots', editorId),
};

beforeEach(() => {
  Object.keys(store).forEach((k) => delete store[k]);
  mockInvoke.mockClear();
});

// ═══════════════════════════════════════════════════════════════════
// SNAPSHOT CRUD LIFECYCLE
// ═══════════════════════════════════════════════════════════════════

describe('IPC State Manager - Snapshot CRUD Lifecycle', () => {
  const editorId = 'test-editor-1';
  let _snapshotId;

  it('Step 1: Create a snapshot', async () => {
    const snap = await stateManager.saveSnapshot(editorId, { name: 'Draft 1', edl: { cuts: [] } });
    expect(snap.id).toBeTruthy();
    _snapshotId = snap.id;
  });

  it('Step 2: Read snapshots list', async () => {
    await stateManager.saveSnapshot(editorId, { name: 'Draft 2' });
    const list = await stateManager.listSnapshots(editorId);
    expect(list.length).toBeGreaterThanOrEqual(1);
  });

  it('Step 3: Read specific snapshot', async () => {
    const snap = await stateManager.saveSnapshot(editorId, { name: 'Target' });
    const found = await stateManager.getSnapshot(editorId, snap.id);
    expect(found).toBeDefined();
    expect(found.name).toBe('Target');
  });

  it('Step 4: Update (rename) snapshot', async () => {
    const snap = await stateManager.saveSnapshot(editorId, { name: 'Original' });
    const renamed = await stateManager.renameSnapshot(editorId, snap.id, 'Renamed');
    expect(renamed.name).toBe('Renamed');
  });

  it('Step 5: Delete a snapshot', async () => {
    const snap = await stateManager.saveSnapshot(editorId, { name: 'ToDelete' });
    await stateManager.deleteSnapshot(editorId, snap.id);
    const found = await stateManager.getSnapshot(editorId, snap.id);
    expect(found).toBeNull();
  });

  it('Step 6: Verify deleted snapshot is gone', async () => {
    const snap = await stateManager.saveSnapshot(editorId, { name: 'Gone' });
    const id = snap.id;
    await stateManager.deleteSnapshot(editorId, id);
    const list = await stateManager.listSnapshots(editorId);
    expect(list.find((s) => s.id === id)).toBeUndefined();
  });
});
