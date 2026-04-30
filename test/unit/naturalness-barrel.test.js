/**
 * Naturalness Barrel - External Consumer Integration Test
 *
 * Simulates how a non-Electron product (e.g. WISER Playbooks, a
 * headless CLI, a GSX-hosted flow) would wire up the naturalness
 * layer using ONLY the public barrel. Deep imports into the
 * per-phase files are deliberately NOT used here -- if this file
 * breaks after a refactor, the public API broke.
 *
 * Run:  npx vitest run test/unit/naturalness-barrel.test.js
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// The ONLY import an external consumer should need.
const naturalness = require('../../lib/naturalness');

// -----------------------------------------------------------
// Port mocks
// -----------------------------------------------------------

function makeMockSpaces(initial = null) {
  let contents = initial;
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

function makeMockSpeaker() {
  return {
    speak: vi.fn().mockResolvedValue(true),
    cancel: vi.fn().mockResolvedValue(true),
  };
}

function makeMockLog() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

// -----------------------------------------------------------
// Tests
// -----------------------------------------------------------

describe('naturalness barrel: shape', () => {
  it('exports createNaturalness', () => {
    expect(typeof naturalness.createNaturalness).toBe('function');
  });

  it('exports every phase namespace', () => {
    // Phase 1
    expect(naturalness.confirmationGate.evaluateConfirmationGate).toBeTypeOf('function');
    expect(naturalness.stakesClassifier.classifyStakes).toBeTypeOf('function');
    expect(naturalness.confirmationPolicy.decide).toBeTypeOf('function');
    expect(naturalness.confirmationPhrases.phraseForDecision).toBeTypeOf('function');

    // Phase 2
    expect(naturalness.voiceResolver.resolveVoice).toBeTypeOf('function');
    expect(naturalness.handoffPhrases.buildHandoffPhrase).toBeTypeOf('function');

    // Phase 3
    expect(naturalness.turnTaking.heuristicClassify).toBeTypeOf('function');
    expect(naturalness.pauseDetector.createPauseDetector).toBeTypeOf('function');
    expect(naturalness.utteranceClassifier.createUtteranceClassifier).toBeTypeOf('function');

    // Phase 4
    expect(naturalness.echoFilter.isLikelyEcho).toBeTypeOf('function');
    expect(naturalness.bargeClassifier.classifyBarge).toBeTypeOf('function');
    expect(naturalness.bargeDetector.createBargeDetector).toBeTypeOf('function');
    expect(naturalness.bargeDetectorSingleton.getSharedBargeDetector).toBeTypeOf('function');

    // Phase 5
    expect(naturalness.repairMemory.createRepairMemory).toBeTypeOf('function');
    expect(naturalness.correctionDetector.detectCorrection).toBeTypeOf('function');
    expect(naturalness.correctionDetector.detectUndoCorrection).toBeTypeOf('function');
    expect(naturalness.repairMemorySingleton.getSharedRepairMemory).toBeTypeOf('function');

    // Phase 6
    expect(naturalness.affectClassifier.classifyAffect).toBeTypeOf('function');
    expect(naturalness.responseModifier.adjustResponse).toBeTypeOf('function');
    expect(naturalness.affectTracker.getSharedAffectTracker).toBeTypeOf('function');

    // Flags
    expect(naturalness.flags.isFlagEnabled).toBeTypeOf('function');
  });
});

describe('createNaturalness: zero ports (pure primitive use)', () => {
  let nat;
  beforeEach(() => {
    naturalness.repairMemorySingleton.resetSharedRepairMemory();
    naturalness.affectTracker.resetSharedAffectTracker();
    naturalness.bargeDetectorSingleton.resetSharedBargeDetector();
    nat = naturalness.createNaturalness();
  });
  afterEach(() => {
    naturalness.repairMemorySingleton.resetSharedRepairMemory();
    naturalness.affectTracker.resetSharedAffectTracker();
    naturalness.bargeDetectorSingleton.resetSharedBargeDetector();
  });

  it('onTranscriptFinal with no fixes is a pass-through', () => {
    const r = nat.onTranscriptFinal('play some jazz');
    expect(r.text).toBe('play some jazz');
    expect(r.appliedCount).toBe(0);
  });

  it('onBeforeSpeak with no affect is a pass-through', () => {
    const r = nat.onBeforeSpeak("OK, so let me check your account");
    expect(r.modified).toBe(false);
    expect(r.text).toBe("OK, so let me check your account");
  });

  it('onUserTask returns handled=false for a normal utterance', async () => {
    const r = await nat.onUserTask('what time is it');
    expect(r.handled).toBe(false);
  });

  it('onTtsLifecycle + onUserPartial do not throw without a speaker port', () => {
    expect(() => nat.onTtsLifecycle('start', 'hello')).not.toThrow();
    expect(() => nat.onTtsLifecycle('end')).not.toThrow();
    expect(() => nat.onUserPartial('stop')).not.toThrow();
  });

  it('stores are reachable for introspection', () => {
    expect(nat.stores.repair).toBe(naturalness.repairMemorySingleton);
    expect(nat.stores.affect).toBe(naturalness.affectTracker);
    expect(nat.stores.barge).toBe(naturalness.bargeDetectorSingleton);
  });
});

describe('createNaturalness: full wiring (speaker + spaces + log + history)', () => {
  let spaces;
  let speaker;
  let log;
  let history;
  let nat;

  beforeEach(() => {
    naturalness.repairMemorySingleton.resetSharedRepairMemory();
    naturalness.affectTracker.resetSharedAffectTracker();
    naturalness.bargeDetectorSingleton.resetSharedBargeDetector();

    spaces = makeMockSpaces();
    speaker = makeMockSpeaker();
    log = makeMockLog();
    history = [];

    nat = naturalness.createNaturalness({
      ports: {
        spaces,
        speaker,
        log,
        getHistory: () => history,
      },
    });
  });

  afterEach(() => {
    naturalness.repairMemorySingleton.resetSharedRepairMemory();
    naturalness.affectTracker.resetSharedAffectTracker();
    naturalness.bargeDetectorSingleton.resetSharedBargeDetector();
  });

  it('full loop: learn -> apply -> speak adjusted -> undo', async () => {
    // Turn 1 - mishearing gets spoken by user verbatim (no fix yet).
    history.push({ role: 'user', content: 'play jess' });
    let r = await nat.onUserTask('play jess');
    expect(r.handled).toBe(false);

    // Turn 2 - user corrects. The facade should detect and learn.
    const learnOutcome = await nat.onUserTask('I meant jazz');
    expect(learnOutcome.correction).toMatchObject({ heard: 'jess', meant: 'jazz' });
    history.push({ role: 'user', content: 'I meant jazz' });

    // Wait for autosave.
    await new Promise((res) => setImmediate(res));
    expect(spaces._getContents()).toBeTruthy();

    // Turn 3 - next STT transcript containing "jess" gets rewritten.
    const fixed = nat.onTranscriptFinal('play jess for me');
    expect(fixed.text).toBe('play jazz for me');
    expect(fixed.appliedCount).toBe(1);

    // Undo path.
    const undoOutcome = await nat.onUserTask('forget that fix');
    expect(undoOutcome.handled).toBe(true);
    expect(undoOutcome.shortcut).toBe('undo');
    expect(speaker.speak).toHaveBeenCalledTimes(1);
    const [ackText, ackOpts] = speaker.speak.mock.calls[0];
    expect(ackText).toMatch(/forget that "jess" meant "jazz"/i);
    expect(ackOpts.skipAffectMatching).toBe(true);

    // After undo, transcripts are untouched again.
    const post = nat.onTranscriptFinal('play jess now');
    expect(post.appliedCount).toBe(0);
  });

  it('affect: frustration -> empathy prefix on next outgoing speech', async () => {
    await nat.onUserTask('ugh this is really broken seriously');
    const out = nat.onBeforeSpeak('OK, so let me check your account');
    expect(out.modified).toBe(true);
    // One of the empathy pool prefixes is chosen at runtime.
    expect(out.text).toMatch(/^(Got it|No problem|Right|On it) - /);
    expect(out.transforms).toContain('prepend-empathy');
  });

  it('affect: skipAffectMatching bypasses even when affect is set', async () => {
    await nat.onUserTask('yes! amazing! finally it works!');
    const out = nat.onBeforeSpeak('Your task completed', {
      skipAffectMatching: true,
    });
    expect(out.modified).toBe(false);
  });

  it('repair-memory undo via cycle detection: reverse learn deletes the original', async () => {
    history.push({ role: 'user', content: 'play jess' });
    await nat.onUserTask('I meant jazz');
    expect(nat.stores.repair.getSharedRepairMemory().size()).toBe(1);

    history.push({ role: 'user', content: 'play jazz' });
    await nat.onUserTask('I meant jess');
    expect(nat.stores.repair.getSharedRepairMemory().size()).toBe(0);
  });

  it('onConnect kicks off Spaces load', async () => {
    const prefilled = makeMockSpaces(
      JSON.stringify({
        version: 1,
        fixes: [{ heard: 'jess', meant: 'jazz', hits: 2, lastHit: 1 }],
      })
    );
    naturalness.repairMemorySingleton.resetSharedRepairMemory();
    const n2 = naturalness.createNaturalness({
      ports: { spaces: prefilled, log, getHistory: () => [] },
    });
    await n2.onConnect();
    const fixed = n2.onTranscriptFinal('play jess please');
    expect(fixed.text).toBe('play jazz please');
  });
});

describe('createNaturalness: barge wiring', () => {
  let speaker;
  let submitTask;
  let nat;

  beforeEach(() => {
    naturalness.bargeDetectorSingleton.resetSharedBargeDetector();
    speaker = makeMockSpeaker();
    submitTask = vi.fn().mockResolvedValue({ queued: true });
    nat = naturalness.createNaturalness({
      ports: { speaker, submitTask },
    });
  });
  afterEach(() => {
    naturalness.bargeDetectorSingleton.resetSharedBargeDetector();
  });

  it('full barge sequence: TTS start -> user "stop" -> speaker.cancel called', async () => {
    nat.onTtsLifecycle('start', 'playing some jazz for you now');
    nat.onUserPartial('stop');
    await new Promise((res) => setImmediate(res));
    expect(speaker.cancel).toHaveBeenCalledTimes(1);
    expect(submitTask).not.toHaveBeenCalled();
  });

  it('command interrupt submits the interrupt as a new task', async () => {
    nat.onTtsLifecycle('start', 'playing some jazz');
    nat.onUserPartial('what about tomorrow');
    await new Promise((res) => setImmediate(res));
    expect(speaker.cancel).toHaveBeenCalledTimes(1);
    expect(submitTask).toHaveBeenCalledTimes(1);
    const [text, opts] = submitTask.mock.calls[0];
    expect(text).toBe('what about tomorrow');
    expect(opts.metadata.barged).toBe(true);
  });

  it('onTtsLifecycle("end") resets state for next round', async () => {
    nat.onTtsLifecycle('start', 'playing jazz');
    nat.onTtsLifecycle('end');
    // Grace window + cooldown elapse.
    await new Promise((res) => setTimeout(res, 400));
    nat.onUserPartial('stop');
    await new Promise((res) => setImmediate(res));
    // No TTS currently playing -> no cancel.
    expect(speaker.cancel).not.toHaveBeenCalled();
  });
});

describe('createNaturalness: flag gating', () => {
  beforeEach(() => {
    naturalness.repairMemorySingleton.resetSharedRepairMemory();
    naturalness.affectTracker.resetSharedAffectTracker();
    for (const k of Object.keys(process.env).filter((x) => x.startsWith('NATURAL_'))) {
      delete process.env[k];
    }
  });
  afterEach(() => {
    naturalness.repairMemorySingleton.resetSharedRepairMemory();
    naturalness.affectTracker.resetSharedAffectTracker();
    for (const k of Object.keys(process.env).filter((x) => x.startsWith('NATURAL_'))) {
      delete process.env[k];
    }
  });

  it('repairMemory=off: onTranscriptFinal + onUserTask are noops', async () => {
    process.env.NATURAL_REPAIR_MEMORY = '0';
    const nat = naturalness.createNaturalness({
      ports: { spaces: makeMockSpaces(), log: makeMockLog() },
    });
    const r = nat.onTranscriptFinal('play jess');
    expect(r.appliedCount).toBe(0);

    const outcome = await nat.onUserTask('I meant jazz', {
      history: [{ role: 'user', content: 'play jess' }],
    });
    expect(outcome.correction).toBeUndefined();
  });

  it('affectMatching=off: onBeforeSpeak is a pass-through even with frustrated user', async () => {
    process.env.NATURAL_AFFECT_MATCHING = '0';
    const nat = naturalness.createNaturalness();
    await nat.onUserTask('ugh this is really broken seriously');
    const r = nat.onBeforeSpeak("OK, so let me check your account");
    expect(r.modified).toBe(false);
  });
});

describe('createNaturalness: defensive behavior', () => {
  beforeEach(() => {
    naturalness.repairMemorySingleton.resetSharedRepairMemory();
    naturalness.affectTracker.resetSharedAffectTracker();
    naturalness.bargeDetectorSingleton.resetSharedBargeDetector();
  });

  it('null / empty inputs never throw', async () => {
    const nat = naturalness.createNaturalness();
    expect(() => nat.onTranscriptFinal(null)).not.toThrow();
    expect(() => nat.onTranscriptFinal('')).not.toThrow();
    expect(() => nat.onBeforeSpeak(null)).not.toThrow();
    expect(() => nat.onBeforeSpeak('')).not.toThrow();
    expect(() => nat.onTtsLifecycle('unknown-phase')).not.toThrow();
    expect(() => nat.onUserPartial(null)).not.toThrow();
    await expect(nat.onUserTask('')).resolves.toEqual({ handled: false });
    await expect(nat.onUserTask(null)).resolves.toEqual({ handled: false });
  });

  it('log port is optional and silent log is default', () => {
    const nat = naturalness.createNaturalness({ ports: {} });
    expect(() => nat.onTranscriptFinal('hello')).not.toThrow();
  });
});
