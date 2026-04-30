/**
 * Naturalness Flags - Unit Tests
 *
 * Verifies the env var / settingsManager / default-value resolution
 * order for naturalness feature flags.
 *
 * Run:  npx vitest run test/unit/naturalness-flags.test.js
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const flagsModule = require('../../lib/naturalness-flags');
const { isFlagEnabled, setFlag, getAllFlags, getFlagNames, DEFAULT_FLAGS } = flagsModule;

const FLAG_ENV_VARS = getFlagNames().map(
  (name) => `NATURAL_${name.replace(/([A-Z])/g, '_$1').toUpperCase()}`
);

describe('naturalness-flags', () => {
  let originalSettingsManager;

  beforeEach(() => {
    originalSettingsManager = global.settingsManager;
    global.settingsManager = undefined;
    for (const env of FLAG_ENV_VARS) {
      delete process.env[env];
    }
  });

  afterEach(() => {
    global.settingsManager = originalSettingsManager;
    for (const env of FLAG_ENV_VARS) {
      delete process.env[env];
    }
  });

  describe('default values', () => {
    it('each declared flag resolves to its DEFAULT_FLAGS value', () => {
      for (const name of getFlagNames()) {
        expect(isFlagEnabled(name)).toBe(DEFAULT_FLAGS[name]);
      }
    });

    it('repairMemory defaults to true (always-on after safety cutover)', () => {
      expect(DEFAULT_FLAGS.repairMemory).toBe(true);
      expect(isFlagEnabled('repairMemory')).toBe(true);
    });

    it('Phase 6 affectMatching defaults to true (always-on after cutover)', () => {
      expect(DEFAULT_FLAGS.affectMatching).toBe(true);
      expect(isFlagEnabled('affectMatching')).toBe(true);
    });

    it('Phase 7 backchanneling defaults to false (not yet designed)', () => {
      expect(DEFAULT_FLAGS.backchanneling).toBe(false);
      expect(isFlagEnabled('backchanneling')).toBe(false);
    });

    it('unknown flags return false without throwing', () => {
      expect(isFlagEnabled('nonexistentFlag')).toBe(false);
    });

    it('DEFAULT_FLAGS is frozen so phases cannot mutate it accidentally', () => {
      expect(Object.isFrozen(DEFAULT_FLAGS)).toBe(true);
    });
  });

  describe('environment variable override', () => {
    it('NATURAL_REPAIR_MEMORY=1 enables repairMemory', () => {
      process.env.NATURAL_REPAIR_MEMORY = '1';
      expect(isFlagEnabled('repairMemory')).toBe(true);
    });

    it('accepts "true" in addition to "1"', () => {
      process.env.NATURAL_AFFECT_MATCHING = 'true';
      expect(isFlagEnabled('affectMatching')).toBe(true);
    });

    it('accepts "0" / "false" to explicitly disable', () => {
      process.env.NATURAL_REPAIR_MEMORY = '0';
      expect(isFlagEnabled('repairMemory')).toBe(false);
      process.env.NATURAL_REPAIR_MEMORY = 'false';
      expect(isFlagEnabled('repairMemory')).toBe(false);
    });

    it('env var overrides settingsManager', () => {
      global.settingsManager = makeMockSettingsManager({
        naturalnessFlags: { repairMemory: true },
      });
      process.env.NATURAL_REPAIR_MEMORY = '0';
      expect(isFlagEnabled('repairMemory')).toBe(false);
    });
  });

  describe('settingsManager source', () => {
    it('reads from settingsManager when no env override', () => {
      global.settingsManager = makeMockSettingsManager({
        naturalnessFlags: { repairMemory: true },
      });
      expect(isFlagEnabled('repairMemory')).toBe(true);
    });

    it('settingsManager throwing does not crash isFlagEnabled (falls back to DEFAULT_FLAGS)', () => {
      global.settingsManager = {
        get: () => {
          throw new Error('settings corrupt');
        },
      };
      // Graceful fallback returns the hard-coded default; for
      // backchanneling this is false.
      expect(isFlagEnabled('backchanneling')).toBe(false);
    });

    it('settingsManager returning unrelated keys falls back to DEFAULT_FLAGS', () => {
      global.settingsManager = makeMockSettingsManager({ otherStuff: 1 });
      expect(isFlagEnabled('backchanneling')).toBe(false);
    });
  });

  describe('setFlag', () => {
    it('returns false and does not throw when no settingsManager is present', () => {
      expect(setFlag('repairMemory', true)).toBe(false);
    });

    it('writes to settingsManager when available', () => {
      const store = { naturalnessFlags: {} };
      global.settingsManager = makeMockSettingsManager(store);
      expect(setFlag('repairMemory', true)).toBe(true);
      expect(store.naturalnessFlags.repairMemory).toBe(true);
      expect(isFlagEnabled('repairMemory')).toBe(true);
    });

    it('rejects unknown flag names', () => {
      expect(() => setFlag('notARealFlag', true)).toThrow(/unknown/i);
    });

    it('coerces value to boolean', () => {
      const store = { naturalnessFlags: {} };
      global.settingsManager = makeMockSettingsManager(store);
      setFlag('repairMemory', 1);
      expect(store.naturalnessFlags.repairMemory).toBe(true);
      setFlag('repairMemory', '');
      expect(store.naturalnessFlags.repairMemory).toBe(false);
    });
  });

  describe('getAllFlags', () => {
    it('returns every known flag with its effective value', () => {
      process.env.NATURAL_BACKCHANNELING = '1';
      const snapshot = getAllFlags();
      expect(Object.keys(snapshot).sort()).toEqual(getFlagNames().sort());
      expect(snapshot.repairMemory).toBe(true);
      expect(snapshot.affectMatching).toBe(true);
      expect(snapshot.backchanneling).toBe(true);
    });
  });
});

function makeMockSettingsManager(store) {
  return {
    get: (key) => store[key],
    set: (key, value) => {
      store[key] = value;
    },
  };
}
