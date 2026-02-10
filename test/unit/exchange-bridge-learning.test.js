/**
 * Exchange Bridge Learning Pipeline Integration Tests
 *
 * Tests the hook in exchange-bridge.js (task:settled handler) that calls
 * memoryAgent.observeConversation() for cross-agent learning, with a
 * fallback to the legacy extractAndSaveUserFacts() if the memory agent
 * fails to load.
 *
 * Since exchange-bridge.js is deeply coupled to Electron (IPC, windows, etc.),
 * we test the hook CONTRACT and wiring pattern, not the full bridge.
 *
 * What we verify:
 *   1. memory-agent module exports observeConversation with the right signature
 *   2. The try/catch + fallback pattern works correctly
 *   3. observeConversation returning a rejected promise doesn't throw
 *   4. The hook skips when result.success === false
 *
 * Run:  npx vitest run test/unit/exchange-bridge-learning.test.js
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Silence logging
vi.mock('../../lib/log-event-queue', () => ({
  getLogQueue: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

describe('Exchange Bridge: Cross-Agent Learning Hook', () => {

  // ═══════════════════════════════════════════════════════════════════════════
  // Contract: memory-agent exports the right interface
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Memory Agent Contract', () => {

    it('should export observeConversation as a function', () => {
      const memoryAgent = require('../../packages/agents/memory-agent');
      expect(typeof memoryAgent.observeConversation).toBe('function');
    });

    it('should export execute as a function', () => {
      const memoryAgent = require('../../packages/agents/memory-agent');
      expect(typeof memoryAgent.execute).toBe('function');
    });

    it('should export _setDeps for test injection', () => {
      const memoryAgent = require('../../packages/agents/memory-agent');
      expect(typeof memoryAgent._setDeps).toBe('function');
    });

    it('observeConversation should return a Promise', () => {
      const memoryAgent = require('../../packages/agents/memory-agent');
      // Inject a minimal mock to avoid real file access
      memoryAgent._setDeps({
        getUserProfile: () => ({
          isLoaded: () => true, load: async () => {},
          getFacts: () => ({}), updateFact: vi.fn(), save: vi.fn(),
          _store: { parseSectionAsKeyValue: () => ({}), updateSection: vi.fn(), updateSectionAsKeyValue: vi.fn() },
        }),
        getAgentMemory: () => ({
          load: async () => {}, getRaw: () => '', getSection: () => null,
          updateSection: vi.fn(), getSectionNames: () => [],
          parseSectionAsKeyValue: () => ({}), isDirty: () => false, save: vi.fn(),
        }),
        listAgentMemories: () => [],
        aiJson: async () => ({ shouldUpdate: false, reasoning: 'test', profileChanges: { facts: {} }, agentChanges: [] }),
      });

      const result = memoryAgent.observeConversation(
        { content: 'test message here' },
        { success: true, message: 'response' },
        'test-agent'
      );
      expect(result).toBeInstanceOf(Promise);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Hook Wiring Pattern (simulates the exchange-bridge code)
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Hook Wiring Pattern', () => {

    /**
     * This function replicates the exact pattern used in exchange-bridge.js
     * at the task:settled handler (~line 3220):
     *
     *   if (result?.success !== false) {
     *     try {
     *       const memoryAgent = require('../../packages/agents/memory-agent');
     *       memoryAgent.observeConversation(task, result, agentId).catch(e => ...);
     *     } catch (e) {
     *       extractAndSaveUserFacts(task, result, agentId).catch(e2 => ...);
     *     }
     *   }
     */
    function simulateHook(task, result, agentId, { requireFn, fallbackFn, logFn }) {
      let usedPrimary = false;
      let usedFallback = false;

      if (result?.success !== false) {
        try {
          const memoryAgent = requireFn();
          memoryAgent.observeConversation(task, result, agentId).catch(e => {
            logFn?.('MemoryObserver error: ' + e.message);
          });
          usedPrimary = true;
        } catch (e) {
          fallbackFn(task, result, agentId).catch(e2 => {
            logFn?.('LearningPipeline error: ' + e2.message);
          });
          usedFallback = true;
        }
      }

      return { usedPrimary, usedFallback };
    }

    it('should use memory-agent.observeConversation on happy path', () => {
      const mockObserve = vi.fn(async () => ({ learned: false, changes: [] }));
      const mockFallback = vi.fn(async () => {});

      const { usedPrimary, usedFallback } = simulateHook(
        { content: 'test' },
        { success: true, message: 'ok' },
        'time-agent',
        {
          requireFn: () => ({ observeConversation: mockObserve }),
          fallbackFn: mockFallback,
          logFn: vi.fn(),
        }
      );

      expect(usedPrimary).toBe(true);
      expect(usedFallback).toBe(false);
      expect(mockObserve).toHaveBeenCalledWith(
        { content: 'test' },
        { success: true, message: 'ok' },
        'time-agent'
      );
      expect(mockFallback).not.toHaveBeenCalled();
    });

    it('should fall back to extractAndSaveUserFacts when require fails', () => {
      const mockFallback = vi.fn(async () => {});

      const { usedPrimary, usedFallback } = simulateHook(
        { content: 'test' },
        { success: true, message: 'ok' },
        'time-agent',
        {
          requireFn: () => { throw new Error('Module not found'); },
          fallbackFn: mockFallback,
          logFn: vi.fn(),
        }
      );

      expect(usedPrimary).toBe(false);
      expect(usedFallback).toBe(true);
      expect(mockFallback).toHaveBeenCalledWith(
        { content: 'test' },
        { success: true, message: 'ok' },
        'time-agent'
      );
    });

    it('should skip entirely when result.success is false', () => {
      const mockObserve = vi.fn(async () => ({ learned: false, changes: [] }));
      const mockFallback = vi.fn(async () => {});

      const { usedPrimary, usedFallback } = simulateHook(
        { content: 'test' },
        { success: false, message: 'error' },
        'time-agent',
        {
          requireFn: () => ({ observeConversation: mockObserve }),
          fallbackFn: mockFallback,
          logFn: vi.fn(),
        }
      );

      expect(usedPrimary).toBe(false);
      expect(usedFallback).toBe(false);
      expect(mockObserve).not.toHaveBeenCalled();
      expect(mockFallback).not.toHaveBeenCalled();
    });

    it('should not throw when observeConversation rejects', async () => {
      const logFn = vi.fn();

      simulateHook(
        { content: 'test' },
        { success: true, message: 'ok' },
        'time-agent',
        {
          requireFn: () => ({
            observeConversation: vi.fn(async () => { throw new Error('AI exploded'); }),
          }),
          fallbackFn: vi.fn(async () => {}),
          logFn,
        }
      );

      // Wait for the async rejection to be caught
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(logFn).toHaveBeenCalledWith(expect.stringContaining('AI exploded'));
    });

    it('should proceed when result.success is undefined (treated as success)', () => {
      const mockObserve = vi.fn(async () => ({ learned: false, changes: [] }));

      const { usedPrimary } = simulateHook(
        { content: 'test' },
        { message: 'ok' },  // no success field
        'time-agent',
        {
          requireFn: () => ({ observeConversation: mockObserve }),
          fallbackFn: vi.fn(async () => {}),
          logFn: vi.fn(),
        }
      );

      expect(usedPrimary).toBe(true);
      expect(mockObserve).toHaveBeenCalled();
    });

    it('should proceed when result.success is true', () => {
      const mockObserve = vi.fn(async () => ({ learned: false, changes: [] }));

      const { usedPrimary } = simulateHook(
        { content: 'test' },
        { success: true, message: 'ok' },
        'weather-agent',
        {
          requireFn: () => ({ observeConversation: mockObserve }),
          fallbackFn: vi.fn(async () => {}),
          logFn: vi.fn(),
        }
      );

      expect(usedPrimary).toBe(true);
    });
  });
});
