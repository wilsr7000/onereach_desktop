/**
 * Unit tests for AppManagerAgent._generateActivitySummary
 *
 * Confirms the three idle-spend guards added on 2026-04-26:
 *   1. Master enabled flag (default OFF). When disabled, no LLM call ever.
 *   2. Min-interval throttle. Same activity inside the window is silenced.
 *   3. Activity-hash dedup. Identical payload after the throttle window
 *      still skips the call (no point summarizing the same state twice).
 *
 * The fix replaced an unconditional Sonnet call every 30s (~$1.50-2/day
 * of pure idle drain) with these guards + a switch to the 'fast' Haiku
 * profile when the feature is opted in.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mute the log queue and stub the AI service so test runs are deterministic.
vi.mock('../../lib/log-event-queue', () => ({
  getLogQueue: () => ({ info: () => {}, warn: () => {}, error: () => {} }),
}));

const aiCompleteSpy = vi.fn();

// Settings manager: in-memory map so tests can flip flags freely.
const settingsStore = new Map();
const fakeSettingsManager = {
  get: (k) => (settingsStore.has(k) ? settingsStore.get(k) : undefined),
  set: (k, v) => settingsStore.set(k, v),
};

const {
  AppManagerAgent,
  _setAiServiceForTesting,
  _setSettingsManagerForTesting,
} = require('../../app-manager-agent');

// Inject the AI spy + the in-memory settings store as the dependencies the
// SUT uses, bypassing the CJS-require-doesn't-intercept issue.
_setAiServiceForTesting({
  complete: (...args) => aiCompleteSpy(...args),
});
_setSettingsManagerForTesting(fakeSettingsManager);

/**
 * Bypass the constructor (which touches Electron's `app.getPath` and the
 * filesystem). We're only exercising _generateActivitySummary + _hashString,
 * which don't read any of those constructor-initialised fields. Object.create
 * lets us instantiate without running the constructor.
 */
function makeAgent() {
  const agent = Object.create(AppManagerAgent.prototype);
  agent._lastAISummaryAt = 0;
  agent._lastAISummaryHash = null;
  agent._broadcastHUD = () => {}; // suppress HUD broadcasts
  return agent;
}

function setEnabled(enabled) {
  settingsStore.set('appManagerAgent.aiSummary.enabled', enabled);
}

function setApiKey(key = 'sk-test') {
  settingsStore.set('anthropicApiKey', key);
}

const SAMPLE_SCAN_RESULT = { fixed: 1, failed: 0, errors: [] };

// _collectActivityContext returns a synthesized object; the real
// implementation reads from this.* state. We override it inline per test
// so we can drive the dedup hash deterministically.
function stubContext(agent, payload) {
  agent._collectActivityContext = () => payload;
}

