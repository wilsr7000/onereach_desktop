/**
 * Unit tests for the clipboard-manager-v2-adapter FIFO eviction guards.
 *
 * Background: prior to 2026-04-27, addToHistory() ran a blind FIFO eviction
 * any time the in-memory `history` array grew past `maxHistorySize`. It just
 * popped the oldest item and called storage.deleteItem() on it -- with NO
 * check for whether the item was pinned or had been moved into a named
 * space. Worse, storage.deleteItem() bypasses the spaces-sync event hook,
 * so evicted items vanished from disk + DuckDB without any audit trail.
 *
 * The user lost an Anthropic API key from a "KEYS" space this way -- it sat
 * past the 1000-item rolling cap and got silently nuked when later clipboard
 * captures pushed it off the tail.
 *
 * The fix walks the history from oldest -> newest and only evicts items
 * that are BOTH unpinned AND in the 'unclassified' catch-all. Anything the
 * user has organized -- pinned or space-classified -- stays forever; the
 * cap is only meant to bound the unclassified clipboard noise stream.
 *
 * These tests exercise that guard logic in isolation by instantiating the
 * adapter, stubbing the underlying storage's deleteItem(), and seeding the
 * history array directly so we can inspect what gets evicted.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mute the log queue.
vi.mock('../../lib/log-event-queue', () => ({
  getLogQueue: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

// Stub Electron's `app` -- the adapter touches it transitively through
// other requires when we instantiate via Object.create. We don't need it
// here since we never go through the constructor.
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/test' },
  BrowserWindow: { getAllWindows: () => [] },
}));

// The module exports the class directly (CJS default export).
const ClipboardManagerV2 = require('../../clipboard-manager-v2-adapter');

/**
 * Build a minimal adapter instance without running the constructor.
 * The eviction code only touches `this.history`, `this.maxHistorySize`,
 * `this.pinnedItems`, and `this.storage.deleteItem()`. Stub those.
 */
function makeAdapter({ maxHistorySize = 5, pinned = new Set(), history = [] } = {}) {
  expect(typeof ClipboardManagerV2).toBe('function');
  const adapter = Object.create(ClipboardManagerV2.prototype);
  adapter.history = history;
  adapter.pinnedItems = pinned;
  adapter.maxHistorySize = maxHistorySize;
  adapter.deletedIds = [];
  adapter.storage = {
    deleteItem: (id) => {
      adapter.deletedIds.push(id);
    },
  };
  return adapter;
}

/**
 * Inline replica of the adapter's eviction loop. Lets us exercise the
 * exact decision logic the production path runs without invoking
 * addToHistory()'s 200+ lines of unrelated work (context capture, AI
 * metadata, IPC fan-out, etc.).
 */
function runEviction(adapter) {
  while (adapter.history.length > adapter.maxHistorySize) {
    const evictIndex = adapter._findEvictableIndex();
    if (evictIndex === -1) break;
    const removed = adapter.history[evictIndex];
    adapter.history.splice(evictIndex, 1);
    adapter.storage.deleteItem(removed.id);
  }
}

// ────────────────────────────────────────────────────────────────────────────

