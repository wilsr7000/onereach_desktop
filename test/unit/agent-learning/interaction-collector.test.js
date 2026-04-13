/**
 * Interaction Collector Tests
 *
 * Tests rolling window, signal computation, event handling.
 *
 * Run:  npx vitest run test/unit/agent-learning/interaction-collector.test.js
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

vi.mock('../../../lib/log-event-queue', () => ({
  getLogQueue: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    subscribe: vi.fn(() => vi.fn()),
  }),
}));

const { InteractionCollector } = require('../../../lib/agent-learning/interaction-collector');

describe('InteractionCollector', () => {
  let collector;
  let bus;

  beforeEach(() => {
    bus = new EventEmitter();
    collector = new InteractionCollector({ windowSize: 5, minInteractionsForEval: 3 });
  });

  describe('start/stop', () => {
    it('subscribes to exchangeBus events on start', () => {
      collector.start(bus);
      expect(bus.listenerCount('learning:interaction')).toBe(1);
      expect(bus.listenerCount('learning:capability-gap')).toBe(1);
    });

    it('unsubscribes on stop', () => {
      collector.start(bus);
      collector.stop();
      expect(bus.listenerCount('learning:interaction')).toBe(0);
      expect(bus.listenerCount('learning:capability-gap')).toBe(0);
    });

    it('handles missing exchangeBus gracefully', () => {
      expect(() => collector.start(null)).not.toThrow();
    });
  });

  describe('interaction collection', () => {
    beforeEach(() => collector.start(bus));

    it('creates a window for a new agent', () => {
      bus.emit('learning:interaction', {
        agentId: 'test-agent', taskId: 't1', success: true, message: 'ok',
        userInput: 'hi', durationMs: 100, timestamp: Date.now(),
      });

      const win = collector.getWindow('test-agent');
      expect(win).toBeTruthy();
      expect(win.interactions).toHaveLength(1);
    });

    it('respects window size limit', () => {
      for (let i = 0; i < 10; i++) {
        bus.emit('learning:interaction', {
          agentId: 'test-agent', taskId: `t${i}`, success: true, message: 'ok',
          userInput: `msg ${i}`, durationMs: 100, timestamp: Date.now() + i * 1000,
        });
      }

      const win = collector.getWindow('test-agent');
      expect(win.interactions).toHaveLength(5); // windowSize is 5
    });

    it('computes failureRate correctly', () => {
      bus.emit('learning:interaction', { agentId: 'a', success: true, timestamp: 1 });
      bus.emit('learning:interaction', { agentId: 'a', success: false, timestamp: 2 });
      bus.emit('learning:interaction', { agentId: 'a', success: true, timestamp: 3 });

      const win = collector.getWindow('a');
      expect(win.failureRate).toBeCloseTo(1 / 3, 2);
    });

    it('computes uiSpecRate correctly', () => {
      bus.emit('learning:interaction', { agentId: 'a', success: true, hasUI: true, timestamp: 1 });
      bus.emit('learning:interaction', { agentId: 'a', success: true, hasUI: false, timestamp: 2 });

      const win = collector.getWindow('a');
      expect(win.uiSpecRate).toBeCloseTo(0.5, 2);
    });

    it('computes avgResponseTimeMs correctly', () => {
      bus.emit('learning:interaction', { agentId: 'a', durationMs: 100, timestamp: 1 });
      bus.emit('learning:interaction', { agentId: 'a', durationMs: 300, timestamp: 2 });

      const win = collector.getWindow('a');
      expect(win.avgResponseTimeMs).toBe(200);
    });

    it('detects rephrase when follow-up within 60s of failure', () => {
      const now = Date.now();
      bus.emit('learning:interaction', {
        agentId: 'a', success: false, timestamp: now, userInput: 'first try',
      });
      bus.emit('learning:interaction', {
        agentId: 'a', success: true, timestamp: now + 30000, userInput: 'rephrased',
      });

      const win = collector.getWindow('a');
      expect(win.interactions[1].followUpAction).toBe('rephrase');
      expect(win.rephraseRate).toBeGreaterThan(0);
    });

    it('does not flag as rephrase if previous was successful', () => {
      const now = Date.now();
      bus.emit('learning:interaction', {
        agentId: 'a', success: true, timestamp: now, userInput: 'first',
      });
      bus.emit('learning:interaction', {
        agentId: 'a', success: true, timestamp: now + 30000, userInput: 'second',
      });

      const win = collector.getWindow('a');
      expect(win.interactions[1].followUpAction).toBeNull();
    });

    it('ignores interactions without agentId', () => {
      bus.emit('learning:interaction', { success: true, message: 'ok' });
      expect(collector.getAllWindows()).toHaveLength(0);
    });
  });

  describe('capability gaps', () => {
    beforeEach(() => collector.start(bus));

    it('collects unmet requests', () => {
      bus.emit('learning:capability-gap', {
        userInput: 'play chess', gapSummary: 'no chess agent',
      });

      const gaps = collector.getUnmetRequests();
      expect(gaps).toHaveLength(1);
      expect(gaps[0].userInput).toBe('play chess');
    });
  });

  describe('getAgentsNeedingEvaluation', () => {
    beforeEach(() => collector.start(bus));

    it('only returns agents with enough interactions', () => {
      bus.emit('learning:interaction', { agentId: 'few', success: true, timestamp: 1 });
      bus.emit('learning:interaction', { agentId: 'enough', success: true, timestamp: 1 });
      bus.emit('learning:interaction', { agentId: 'enough', success: true, timestamp: 2 });
      bus.emit('learning:interaction', { agentId: 'enough', success: true, timestamp: 3 });

      const needing = collector.getAgentsNeedingEvaluation(3);
      expect(needing).toHaveLength(1);
      expect(needing[0].agentId).toBe('enough');
    });
  });

  describe('clear', () => {
    it('resets all state', () => {
      collector.start(bus);
      bus.emit('learning:interaction', { agentId: 'a', success: true, timestamp: 1 });
      bus.emit('learning:capability-gap', { userInput: 'test' });
      collector.clear();
      expect(collector.getAllWindows()).toHaveLength(0);
      expect(collector.getUnmetRequests()).toHaveLength(0);
    });
  });
});