describe('AppManagerAgent _generateActivitySummary -- idle-spend guards', () => {
  beforeEach(() => {
    aiCompleteSpy.mockReset();
    aiCompleteSpy.mockResolvedValue('Scan complete, all systems healthy');
    settingsStore.clear();
    setApiKey('sk-test');
  });

  // ──────────────────────────────────────────────────────────────────────
  // Guard 1: master enabled flag
  // ──────────────────────────────────────────────────────────────────────

  describe('master enabled flag', () => {
    it('skips the LLM call entirely when the setting is unset (default OFF)', async () => {
      const agent = makeAgent();
      stubContext(agent, { hasActivity: true, appState: 'a', activity: 'b' });
      await agent._generateActivitySummary(SAMPLE_SCAN_RESULT);
      expect(aiCompleteSpy).not.toHaveBeenCalled();
    });

    it('skips the LLM call when the setting is explicitly false', async () => {
      const agent = makeAgent();
      setEnabled(false);
      stubContext(agent, { hasActivity: true, appState: 'a', activity: 'b' });
      await agent._generateActivitySummary(SAMPLE_SCAN_RESULT);
      expect(aiCompleteSpy).not.toHaveBeenCalled();
    });

    it('proceeds to the LLM call when the setting is true and other guards permit', async () => {
      const agent = makeAgent();
      setEnabled(true);
      stubContext(agent, { hasActivity: true, appState: 'a', activity: 'b' });
      await agent._generateActivitySummary(SAMPLE_SCAN_RESULT);
      expect(aiCompleteSpy).toHaveBeenCalledTimes(1);
      const call = aiCompleteSpy.mock.calls[0];
      // Profile should be 'fast' (Haiku), not 'standard' (Sonnet).
      expect(call[1].profile).toBe('fast');
      expect(call[1].feature).toBe('app-manager-agent');
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Guard 2: min-interval throttle
  // ──────────────────────────────────────────────────────────────────────

  describe('min-interval throttle', () => {
    it('skips a second call inside the throttle window even when activity changed', async () => {
      const agent = makeAgent();
      setEnabled(true);

      stubContext(agent, { hasActivity: true, appState: 'a', activity: 'b' });
      await agent._generateActivitySummary(SAMPLE_SCAN_RESULT);
      expect(aiCompleteSpy).toHaveBeenCalledTimes(1);

      // Fire again with a CHANGED payload but inside the window: throttle wins.
      stubContext(agent, { hasActivity: true, appState: 'a-changed', activity: 'b-changed' });
      await agent._generateActivitySummary(SAMPLE_SCAN_RESULT);
      expect(aiCompleteSpy).toHaveBeenCalledTimes(1);
    });

    it('allows a second call once the throttle window has elapsed', async () => {
      const agent = makeAgent();
      setEnabled(true);
      // Tighten the throttle so the test doesn't have to wait 5 minutes.
      settingsStore.set('appManagerAgent.aiSummary.minIntervalMs', 1);

      stubContext(agent, { hasActivity: true, appState: 'a', activity: 'b' });
      await agent._generateActivitySummary(SAMPLE_SCAN_RESULT);

      await new Promise((r) => setTimeout(r, 5));

      stubContext(agent, { hasActivity: true, appState: 'a2', activity: 'b2' });
      await agent._generateActivitySummary(SAMPLE_SCAN_RESULT);
      expect(aiCompleteSpy).toHaveBeenCalledTimes(2);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Guard 3: activity-hash dedup
  // ──────────────────────────────────────────────────────────────────────

  describe('activity-hash dedup', () => {
    it('skips the LLM call when the activity payload is byte-identical', async () => {
      const agent = makeAgent();
      setEnabled(true);
      // Throttle out of the way so we're isolating the dedup.
      settingsStore.set('appManagerAgent.aiSummary.minIntervalMs', 0);

      stubContext(agent, { hasActivity: true, appState: 'identical', activity: 'identical' });
      await agent._generateActivitySummary(SAMPLE_SCAN_RESULT);
      expect(aiCompleteSpy).toHaveBeenCalledTimes(1);

      await new Promise((r) => setTimeout(r, 2));
      // Same payload -> same hash -> skip.
      stubContext(agent, { hasActivity: true, appState: 'identical', activity: 'identical' });
      await agent._generateActivitySummary(SAMPLE_SCAN_RESULT);
      expect(aiCompleteSpy).toHaveBeenCalledTimes(1);
    });

    it('fires when the payload changes after the throttle window', async () => {
      const agent = makeAgent();
      setEnabled(true);
      settingsStore.set('appManagerAgent.aiSummary.minIntervalMs', 0);

      stubContext(agent, { hasActivity: true, appState: 'one', activity: 'two' });
      await agent._generateActivitySummary(SAMPLE_SCAN_RESULT);

      await new Promise((r) => setTimeout(r, 2));
      stubContext(agent, { hasActivity: true, appState: 'three', activity: 'four' });
      await agent._generateActivitySummary(SAMPLE_SCAN_RESULT);
      expect(aiCompleteSpy).toHaveBeenCalledTimes(2);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // hasActivity early-exit (predates this fix; keep it covered)
  // ──────────────────────────────────────────────────────────────────────

  it('skips when hasActivity is false even with the flag on', async () => {
    const agent = makeAgent();
    setEnabled(true);
    stubContext(agent, { hasActivity: false, appState: 'whatever', activity: 'whatever' });
    await agent._generateActivitySummary(SAMPLE_SCAN_RESULT);
    expect(aiCompleteSpy).not.toHaveBeenCalled();
  });

  // ──────────────────────────────────────────────────────────────────────
  // Missing API key
  // ──────────────────────────────────────────────────────────────────────

  it('skips when no API key is configured even with the flag on', async () => {
    const agent = makeAgent();
    setEnabled(true);
    settingsStore.delete('anthropicApiKey');
    stubContext(agent, { hasActivity: true, appState: 'a', activity: 'b' });
    await agent._generateActivitySummary(SAMPLE_SCAN_RESULT);
    expect(aiCompleteSpy).not.toHaveBeenCalled();
  });

  // ──────────────────────────────────────────────────────────────────────
  // _hashString sanity
  // ──────────────────────────────────────────────────────────────────────

  describe('_hashString', () => {
    it('returns identical hashes for identical input', () => {
      const agent = makeAgent();
      expect(agent._hashString('hello world')).toBe(agent._hashString('hello world'));
    });

    it('returns different hashes for different input', () => {
      const agent = makeAgent();
      expect(agent._hashString('a')).not.toBe(agent._hashString('b'));
    });

    it('handles empty / null safely', () => {
      const agent = makeAgent();
      expect(typeof agent._hashString('')).toBe('number');
      expect(typeof agent._hashString(null)).toBe('number');
      expect(typeof agent._hashString(undefined)).toBe('number');
    });
  });
});
