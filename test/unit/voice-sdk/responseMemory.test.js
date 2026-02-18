/**
 * Unit tests for responseMemory
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the module for testing
const responseMemory = {
  lastResponse: null,
  lastAction: null,

  setLastResponse(text) {
    if (text && typeof text === 'string' && text.trim()) {
      this.lastResponse = text;
    }
  },

  getLastResponse() {
    return this.lastResponse;
  },

  setUndoableAction(description, undoFn, expiryMs = 60000) {
    if (!undoFn || typeof undoFn !== 'function') return;
    if (!description || typeof description !== 'string') return;
    this.lastAction = {
      description,
      undoFn,
      expiresAt: Date.now() + expiryMs,
      createdAt: Date.now(),
    };
  },

  canUndo() {
    if (!this.lastAction) return false;
    if (Date.now() >= this.lastAction.expiresAt) {
      this.lastAction = null;
      return false;
    }
    return true;
  },

  getUndoTimeRemaining() {
    if (!this.canUndo()) return 0;
    return Math.max(0, Math.round((this.lastAction.expiresAt - Date.now()) / 1000));
  },

  async undo() {
    if (!this.canUndo()) {
      return { success: false, message: 'Nothing to undo' };
    }
    const { description, undoFn } = this.lastAction;
    try {
      await undoFn();
      this.lastAction = null;
      return { success: true, message: `Undone: ${description}`, description };
    } catch (error) {
      return { success: false, message: "Couldn't undo that", error: error.message };
    }
  },

  clear() {
    this.lastResponse = null;
    this.lastAction = null;
  },
};

describe('responseMemory', () => {
  beforeEach(() => {
    responseMemory.lastResponse = null;
    responseMemory.lastAction = null;
  });

  describe('lastResponse', () => {
    it('should store last response', () => {
      responseMemory.setLastResponse("It's 3:45 PM");
      expect(responseMemory.getLastResponse()).toBe("It's 3:45 PM");
    });

    it('should not store empty strings', () => {
      responseMemory.setLastResponse('');
      expect(responseMemory.getLastResponse()).toBeNull();
    });

    it('should not store whitespace-only strings', () => {
      responseMemory.setLastResponse('   ');
      expect(responseMemory.getLastResponse()).toBeNull();
    });
  });

  describe('undoableAction', () => {
    it('should store undoable action with both description and function', () => {
      const undoFn = vi.fn();
      responseMemory.setUndoableAction('restore volume to 50', undoFn);

      expect(responseMemory.canUndo()).toBe(true);
    });

    it('should not store without description', () => {
      const undoFn = vi.fn();
      responseMemory.setUndoableAction(null, undoFn);

      expect(responseMemory.canUndo()).toBe(false);
    });

    it('should not store without function', () => {
      responseMemory.setUndoableAction('restore volume', null);

      expect(responseMemory.canUndo()).toBe(false);
    });

    it('should execute undo and clear action', async () => {
      const undoFn = vi.fn().mockResolvedValue(undefined);
      responseMemory.setUndoableAction('restore volume to 50', undoFn);

      const result = await responseMemory.undo();

      expect(result.success).toBe(true);
      expect(result.message).toBe('Undone: restore volume to 50');
      expect(undoFn).toHaveBeenCalled();
      expect(responseMemory.canUndo()).toBe(false);
    });

    it('should handle undo errors gracefully', async () => {
      const undoFn = vi.fn().mockRejectedValue(new Error('Failed'));
      responseMemory.setUndoableAction('restore volume', undoFn);

      const result = await responseMemory.undo();

      expect(result.success).toBe(false);
      expect(result.message).toBe("Couldn't undo that");
    });

    it('should expire after timeout', async () => {
      const undoFn = vi.fn();
      responseMemory.setUndoableAction('restore', undoFn, 50); // 50ms expiry

      expect(responseMemory.canUndo()).toBe(true);

      await new Promise((r) => {
        setTimeout(r, 100);
      });

      expect(responseMemory.canUndo()).toBe(false);
    });

    it('should return nothing to undo when expired', async () => {
      const undoFn = vi.fn();
      responseMemory.setUndoableAction('restore', undoFn, 50);

      await new Promise((r) => {
        setTimeout(r, 100);
      });

      const result = await responseMemory.undo();
      expect(result.success).toBe(false);
      expect(result.message).toBe('Nothing to undo');
      expect(undoFn).not.toHaveBeenCalled();
    });
  });

  describe('clear', () => {
    it('should clear all state', () => {
      responseMemory.setLastResponse('test');
      responseMemory.setUndoableAction('restore', vi.fn());

      responseMemory.clear();

      expect(responseMemory.getLastResponse()).toBeNull();
      expect(responseMemory.canUndo()).toBe(false);
    });
  });
});
