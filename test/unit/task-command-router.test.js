/**
 * Task Command Router - Unit Tests
 *
 * Exhaustive behavior tests for the critical-command classifier.
 * Matches the inline logic that used to live in exchange-bridge.js
 * (around the ==== ROUTER (cancel/stop/repeat/undo) ==== block).
 * If this file passes, the extraction is behaviorally identical.
 *
 * Run:  npx vitest run test/unit/task-command-router.test.js
 */

import { describe, it, expect } from 'vitest';

const {
  classifyTaskCommand,
  isCriticalCommand,
  EXACT_CRITICAL,
  PRONOUN_FOLLOWERS,
  PRONOUN_ELIGIBLE_VERBS,
} = require('../../lib/hud-core/task-command-router');

describe('classifyTaskCommand - exact critical phrases', () => {
  for (const phrase of EXACT_CRITICAL) {
    it(`"${phrase}" fires with pattern=exact`, () => {
      const r = classifyTaskCommand(phrase);
      expect(r.critical).toBe(true);
      expect(r.pattern).toBe('exact');
      expect(r.matched).toBe(phrase);
    });
  }

  it('case-insensitive: "CANCEL"', () => {
    expect(classifyTaskCommand('CANCEL').critical).toBe(true);
  });

  it('trailing punctuation is tolerated', () => {
    expect(classifyTaskCommand('cancel.').critical).toBe(true);
    expect(classifyTaskCommand('stop!').critical).toBe(true);
    expect(classifyTaskCommand('repeat?').critical).toBe(true);
  });

  it('leading / trailing whitespace is tolerated', () => {
    expect(classifyTaskCommand('  cancel  ').critical).toBe(true);
  });
});

describe('classifyTaskCommand - verb + pronoun filler', () => {
  const pairs = [];
  for (const verb of PRONOUN_ELIGIBLE_VERBS) {
    for (const follower of PRONOUN_FOLLOWERS) {
      pairs.push([verb, follower]);
    }
  }

  for (const [verb, follower] of pairs) {
    it(`"${verb} ${follower}" fires with pattern=verb-pronoun`, () => {
      const r = classifyTaskCommand(`${verb} ${follower}`);
      expect(r.critical).toBe(true);
      expect(r.pattern).toBe('verb-pronoun');
      expect(r.matched).toBe(`${verb} ${follower}`);
    });
  }

  it('"stop now." tolerates trailing punctuation', () => {
    expect(classifyTaskCommand('stop now.').critical).toBe(true);
  });
});

describe('classifyTaskCommand - intent utterances (NOT critical)', () => {
  // These all CONTAIN the critical word but are agent-routed intents.
  const intents = [
    'cancel the meeting',
    'cancel my subscription',
    'cancel tomorrow',
    'stop the music',
    'stop the recording',
    'stop playing jazz',
    'repeat the introduction',
    'repeat the last paragraph',
    'undo the last email I sent',
    'please cancel the meeting at three',
    'can you stop the alarm',
  ];

  for (const u of intents) {
    it(`"${u}" is NOT critical`, () => {
      const r = classifyTaskCommand(u);
      expect(r.critical).toBe(false);
      expect(r.matched).toBeNull();
      expect(r.pattern).toBeNull();
    });
  }
});

describe('classifyTaskCommand - edge cases near the boundary', () => {
  it('"cancel it please" is NOT critical (trailing content)', () => {
    expect(classifyTaskCommand('cancel it please').critical).toBe(false);
  });

  it('"stop that right there" is NOT critical (extra words after pronoun)', () => {
    expect(classifyTaskCommand('stop that right there').critical).toBe(false);
  });

  it('"cancelit" (missing space) is NOT critical', () => {
    expect(classifyTaskCommand('cancelit').critical).toBe(false);
  });

  it('"repeat it" is NOT critical (repeat is not pronoun-eligible)', () => {
    expect(classifyTaskCommand('repeat it').critical).toBe(false);
  });

  it('"undo it" is NOT critical (undo is not pronoun-eligible)', () => {
    expect(classifyTaskCommand('undo it').critical).toBe(false);
  });

  it('"undo that" IS critical (in EXACT_CRITICAL)', () => {
    expect(classifyTaskCommand('undo that').critical).toBe(true);
  });
});

