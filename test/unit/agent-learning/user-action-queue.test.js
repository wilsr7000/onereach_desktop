/**
 * User Action Queue Tests
 *
 * Tests the queue that tracks things the learning system needs from
 * the user or wants to tell them, built on HUD Items.
 *
 * Run:  npx vitest run test/unit/agent-learning/user-action-queue.test.js
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../lib/log-event-queue', () => ({
  getLogQueue: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
}));

const mockHudApi = {
  addHUDItem: vi.fn((toolId, item) => ({
    id: `hud-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    ...item,
    timestamp: Date.now(),
  })),
  removeHUDItem: vi.fn(),
};

const queue = require('../../../lib/agent-learning/user-action-queue');

describe('UserActionQueue', () => {
  beforeEach(() => {
    queue.clear();
    queue._setTestDeps({ hudApi: mockHudApi });
    mockHudApi.addHUDItem.mockClear();
    mockHudApi.removeHUDItem.mockClear();
  });

  describe('addItem', () => {
    it('creates an item and calls addHUDItem', () => {
      const item = queue.addItem({
        type: 'info',
        text: 'Agent improved',
        agentId: 'weather-agent',
        agentName: 'Weather',
      });

      expect(item.id).toBeTruthy();
      expect(item.text).toBe('Agent improved');
      expect(item.agentName).toBe('Weather');
      expect(mockHudApi.addHUDItem).toHaveBeenCalledWith(
        'agent-learning',
        expect.objectContaining({ type: 'info', text: 'Agent improved' })
      );
    });
  });

  describe('convenience methods', () => {
    it('addActionNeeded sets type action-needed', () => {
      const item = queue.addActionNeeded({ text: 'Add API key' });
      expect(item.type).toBe('action-needed');
    });

    it('addReviewItem sets type review', () => {
      const item = queue.addReviewItem({ text: 'Review improvement' });
      expect(item.type).toBe('review');
    });

    it('addInfoItem sets type info', () => {
      const item = queue.addInfoItem({ text: 'Stats updated' });
      expect(item.type).toBe('info');
    });

    it('addBlockedItem sets type blocked', () => {
      const item = queue.addBlockedItem({ text: 'Needs credentials' });
      expect(item.type).toBe('blocked');
    });

    it('addSuggestion sets type suggestion', () => {
      const item = queue.addSuggestion({ text: 'Consider adding memory' });
      expect(item.type).toBe('suggestion');
    });
  });

  describe('resolveItem', () => {
    it('marks item as resolved and removes from HUD', () => {
      const item = queue.addItem({ type: 'action-needed', text: 'Do X' });
      const result = queue.resolveItem(item.id);

      expect(result).toBe(true);
      expect(mockHudApi.removeHUDItem).toHaveBeenCalledWith('agent-learning', item.id);
    });

    it('resolved items are excluded from getItems', () => {
      const item = queue.addItem({ type: 'info', text: 'Test' });
      queue.resolveItem(item.id);

      expect(queue.getItems()).toHaveLength(0);
    });

    it('returns false for unknown item', () => {
      expect(queue.resolveItem('nonexistent')).toBe(false);
    });
  });

  describe('getItems', () => {
    it('returns all unresolved items', () => {
      queue.addItem({ type: 'info', text: 'A' });
      queue.addItem({ type: 'action-needed', text: 'B' });
      queue.addItem({ type: 'review', text: 'C' });

      expect(queue.getItems()).toHaveLength(3);
    });

    it('filters by type', () => {
      queue.addItem({ type: 'info', text: 'A' });
      queue.addItem({ type: 'action-needed', text: 'B' });
      queue.addItem({ type: 'action-needed', text: 'C' });

      expect(queue.getItems('action-needed')).toHaveLength(2);
      expect(queue.getItems('info')).toHaveLength(1);
    });
  });

  describe('getItemsForAgent', () => {
    it('returns items for a specific agent', () => {
      queue.addItem({ type: 'info', text: 'A', agentId: 'agent-1' });
      queue.addItem({ type: 'info', text: 'B', agentId: 'agent-2' });
      queue.addItem({ type: 'review', text: 'C', agentId: 'agent-1' });

      expect(queue.getItemsForAgent('agent-1')).toHaveLength(2);
      expect(queue.getItemsForAgent('agent-2')).toHaveLength(1);
    });
  });

  describe('getCounts', () => {
    it('returns counts by type', () => {
      queue.addItem({ type: 'info', text: 'A' });
      queue.addItem({ type: 'action-needed', text: 'B' });
      queue.addItem({ type: 'action-needed', text: 'C' });

      const counts = queue.getCounts();
      expect(counts.total).toBe(3);
      expect(counts['action-needed']).toBe(2);
      expect(counts['info']).toBe(1);
    });

    it('excludes resolved items', () => {
      const item = queue.addItem({ type: 'info', text: 'A' });
      queue.addItem({ type: 'info', text: 'B' });
      queue.resolveItem(item.id);

      expect(queue.getCounts().total).toBe(1);
    });
  });

  describe('getAllItems', () => {
    it('includes resolved items for history', () => {
      const item = queue.addItem({ type: 'info', text: 'A' });
      queue.resolveItem(item.id);
      queue.addItem({ type: 'info', text: 'B' });

      expect(queue.getAllItems()).toHaveLength(2);
    });
  });

  describe('removeItem', () => {
    it('removes item entirely', () => {
      const item = queue.addItem({ type: 'info', text: 'A' });
      queue.removeItem(item.id);

      expect(queue.getAllItems()).toHaveLength(0);
      expect(mockHudApi.removeHUDItem).toHaveBeenCalled();
    });
  });

  describe('clear', () => {
    it('removes all items', () => {
      queue.addItem({ type: 'info', text: 'A' });
      queue.addItem({ type: 'info', text: 'B' });
      queue.clear();

      expect(queue.getAllItems()).toHaveLength(0);
    });
  });

  describe('tags', () => {
    it('includes agent-learning and type in tags', () => {
      queue.addItem({ type: 'action-needed', text: 'Test', tags: ['custom'] });

      expect(mockHudApi.addHUDItem).toHaveBeenCalledWith(
        'agent-learning',
        expect.objectContaining({
          tags: expect.arrayContaining(['agent-learning', 'action-needed', 'custom']),
        })
      );
    });
  });
});
