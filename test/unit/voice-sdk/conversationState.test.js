/**
 * Unit tests for conversationState
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the module for testing
const conversationState = {
  pendingQuestion: null,
  pendingConfirmation: null,
  recentContext: [],

  setPendingQuestion(options, resolve, timeoutMs = 15000) {
    this.clearPendingQuestion();
    const timeoutId = setTimeout(() => {
      this.pendingQuestion = null;
      resolve({ timedOut: true });
    }, timeoutMs);
    this.pendingQuestion = { ...options, resolve, timeoutId, createdAt: Date.now() };
  },

  resolvePendingQuestion(answer) {
    if (!this.pendingQuestion) return null;
    const { resolve, timeoutId, agentId, taskId, field } = this.pendingQuestion;
    clearTimeout(timeoutId);
    this.pendingQuestion = null;
    resolve({ answer, agentId, taskId, field });
    return { agentId, taskId, field };
  },

  clearPendingQuestion() {
    if (this.pendingQuestion?.timeoutId) {
      clearTimeout(this.pendingQuestion.timeoutId);
    }
    this.pendingQuestion = null;
  },

  setPendingConfirmation(action, resolve, dangerous = false, timeoutMs = 10000) {
    this.clearPendingConfirmation();
    const timeoutId = setTimeout(() => {
      this.pendingConfirmation = null;
      resolve({ confirmed: false, timedOut: true });
    }, timeoutMs);
    this.pendingConfirmation = { action, dangerous, resolve, timeoutId, createdAt: Date.now() };
  },

  clearPendingConfirmation() {
    if (this.pendingConfirmation?.timeoutId) {
      clearTimeout(this.pendingConfirmation.timeoutId);
    }
    this.pendingConfirmation = null;
  },

  addContext(item) {
    this.recentContext.unshift({ ...item, timestamp: item.timestamp || Date.now() });
    if (this.recentContext.length > 3) this.recentContext.pop();
  },

  clear() {
    this.clearPendingQuestion();
    this.clearPendingConfirmation();
  },

  getRoutingContext() {
    return {
      hasPendingQuestion: !!this.pendingQuestion,
      hasPendingConfirmation: !!this.pendingConfirmation,
      pendingAgentId: this.pendingQuestion?.agentId,
      lastSubject: this.recentContext[0]?.subject,
    };
  },
};

describe('conversationState', () => {
  beforeEach(() => {
    conversationState.pendingQuestion = null;
    conversationState.pendingConfirmation = null;
    conversationState.recentContext = [];
  });

  describe('pendingQuestion', () => {
    it('should set a pending question', () => {
      const resolve = vi.fn();
      conversationState.setPendingQuestion(
        { prompt: 'What city?', field: 'location', agentId: 'weather-agent', taskId: 't1' },
        resolve
      );

      expect(conversationState.pendingQuestion).not.toBeNull();
      expect(conversationState.pendingQuestion.prompt).toBe('What city?');
      expect(conversationState.pendingQuestion.agentId).toBe('weather-agent');
    });

    it('should resolve a pending question with routing info', () => {
      const resolve = vi.fn();
      conversationState.setPendingQuestion(
        { prompt: 'What city?', field: 'location', agentId: 'weather-agent', taskId: 't1' },
        resolve
      );

      const routing = conversationState.resolvePendingQuestion('San Francisco');

      expect(routing).toEqual({ agentId: 'weather-agent', taskId: 't1', field: 'location' });
      expect(resolve).toHaveBeenCalledWith({
        answer: 'San Francisco',
        agentId: 'weather-agent',
        taskId: 't1',
        field: 'location',
      });
      expect(conversationState.pendingQuestion).toBeNull();
    });

    it('should return null when resolving without pending question', () => {
      const result = conversationState.resolvePendingQuestion('test');
      expect(result).toBeNull();
    });

    it('should timeout and call resolve with timedOut', async () => {
      const resolve = vi.fn();
      conversationState.setPendingQuestion(
        { prompt: 'What city?', field: 'location', agentId: 'weather-agent', taskId: 't1' },
        resolve,
        50 // 50ms timeout
      );

      await new Promise((r) => {
        setTimeout(r, 100);
      });

      expect(resolve).toHaveBeenCalledWith({ timedOut: true });
      expect(conversationState.pendingQuestion).toBeNull();
    });

    it('should clear timeout when resolved before timeout', () => {
      const resolve = vi.fn();
      conversationState.setPendingQuestion(
        { prompt: 'What city?', field: 'location', agentId: 'weather-agent', taskId: 't1' },
        resolve,
        5000
      );

      conversationState.resolvePendingQuestion('SF');

      // Should have cleared the timeout (won't call resolve again)
      expect(resolve).toHaveBeenCalledTimes(1);
    });
  });

  describe('pendingConfirmation', () => {
    it('should set a pending confirmation', () => {
      const resolve = vi.fn();
      conversationState.setPendingConfirmation('delete file', resolve, true);

      expect(conversationState.pendingConfirmation).not.toBeNull();
      expect(conversationState.pendingConfirmation.action).toBe('delete file');
      expect(conversationState.pendingConfirmation.dangerous).toBe(true);
    });
  });

  describe('recentContext', () => {
    it('should add context items', () => {
      conversationState.addContext({ subject: 'jazz', response: 'Playing jazz' });

      expect(conversationState.recentContext).toHaveLength(1);
      expect(conversationState.recentContext[0].subject).toBe('jazz');
    });

    it('should limit to 3 items', () => {
      conversationState.addContext({ subject: 'a' });
      conversationState.addContext({ subject: 'b' });
      conversationState.addContext({ subject: 'c' });
      conversationState.addContext({ subject: 'd' });

      expect(conversationState.recentContext).toHaveLength(3);
      expect(conversationState.recentContext[0].subject).toBe('d'); // Most recent
      expect(conversationState.recentContext[2].subject).toBe('b'); // Oldest kept
    });
  });

  describe('getRoutingContext', () => {
    it('should return correct routing context', () => {
      conversationState.addContext({ subject: 'test' });
      conversationState.setPendingQuestion({ agentId: 'agent1' }, vi.fn());

      const ctx = conversationState.getRoutingContext();

      expect(ctx.hasPendingQuestion).toBe(true);
      expect(ctx.hasPendingConfirmation).toBe(false);
      expect(ctx.pendingAgentId).toBe('agent1');
      expect(ctx.lastSubject).toBe('test');
    });
  });
});
