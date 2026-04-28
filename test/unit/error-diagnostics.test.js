/**
 * Unit tests for lib/error-diagnostics.js
 *
 * Uses the SUT's own injection hooks (`_setClaudeRunner`, `_setAiService`,
 * `_setBudgetManager`) instead of vi.mock, which does not reliably intercept
 * CJS require() calls made inside the SUT in this repo's vitest setup.
 *
 * Covers:
 *   - Built-in hint table matches known WISER / LiveKit / preload / HTTP patterns
 *   - Cache hit + key normalization (numeric noise)
 *   - Budget-gated degradation
 *   - Claude Code -> ai-service -> structured fallback chain
 *   - Copyable bundle contains the expected fields
 *   - Empty-message + skip-LLM paths
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Stub the log queue before the SUT loads so we don't need a running queue.
vi.mock('../../lib/log-event-queue', () => ({
  getLogQueue: () => ({ info: () => {}, warn: () => {}, error: () => {} }),
}));

const diagnostics = require('../../lib/error-diagnostics');

function fakeRunner({ available = false, runResult = null, throwOnRun = false } = {}) {
  return {
    isClaudeCodeAvailable: async () => ({ available }),
    runClaudeCode: async () => {
      if (throwOnRun) throw new Error('spawn failed');
      return runResult || { success: false };
    },
  };
}

function fakeAiService({ jsonResult = null, throwOnJson = false } = {}) {
  return {
    json: async () => {
      if (throwOnJson) throw new Error('rate limited');
      if (!jsonResult) throw new Error('no result configured');
      return jsonResult;
    },
  };
}

function fakeBudget({ blocked = false } = {}) {
  return {
    getBudgetManager: () => ({
      checkBudget: () => ({ blocked, warnings: [] }),
    }),
  };
}

describe('error-diagnostics', () => {
  beforeEach(() => {
    diagnostics._resetInjections();
    diagnostics._clearCache();
  });

  // ────────────────────────────────────────────────────────────────────────
  // Built-in hint table
  // ────────────────────────────────────────────────────────────────────────

  describe('hint table', () => {
    it('matches the GSX cross-account error', async () => {
      const r = await diagnostics.diagnoseError(
        { message: 'Cross account requests allowed to SUPER_ADMIN only', category: 'recorder' },
        { skipLLM: true }
      );
      expect(r.source).toBe('hint');
      expect(r.hintId).toBe('gsx-cross-account');
      expect(r.summary).toMatch(/account/i);
      expect(r.steps.length).toBeGreaterThan(0);
    });

    it('matches the LiveKit metadata permission error', async () => {
      const r = await diagnostics.diagnoseError(
        { message: 'SignalRequestError: does not have permission to update own metadata' },
        { skipLLM: true }
      );
      expect(r.hintId).toBe('livekit-metadata-permission');
    });

    it('matches the preload module-not-found error', async () => {
      const r = await diagnostics.diagnoseError(
        { message: '[Recorder Preload] HUD API not available: module not found: ./preload-hud-api' },
        { skipLLM: true }
      );
      expect(r.hintId).toBe('module-not-found-preload');
      expect(r.rootCause).toMatch(/sandbox/i);
    });

    it('matches JSON truncation errors', async () => {
      const r = await diagnostics.diagnoseError(
        { message: 'Unterminated string in JSON at position 2039 (line 24 column 225)' },
        { skipLLM: true }
      );
      expect(r.hintId).toBe('json-parse-truncation');
    });

    it('matches ECONNREFUSED on a known port and surfaces the port number', async () => {
      const r = await diagnostics.diagnoseError(
        { message: 'connect ECONNREFUSED 127.0.0.1:47292' },
        { skipLLM: true }
      );
      expect(r.hintId).toBe('econn-refused');
      expect(r.summary).toMatch(/47292/);
    });

    it('matches HTTP 401/403/429 errors distinctly', async () => {
      const r401 = await diagnostics.diagnoseError({ message: 'Request failed: 401 Unauthorized' }, { skipLLM: true });
      const r403 = await diagnostics.diagnoseError({ message: 'API returned 403 Forbidden' }, { skipLLM: true });
      const r429 = await diagnostics.diagnoseError({ message: '429 Too Many Requests' }, { skipLLM: true });
      expect(r401.hintId).toBe('http-401');
      expect(r403.hintId).toBe('http-403');
      expect(r429.hintId).toBe('http-429');
    });

    it('falls through to the structured fallback when no hint matches and both LLM paths are unavailable', async () => {
      diagnostics._setClaudeRunner(fakeRunner({ available: false }));
      diagnostics._setAiService({ json: async () => { throw new Error('no key'); } });
      const r = await diagnostics.diagnoseError({
        message: 'A totally unique failure that no rule has seen before: 42-xyzzy',
      });
      expect(r.source).toBe('fallback');
      expect(r.degraded).toBeTruthy();
      expect(Array.isArray(r.steps)).toBe(true);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Cache
  // ────────────────────────────────────────────────────────────────────────

  describe('cache', () => {
    it('returns the same recommendation twice without re-running the hint', async () => {
      const first = await diagnostics.diagnoseError(
        { message: 'Cross account requests allowed to SUPER_ADMIN only' },
        { skipLLM: true }
      );
      const second = await diagnostics.diagnoseError(
        { message: 'Cross account requests allowed to SUPER_ADMIN only' },
        { skipLLM: true }
      );
      expect(first.cached).toBe(false);
      expect(second.cached).toBe(true);
      expect(second.summary).toBe(first.summary);
    });

    it('normalizes numeric noise so near-identical errors share a cache entry', async () => {
      const a = await diagnostics.diagnoseError(
        {
          message: 'Task 550e8400-e29b-41d4-a716-446655440000 timed out at 1713811200000',
          category: 'agent',
        },
        { skipLLM: true }
      );
      const b = await diagnostics.diagnoseError(
        {
          message: 'Task 0ef30afe-1234-5678-9abc-def012345678 timed out at 1713900000000',
          category: 'agent',
        },
        { skipLLM: true }
      );
      expect(a.cached).toBe(false);
      expect(b.cached).toBe(true);
    });

    it('skipCache bypasses a cached entry', async () => {
      await diagnostics.diagnoseError(
        { message: 'connect ECONNREFUSED 127.0.0.1:47292' },
        { skipLLM: true }
      );
      const second = await diagnostics.diagnoseError(
        { message: 'connect ECONNREFUSED 127.0.0.1:47292' },
        { skipLLM: true, skipCache: true }
      );
      expect(second.cached).toBe(false);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Budget gate
  // ────────────────────────────────────────────────────────────────────────

  describe('budget gate', () => {
    it('short-circuits to the fallback when the budget manager says blocked', async () => {
      diagnostics._setBudgetManager(fakeBudget({ blocked: true }));
      const r = await diagnostics.diagnoseError({ message: 'Some novel error nobody has seen before' });
      expect(r.source).toBe('fallback');
      expect(r.degraded).toBe('budget-exceeded');
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Claude Code / AI service chain
  // ────────────────────────────────────────────────────────────────────────

  describe('LLM chain', () => {
    it('uses Claude Code result when it returns valid JSON', async () => {
      diagnostics._setClaudeRunner(
        fakeRunner({
          available: true,
          runResult: {
            success: true,
            result: JSON.stringify({
              summary: 'The network is offline.',
              rootCause: 'No packets could reach the server.',
              steps: ['Check your Wi-Fi.', 'Try again in a minute.'],
            }),
          },
        })
      );
      const r = await diagnostics.diagnoseError({ message: 'some novel network error' });
      expect(r.source).toBe('claude-code');
      expect(r.summary).toBe('The network is offline.');
      expect(r.steps).toContain('Check your Wi-Fi.');
    });

    it('unwraps JSON wrapped in ```json fences', async () => {
      diagnostics._setClaudeRunner(
        fakeRunner({
          available: true,
          runResult: {
            success: true,
            result:
              '```json\n{"summary":"Fenced diagnosis","rootCause":"wrapped in a fence","steps":["Do thing."]}\n```',
          },
        })
      );
      const r = await diagnostics.diagnoseError({ message: 'unique fenced error' });
      expect(r.source).toBe('claude-code');
      expect(r.summary).toBe('Fenced diagnosis');
    });

    it('falls through to ai-service when Claude Code is unavailable', async () => {
      diagnostics._setClaudeRunner(fakeRunner({ available: false }));
      diagnostics._setAiService(
        fakeAiService({
          jsonResult: {
            summary: 'AI service picked this up.',
            rootCause: 'ai-service was used.',
            steps: ['Do the thing.'],
          },
        })
      );
      const r = await diagnostics.diagnoseError({ message: 'novel error with no rule' });
      expect(r.source).toBe('ai-service');
      expect(r.summary).toBe('AI service picked this up.');
    });

    it('surfaces fallback + degraded when both LLM paths fail', async () => {
      diagnostics._setClaudeRunner(fakeRunner({ available: true, throwOnRun: true }));
      diagnostics._setAiService(fakeAiService({ throwOnJson: true }));
      const r = await diagnostics.diagnoseError({ message: 'nothing matches me' });
      expect(r.source).toBe('fallback');
      expect(r.degraded).toBe('llm-unavailable');
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Copyable bundle
  // ────────────────────────────────────────────────────────────────────────

  describe('copyable bundle', () => {
    it('includes headline, cause, steps, and the raw error', async () => {
      const r = await diagnostics.diagnoseError(
        { message: 'Cross account requests allowed to SUPER_ADMIN only', category: 'recorder', agentId: 'recorder' },
        { skipLLM: true, appVersion: '4.9.0' }
      );
      expect(r.copyable).toContain('GSX Power User');
      expect(r.copyable).toContain('App version: 4.9.0');
      expect(r.copyable).toContain('Category: recorder');
      expect(r.copyable).toContain('What happened');
      expect(r.copyable).toContain('Why');
      expect(r.copyable).toContain('Try this');
      expect(r.copyable).toContain('Raw error');
      expect(r.copyable).toContain('Cross account requests allowed to SUPER_ADMIN only');
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Input validation
  // ────────────────────────────────────────────────────────────────────────

  describe('input validation', () => {
    it('returns a no-op recommendation when no message is supplied', async () => {
      const r = await diagnostics.diagnoseError({ message: '' }, { skipLLM: true });
      expect(r.source).toBe('fallback');
      expect(r.summary).toMatch(/No error message/i);
    });

    it('handles missing errorContext entirely', async () => {
      const r = await diagnostics.diagnoseError(undefined, { skipLLM: true });
      expect(r.source).toBe('fallback');
    });
  });
});
