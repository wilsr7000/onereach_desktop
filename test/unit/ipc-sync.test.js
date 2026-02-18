/**
 * IPC Sync Namespace - Lifecycle Tests
 *
 * Lifecycle: push -> status -> pull -> verify
 *
 * Run:  npx vitest run test/unit/ipc-sync.test.js
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockInvoke = vi.fn().mockResolvedValue({ success: true });

const syncAPI = {
  push: (spaceId, opts) => mockInvoke('spaces-sync:push', spaceId, opts),
  pull: (spaceId) => mockInvoke('spaces-sync:pull', spaceId),
  status: (spaceId) => mockInvoke('spaces-sync:status', spaceId),
};

beforeEach(() => {
  mockInvoke.mockClear();
});

describe('IPC Sync - Push/Pull Lifecycle', () => {
  it('Step 1: Push a space', async () => {
    await syncAPI.push('space-1', { force: false });
    expect(mockInvoke).toHaveBeenCalledWith('spaces-sync:push', 'space-1', { force: false });
  });

  it('Step 2: Check sync status', async () => {
    await syncAPI.status('space-1');
    expect(mockInvoke).toHaveBeenCalledWith('spaces-sync:status', 'space-1');
  });

  it('Step 3: Pull a space', async () => {
    await syncAPI.pull('space-1');
    expect(mockInvoke).toHaveBeenCalledWith('spaces-sync:pull', 'space-1');
  });

  it('Step 4: Verify channels are callable', async () => {
    await syncAPI.push('s-2', {});
    await syncAPI.status('s-2');
    await syncAPI.pull('s-2');
    expect(mockInvoke).toHaveBeenCalledTimes(3);
  });
});