describe('clipboard FIFO eviction guards', () => {
  describe('_findEvictableIndex', () => {
    it('returns the tail index when every item is unpinned + unclassified', () => {
      const adapter = makeAdapter({
        history: [
          { id: 'newest', spaceId: 'unclassified' },
          { id: 'middle', spaceId: 'unclassified' },
          { id: 'oldest', spaceId: 'unclassified' },
        ],
      });
      expect(adapter._findEvictableIndex()).toBe(2);
    });

    it('skips pinned items and returns the next-oldest unclassified', () => {
      const adapter = makeAdapter({
        pinned: new Set(['oldest']),
        history: [
          { id: 'newest', spaceId: 'unclassified' },
          { id: 'middle', spaceId: 'unclassified' },
          { id: 'oldest', spaceId: 'unclassified' },
        ],
      });
      expect(adapter._findEvictableIndex()).toBe(1);
    });

    it('skips items in a named space (e.g. KEYS)', () => {
      const adapter = makeAdapter({
        history: [
          { id: 'newest', spaceId: 'unclassified' },
          { id: 'middle', spaceId: 'KEYS' },
          { id: 'oldest', spaceId: 'KEYS' },
        ],
      });
      expect(adapter._findEvictableIndex()).toBe(0);
    });

    it('returns -1 when nothing is evictable (everything is protected)', () => {
      const adapter = makeAdapter({
        pinned: new Set(['p1']),
        history: [
          { id: 'p1', spaceId: 'unclassified' },
          { id: 'k1', spaceId: 'KEYS' },
          { id: 'k2', spaceId: 'KEYS' },
        ],
      });
      expect(adapter._findEvictableIndex()).toBe(-1);
    });

    it('treats missing/undefined spaceId as unclassified', () => {
      const adapter = makeAdapter({
        history: [
          { id: 'a', spaceId: 'KEYS' },
          { id: 'b' /* no spaceId */ },
        ],
      });
      expect(adapter._findEvictableIndex()).toBe(1);
    });

    it('treats explicit null spaceId as unclassified', () => {
      const adapter = makeAdapter({
        history: [
          { id: 'a', spaceId: 'KEYS' },
          { id: 'b', spaceId: null },
        ],
      });
      expect(adapter._findEvictableIndex()).toBe(1);
    });
  });

  describe('eviction loop end-to-end', () => {
    it('evicts the oldest unclassified item and stops when at the cap', () => {
      const adapter = makeAdapter({
        maxHistorySize: 3,
        history: [
          { id: '5', spaceId: 'unclassified' },
          { id: '4', spaceId: 'unclassified' },
          { id: '3', spaceId: 'unclassified' },
          { id: '2', spaceId: 'unclassified' },
          { id: '1', spaceId: 'unclassified' },
        ],
      });
      runEviction(adapter);
      expect(adapter.history.map((h) => h.id)).toEqual(['5', '4', '3']);
      expect(adapter.deletedIds).toEqual(['1', '2']);
    });

    it("never evicts a pinned API-key item even when it's the oldest", () => {
      const adapter = makeAdapter({
        maxHistorySize: 2,
        pinned: new Set(['api-key-id']),
        history: [
          { id: 'noise-2', spaceId: 'unclassified' },
          { id: 'noise-1', spaceId: 'unclassified' },
          { id: 'api-key-id', spaceId: 'unclassified' /* pinned */ },
        ],
      });
      runEviction(adapter);
      expect(adapter.history.find((i) => i.id === 'api-key-id')).toBeTruthy();
      expect(adapter.deletedIds).not.toContain('api-key-id');
      expect(adapter.deletedIds).toEqual(['noise-1']);
    });

    it("never evicts an item the user moved into a named 'KEYS' space", () => {
      // Simulates the exact reported bug: user pasted Anthropic API key into
      // a "KEYS" space; later clipboard captures pushed history past the
      // cap. With the old blind FIFO, the API key would be popped and
      // storage.deleteItem'd. With the new guard, it stays.
      const adapter = makeAdapter({
        maxHistorySize: 3,
        history: [
          { id: 'recent-1', spaceId: 'unclassified' },
          { id: 'recent-2', spaceId: 'unclassified' },
          { id: 'recent-3', spaceId: 'unclassified' },
          { id: 'recent-4', spaceId: 'unclassified' },
          { id: 'anthropic-api-key', spaceId: 'KEYS' },
        ],
      });
      runEviction(adapter);
      const stillThere = adapter.history.find((i) => i.id === 'anthropic-api-key');
      expect(stillThere).toBeTruthy();
      expect(adapter.deletedIds).not.toContain('anthropic-api-key');
      // The two oldest unclassified entries should be the ones that got popped.
      expect(adapter.deletedIds).toEqual(['recent-4', 'recent-3']);
    });

    it('lets history grow past the cap rather than nuke organized content', () => {
      const adapter = makeAdapter({
        maxHistorySize: 2,
        history: [
          { id: 'k1', spaceId: 'KEYS' },
          { id: 'k2', spaceId: 'KEYS' },
          { id: 'k3', spaceId: 'KEYS' },
          { id: 'k4', spaceId: 'KEYS' },
        ],
      });
      runEviction(adapter);
      expect(adapter.deletedIds).toEqual([]);
      expect(adapter.history.length).toBe(4); // grew past cap, no deletions
    });

    it('mixed history: keeps all KEYS + pinned, evicts only unclassified noise', () => {
      const adapter = makeAdapter({
        maxHistorySize: 4,
        pinned: new Set(['important-pin']),
        history: [
          { id: 'noise-3', spaceId: 'unclassified' },
          { id: 'k-vip', spaceId: 'KEYS' },
          { id: 'noise-2', spaceId: 'unclassified' },
          { id: 'important-pin', spaceId: 'unclassified' /* pinned */ },
          { id: 'noise-1', spaceId: 'unclassified' },
          { id: 'k-other', spaceId: 'KEYS' },
        ],
      });
      runEviction(adapter);
      // 6 -> 4: must evict 2 items, both must be unclassified-and-unpinned.
      const remaining = adapter.history.map((i) => i.id);
      expect(remaining).toContain('k-vip');
      expect(remaining).toContain('k-other');
      expect(remaining).toContain('important-pin');
      // Two of the three "noise-*" items were popped.
      const evictedNoise = adapter.deletedIds.filter((id) => id.startsWith('noise-'));
      expect(evictedNoise.length).toBe(2);
      expect(adapter.history.length).toBe(4);
    });
  });
});
