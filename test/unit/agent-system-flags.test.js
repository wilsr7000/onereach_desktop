/**
 * Agent System Feature Flags -- Unit Tests
 *
 * Verifies:
 *   - Every default flag is OFF so importing this module never changes
 *     baseline behavior.
 *   - Env-var override works for both enable ("1"/"true") and disable
 *     ("0"/"false").
 *   - settingsManager-backed flags override defaults.
 *   - The umbrella `agentSysV2` flag enables all other flags, but an
 *     explicit per-flag override wins over the umbrella.
 *   - `setAgentFlag` throws on unknown names and is a no-op without a
 *     settingsManager.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const {
  DEFAULT_FLAGS,
  isAgentFlagEnabled,
  setAgentFlag,
  getAllAgentFlags,
  getAgentFlagNames,
} = require('../../lib/agent-system-flags');

// These tests exercise the flag resolver under known env states, so we
// deliberately ignore anything the parent process set for
// AGENT_SYS_*. Clearing without restoring keeps each test deterministic
// regardless of how the runner was invoked (e.g. `npm test` vs
// `AGENT_SYS_AGENT_SYS_V2=1 npm test`).
const ORIGINAL_SETTINGS_MANAGER = global.settingsManager;

function _restoreEnv() {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('AGENT_SYS_')) delete process.env[key];
  }
}

beforeEach(() => {
  _restoreEnv();
  global.settingsManager = undefined;
});

afterEach(() => {
  _restoreEnv();
  global.settingsManager = ORIGINAL_SETTINGS_MANAGER;
});

describe('DEFAULT_FLAGS', () => {
  it('all defaults are on (Agent System v2 is the system)', () => {
    for (const [name, value] of Object.entries(DEFAULT_FLAGS)) {
      expect(value, `${name} should default to true`).toBe(true);
    }
  });

  it('includes one flag per phase and an umbrella', () => {
    const names = Object.keys(DEFAULT_FLAGS);
    // Umbrella + at least Phase 0..6 flags
    expect(names).toContain('agentSysV2');
    expect(names).toContain('typedTaskContract');
    expect(names).toContain('councilMode');
    expect(names).toContain('learnedWeights');
    expect(names).toContain('roleBasedVoterPool');
    expect(names).toContain('variantSelector');
    expect(names).toContain('perCriterionBidding');
    expect(names).toContain('bidTimeClarification');
    expect(names).toContain('adequacyLoop');
    expect(names).toContain('httpGateway');
  });

  it('DEFAULT_FLAGS is frozen', () => {
    expect(Object.isFrozen(DEFAULT_FLAGS)).toBe(true);
  });
});

describe('isAgentFlagEnabled', () => {
  it('returns false for unknown flag names', () => {
    expect(isAgentFlagEnabled('doesNotExist')).toBe(false);
  });

  it('reads env var override (enable) using UPPER_SNAKE', () => {
    process.env.AGENT_SYS_COUNCIL_MODE = '1';
    expect(isAgentFlagEnabled('councilMode')).toBe(true);
  });

  it("accepts 'true' in addition to '1'", () => {
    process.env.AGENT_SYS_LEARNED_WEIGHTS = 'true';
    expect(isAgentFlagEnabled('learnedWeights')).toBe(true);
  });

  it('explicit env disable overrides settingsManager', () => {
    global.settingsManager = {
      get: () => ({ councilMode: true }),
      set: () => {},
    };
    process.env.AGENT_SYS_COUNCIL_MODE = '0';
    expect(isAgentFlagEnabled('councilMode')).toBe(false);
  });

  it('reads from settingsManager when env is not set', () => {
    global.settingsManager = {
      get: (key) => (key === 'agentSystemFlags' ? { httpGateway: true } : null),
      set: () => {},
    };
    expect(isAgentFlagEnabled('httpGateway')).toBe(true);
  });

  it('settingsManager errors do not throw and fall through to the default', () => {
    global.settingsManager = {
      get: () => { throw new Error('boom'); },
      set: () => {},
    };
    expect(() => isAgentFlagEnabled('councilMode')).not.toThrow();
    // default for councilMode is true
    expect(isAgentFlagEnabled('councilMode')).toBe(true);
  });
});

describe('umbrella flag behavior', () => {
  it('phase flags are on by default (v4.9.0 default behavior)', () => {
    expect(isAgentFlagEnabled('typedTaskContract')).toBe(true);
    expect(isAgentFlagEnabled('councilMode')).toBe(true);
    expect(isAgentFlagEnabled('httpGateway')).toBe(true);
  });

  it('umbrella=off via env disables every phase flag', () => {
    process.env.AGENT_SYS_AGENT_SYS_V2 = '0';
    expect(isAgentFlagEnabled('typedTaskContract')).toBe(false);
    expect(isAgentFlagEnabled('councilMode')).toBe(false);
    expect(isAgentFlagEnabled('learnedWeights')).toBe(false);
    expect(isAgentFlagEnabled('httpGateway')).toBe(false);
  });

  it('umbrella=off via settings disables every phase flag', () => {
    global.settingsManager = {
      get: (key) => (key === 'agentSystemFlags' ? { agentSysV2: false } : null),
      set: () => {},
    };
    expect(isAgentFlagEnabled('typedTaskContract')).toBe(false);
    expect(isAgentFlagEnabled('councilMode')).toBe(false);
  });

  it('explicit per-flag env wins over umbrella-off', () => {
    process.env.AGENT_SYS_AGENT_SYS_V2 = '0';
    process.env.AGENT_SYS_COUNCIL_MODE = '1';
    // Umbrella off, but council explicitly on -> on
    expect(isAgentFlagEnabled('councilMode')).toBe(true);
    // Others still disabled via umbrella
    expect(isAgentFlagEnabled('learnedWeights')).toBe(false);
  });

  it('explicit per-flag setting wins over umbrella-off', () => {
    global.settingsManager = {
      get: (key) => (
        key === 'agentSystemFlags'
          ? { agentSysV2: false, councilMode: true }
          : null
      ),
      set: () => {},
    };
    expect(isAgentFlagEnabled('councilMode')).toBe(true);
    expect(isAgentFlagEnabled('learnedWeights')).toBe(false);
  });

  it('agentSysV2 itself is evaluated normally (no recursion)', () => {
    expect(isAgentFlagEnabled('agentSysV2')).toBe(true);
    process.env.AGENT_SYS_AGENT_SYS_V2 = '0';
    expect(isAgentFlagEnabled('agentSysV2')).toBe(false);
    delete process.env.AGENT_SYS_AGENT_SYS_V2;
    expect(isAgentFlagEnabled('agentSysV2')).toBe(true);
  });
});

describe('setAgentFlag', () => {
  it('throws on unknown flag name', () => {
    expect(() => setAgentFlag('unknownFlag', true)).toThrow(/Unknown agent-system flag/);
  });

  it('is a no-op (returns false) without settingsManager', () => {
    global.settingsManager = undefined;
    expect(setAgentFlag('councilMode', true)).toBe(false);
  });

  it('persists to settingsManager when available', () => {
    const store = {};
    global.settingsManager = {
      get: (key) => store[key],
      set: (key, value) => { store[key] = value; },
    };
    expect(setAgentFlag('councilMode', true)).toBe(true);
    expect(store.agentSystemFlags.councilMode).toBe(true);
  });

  it('merges with existing flags rather than replacing', () => {
    const store = { agentSystemFlags: { learnedWeights: true } };
    global.settingsManager = {
      get: (key) => store[key],
      set: (key, value) => { store[key] = value; },
    };
    setAgentFlag('councilMode', true);
    expect(store.agentSystemFlags.learnedWeights).toBe(true);
    expect(store.agentSystemFlags.councilMode).toBe(true);
  });
});

describe('getAllAgentFlags / getAgentFlagNames', () => {
  it('getAgentFlagNames matches DEFAULT_FLAGS keys', () => {
    expect(getAgentFlagNames().sort()).toEqual(Object.keys(DEFAULT_FLAGS).sort());
  });

  it('getAllAgentFlags returns a boolean for every flag', () => {
    const snapshot = getAllAgentFlags();
    for (const name of Object.keys(DEFAULT_FLAGS)) {
      expect(typeof snapshot[name]).toBe('boolean');
    }
  });
});