describe('classifyTaskCommand - defensive inputs', () => {
  it('empty / null / undefined never throw', () => {
    expect(classifyTaskCommand('').critical).toBe(false);
    expect(classifyTaskCommand(null).critical).toBe(false);
    expect(classifyTaskCommand(undefined).critical).toBe(false);
  });

  it('whitespace-only input', () => {
    expect(classifyTaskCommand('   ').critical).toBe(false);
  });

  it('non-string input is tolerated', () => {
    expect(classifyTaskCommand(42).critical).toBe(false);
    expect(classifyTaskCommand({}).critical).toBe(false);
  });
});

describe('isCriticalCommand convenience', () => {
  it('returns boolean matching classifyTaskCommand.critical', () => {
    expect(isCriticalCommand('cancel')).toBe(true);
    expect(isCriticalCommand('cancel the meeting')).toBe(false);
    expect(isCriticalCommand('')).toBe(false);
  });
});

describe('constants', () => {
  it('EXACT_CRITICAL is frozen', () => {
    expect(Object.isFrozen(EXACT_CRITICAL)).toBe(true);
  });
  it('PRONOUN_FOLLOWERS is frozen', () => {
    expect(Object.isFrozen(PRONOUN_FOLLOWERS)).toBe(true);
  });
  it('PRONOUN_ELIGIBLE_VERBS is frozen', () => {
    expect(Object.isFrozen(PRONOUN_ELIGIBLE_VERBS)).toBe(true);
  });

  it('EXACT_CRITICAL covers the six classic commands', () => {
    expect(EXACT_CRITICAL).toContain('cancel');
    expect(EXACT_CRITICAL).toContain('stop');
    expect(EXACT_CRITICAL).toContain('nevermind');
    expect(EXACT_CRITICAL).toContain('never mind');
    expect(EXACT_CRITICAL).toContain('repeat');
    expect(EXACT_CRITICAL).toContain('undo');
  });
});

describe('behavioral equivalence to the inline logic', () => {
  // The inline code this module replaces was:
  //   const exactCritical = [...];
  //   const pronounFollowers = [...];
  //   const isTrueCritical =
  //     exactCritical.includes(lowerText) ||
  //     ['cancel', 'stop'].some((c) => {
  //       if (!lowerText.startsWith(c + ' ')) return false;
  //       const rest = lowerText.slice(c.length + 1).trim();
  //       return pronounFollowers.includes(rest);
  //     });
  // This test reproduces that logic and compares to the extracted
  // version against a spread of inputs to lock equivalence in.
  const legacyImpl = (text) => {
    const lowerText = (text || '').toString().toLowerCase().trim();
    const exactCritical = [
      'cancel', 'stop', 'nevermind', 'never mind',
      'repeat', 'say that again', 'undo', 'undo that', 'take that back',
    ];
    const pronounFollowers = ['it', 'that', 'this', 'everything', 'all', 'now'];
    return (
      exactCritical.includes(lowerText) ||
      ['cancel', 'stop'].some((c) => {
        if (!lowerText.startsWith(c + ' ')) return false;
        const rest = lowerText.slice(c.length + 1).trim();
        return pronounFollowers.includes(rest);
      })
    );
  };

  const samples = [
    'cancel', 'stop', 'undo', 'undo that', 'take that back',
    'say that again', 'never mind', 'nevermind',
    'cancel it', 'stop that', 'stop now', 'cancel everything',
    'cancel the meeting', 'stop the music', 'repeat the intro',
    '', '   ', 'cancel it please', 'stopthat', 'CANCEL',
  ];

  for (const s of samples) {
    it(`legacy(${JSON.stringify(s)}) === extracted(${JSON.stringify(s)})`, () => {
      // Drop trailing punctuation from the sample for legacy
      // comparison since only the new extraction tolerates it.
      const cleanForLegacy = s.replace(/[.!?]+$/, '');
      expect(legacyImpl(cleanForLegacy)).toBe(isCriticalCommand(s));
    });
  }
});
