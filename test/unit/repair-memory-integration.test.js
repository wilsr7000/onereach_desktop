/**
 * Repair Memory Integration Smoke Test
 *
 * Covers:
 *   - The shared singleton (configure / reset / load+save lifecycle).
 *   - The voice-listener slice that applies fixes on transcription.completed.
 *   - The exchange-bridge slice that detects corrections + learns.
 *
 * Does NOT load voice-listener or exchange-bridge directly (Electron
 * deps); mirrors the integration patterns in-test with the real
 * modules.
 *
 * Run:  npx vitest run test/unit/repair-memory-integration.test.js
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const {
  getSharedRepairMemory,
  configureRepairMemory,
  resetSharedRepairMemory,
  ensureLoaded,
} = require('../../lib/naturalness/repair-memory-singleton');
const {
  detectCorrection,
  detectUndoCorrection,
} = require('../../lib/naturalness/correction-detector');

function makeSpacesMock(initialContents = null) {
  let contents = initialContents;
  return {
    files: {
      async read(_scope, _name) {
        return contents;
      },
      async write(_scope, _name, body) {
        contents = body;
        return true;
      },
      async delete() {
        contents = null;
        return true;
      },
    },
    _getContents: () => contents,
  };
}

describe('repair-memory-singleton', () => {
  beforeEach(() => {
    resetSharedRepairMemory();
    for (const k of Object.keys(process.env).filter((k) => k.startsWith('NATURAL_'))) {
      delete process.env[k];
    }
  });

  afterEach(() => {
    resetSharedRepairMemory();
    for (const k of Object.keys(process.env).filter((k) => k.startsWith('NATURAL_'))) {
      delete process.env[k];
    }
  });

  describe('flag gating', () => {
    it('returns an inert instance when the flag is explicitly off', () => {
      process.env.NATURAL_REPAIR_MEMORY = '0';
      const rm = getSharedRepairMemory();
      const r = rm.applyFixes('anything');
      expect(r.appliedCount).toBe(0);
      const learn = rm.learnFix('jess', 'jazz');
      expect(learn.added).toBe(false);
      expect(learn.reason).toBe('flag-off');
      const undo = rm.unlearnLast();
      expect(undo.removed).toBe(false);
      expect(undo.reason).toBe('flag-off');
    });

    it('returns a real instance when the flag is on (default)', () => {
      configureRepairMemory({ spaces: makeSpacesMock() });
      const rm = getSharedRepairMemory();
      const learn = rm.learnFix('jess', 'jazz');
      expect(learn.added).toBe(true);
      expect(rm.size()).toBe(1);
    });
  });

  describe('flag on', () => {
    beforeEach(() => {
      process.env.NATURAL_REPAIR_MEMORY = '1';
    });

    it('returns the same instance across calls', () => {
      configureRepairMemory({ spaces: makeSpacesMock() });
      const a = getSharedRepairMemory();
      const b = getSharedRepairMemory();
      expect(a).toBe(b);
    });

    it('learns a fix and persists to Spaces automatically', async () => {
      const spaces = makeSpacesMock();
      configureRepairMemory({ spaces });
      const rm = getSharedRepairMemory();
      rm.learnFix('jess', 'jazz');
      // autosave is fire-and-forget; give it a tick.
      await new Promise((r) => setImmediate(r));
      expect(spaces._getContents()).toBeTruthy();
      const parsed = JSON.parse(spaces._getContents());
      expect(parsed.fixes).toHaveLength(1);
    });

    it('ensureLoaded pulls existing fixes from Spaces', async () => {
      const preload = JSON.stringify({
        version: 1,
        fixes: [{ heard: 'jess', meant: 'jazz', hits: 3, lastHit: 1 }],
      });
      const spaces = makeSpacesMock(preload);
      configureRepairMemory({ spaces });
      await ensureLoaded();
      const rm = getSharedRepairMemory();
      expect(rm.size()).toBe(1);
      const r = rm.applyFixes('play some jess now');
      expect(r.text).toBe('play some jazz now');
    });
  });
});

describe('voice-listener slice: apply fixes on transcription.completed', () => {
  beforeEach(() => {
    resetSharedRepairMemory();
    process.env.NATURAL_REPAIR_MEMORY = '1';
  });
  afterEach(() => {
    resetSharedRepairMemory();
    delete process.env.NATURAL_REPAIR_MEMORY;
  });

  it('rewrites the transcript before broadcast', () => {
    const spaces = makeSpacesMock();
    configureRepairMemory({ spaces });
    const rm = getSharedRepairMemory();
    rm.learnFix('jess', 'jazz');

    // Mirror of the voice-listener transcription.completed slice.
    const rawTranscript = 'play some jess for me';
    const fixed = rm.applyFixes(rawTranscript);
    expect(fixed.text).toBe('play some jazz for me');
    expect(fixed.appliedCount).toBe(1);
  });

  it('passes through unmodified when no fix matches', () => {
    const spaces = makeSpacesMock();
    configureRepairMemory({ spaces });
    const rm = getSharedRepairMemory();
    rm.learnFix('jess', 'jazz');

    const fixed = rm.applyFixes('what time is it');
    expect(fixed.text).toBe('what time is it');
    expect(fixed.appliedCount).toBe(0);
  });
});

describe('exchange-bridge slice: detect + learn corrections', () => {
  beforeEach(() => {
    resetSharedRepairMemory();
    process.env.NATURAL_REPAIR_MEMORY = '1';
  });
  afterEach(() => {
    resetSharedRepairMemory();
    delete process.env.NATURAL_REPAIR_MEMORY;
  });

  // Minimal mirror of the processSubmit slice that detects and learns.
  function simulate({ text, priorUser }) {
    const correction = detectCorrection(text, priorUser);
    if (correction) {
      const rm = getSharedRepairMemory();
      rm.learnFix(correction.heard, correction.meant);
    }
    return { correction };
  }

  it('"I meant jazz" after prior "play jess" learns jess -> jazz', async () => {
    const spaces = makeSpacesMock();
    configureRepairMemory({ spaces });
    const rm = getSharedRepairMemory();
    expect(rm.size()).toBe(0);

    const r = simulate({ text: 'I meant jazz', priorUser: 'play jess' });
    expect(r.correction).toMatchObject({ heard: 'jess', meant: 'jazz' });
    expect(rm.size()).toBe(1);

    // Next turn, a transcription containing "jess" gets rewritten.
    const fixed = rm.applyFixes('play jess now');
    expect(fixed.text).toBe('play jazz now');
  });

  it('"I said jazz not jess" learns the fix without needing priorUser', () => {
    configureRepairMemory({ spaces: makeSpacesMock() });
    const rm = getSharedRepairMemory();
    const r = simulate({ text: 'I said jazz not jess', priorUser: '' });
    expect(r.correction).toMatchObject({ heard: 'jess', meant: 'jazz' });
    expect(rm.size()).toBe(1);
  });

  it('non-correction utterance does not learn anything', () => {
    configureRepairMemory({ spaces: makeSpacesMock() });
    const rm = getSharedRepairMemory();
    simulate({ text: 'what time is it', priorUser: 'play jess' });
    expect(rm.size()).toBe(0);
  });

  it('full loop: learn via correction, then apply on next transcription', async () => {
    const spaces = makeSpacesMock();
    configureRepairMemory({ spaces });
    const rm = getSharedRepairMemory();

    // Turn 1: user says "play jess", misheard as "play jess".
    //         Correction NOT triggered on this turn.
    simulate({ text: 'play jess', priorUser: '' });
    expect(rm.size()).toBe(0);

    // Turn 2: user says "I meant jazz".
    simulate({ text: 'I meant jazz', priorUser: 'play jess' });
    expect(rm.size()).toBe(1);

    // Wait for autosave.
    await new Promise((r) => setImmediate(r));
    expect(spaces._getContents()).toBeTruthy();

    // Turn 3: user says "play jess" again. Voice-listener slice
    // applies the fix before the transcript hits the pipeline.
    const raw = 'play jess now please';
    const fixed = rm.applyFixes(raw);
    expect(fixed.text).toBe('play jazz now please');
  });
});

// ================================================================
// Undo + cycle detection integration
// ================================================================

describe('exchange-bridge slice: undo intent short-circuits learn', () => {
  beforeEach(() => {
    resetSharedRepairMemory();
    process.env.NATURAL_REPAIR_MEMORY = '1';
  });
  afterEach(() => {
    resetSharedRepairMemory();
    delete process.env.NATURAL_REPAIR_MEMORY;
  });

  /** Mirror of the Phase 5 slice in exchange-bridge.processSubmit. */
  function simulate({ text, priorUser }) {
    const undo = detectUndoCorrection(text);
    if (undo) {
      const rm = getSharedRepairMemory();
      const result = rm.unlearnLast();
      return { handled: true, undo, result };
    }
    const correction = detectCorrection(text, priorUser);
    if (correction) {
      const rm = getSharedRepairMemory();
      rm.learnFix(correction.heard, correction.meant);
      return { handled: false, correction };
    }
    return { handled: false };
  }

  it('learn -> undo removes the most recent fix', () => {
    const spaces = makeSpacesMock();
    configureRepairMemory({ spaces });
    const rm = getSharedRepairMemory();

    simulate({ text: 'I meant jazz', priorUser: 'play jess' });
    expect(rm.size()).toBe(1);

    const out = simulate({ text: 'forget that fix', priorUser: '' });
    expect(out.handled).toBe(true);
    expect(out.result.removed).toBe(true);
    expect(rm.size()).toBe(0);
  });

  it('undo with no prior learn returns removed=false but still handles', () => {
    configureRepairMemory({ spaces: makeSpacesMock() });
    const out = simulate({ text: 'forget that fix', priorUser: '' });
    expect(out.handled).toBe(true);
    expect(out.result.removed).toBe(false);
  });

  it('learn -> cycle-undo via a reverse learn removes the original fix', () => {
    configureRepairMemory({ spaces: makeSpacesMock() });
    const rm = getSharedRepairMemory();

    // First learn: wrong direction.
    simulate({ text: 'I meant jazz', priorUser: 'play jess' });
    expect(rm.size()).toBe(1);

    // User realizes the auto-fix is wrong and says it the other way.
    // The learn attempt detects the inverse and removes it.
    simulate({ text: 'I meant jess', priorUser: 'play jazz' });
    expect(rm.size()).toBe(0);
  });

  it('undo persists the removal to Spaces via autosave', async () => {
    const spaces = makeSpacesMock();
    configureRepairMemory({ spaces });

    simulate({ text: 'I meant jazz', priorUser: 'play jess' });
    await new Promise((r) => setImmediate(r));

    simulate({ text: 'forget that fix', priorUser: '' });
    await new Promise((r) => setImmediate(r));

    const parsed = JSON.parse(spaces._getContents());
    expect(parsed.fixes).toHaveLength(0);
  });

  it('undo phrasing does NOT leak into learn detection', () => {
    configureRepairMemory({ spaces: makeSpacesMock() });
    const rm = getSharedRepairMemory();
    const out = simulate({ text: 'forget that fix', priorUser: 'play jess' });
    // Short-circuits as undo, does not try to learn.
    expect(out.handled).toBe(true);
    expect(rm.size()).toBe(0);
  });
});
