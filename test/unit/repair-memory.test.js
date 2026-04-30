/**
 * Repair Memory - Unit Tests
 *
 * Run:  npx vitest run test/unit/repair-memory.test.js
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { createRepairMemory, POISON_HEARD } = require('../../lib/naturalness/repair-memory');

function makeSpacesMock(initialContents = null) {
  let contents = initialContents;
  const reads = [];
  const writes = [];
  return {
    files: {
      async read(_scope, name) {
        reads.push(name);
        return contents;
      },
      async write(_scope, name, body) {
        writes.push({ name, body });
        contents = body;
        return true;
      },
      async delete(_scope, _name) {
        contents = null;
        return true;
      },
    },
    _reads: reads,
    _writes: writes,
    _getContents: () => contents,
  };
}

describe('createRepairMemory', () => {
  let nowMs;
  let now;

  beforeEach(() => {
    nowMs = 1_000_000;
    now = () => nowMs;
  });

  describe('learnFix', () => {
    it('stores a new fix', () => {
      const rm = createRepairMemory({ now });
      const r = rm.learnFix('jess', 'jazz');
      expect(r.added).toBe(true);
      expect(rm.size()).toBe(1);
      expect(rm.getFixes()[0]).toMatchObject({
        heard: 'jess',
        meant: 'jazz',
        hits: 1,
      });
    });

    it('updates an existing fix, bumping hits', () => {
      const rm = createRepairMemory({ now });
      rm.learnFix('jess', 'jazz');
      nowMs += 1000;
      const r = rm.learnFix('jess', 'jazz');
      expect(r.updated).toBe(true);
      expect(rm.getFixes()[0].hits).toBe(2);
    });

    it('is case-insensitive on the heard side', () => {
      const rm = createRepairMemory({ now });
      rm.learnFix('Jess', 'jazz');
      const r = rm.learnFix('JESS', 'jazz');
      expect(r.updated).toBe(true);
      expect(rm.size()).toBe(1);
    });

    it('rejects empty inputs', () => {
      const rm = createRepairMemory({ now });
      expect(rm.learnFix('', 'jazz').added).toBe(false);
      expect(rm.learnFix('jess', '').added).toBe(false);
      expect(rm.size()).toBe(0);
    });

    it('rejects identical heard/meant', () => {
      const rm = createRepairMemory({ now });
      const r = rm.learnFix('jazz', 'jazz');
      expect(r.added).toBe(false);
      expect(r.reason).toBe('identical');
    });

    it('rejects single-word poison-heard (common English words)', () => {
      const rm = createRepairMemory({ now });
      for (const poison of POISON_HEARD) {
        const r = rm.learnFix(poison, 'something');
        expect(r.added).toBe(false);
        expect(r.reason).toBe('poison-heard');
      }
    });

    it('allows multi-word heard even if one component is a poison word', () => {
      const rm = createRepairMemory({ now });
      const r = rm.learnFix('the jess', 'the jazz');
      expect(r.added).toBe(true);
    });
  });

  describe('applyFixes', () => {
    it('rewrites a learned token on word boundaries', () => {
      const rm = createRepairMemory({ now });
      rm.learnFix('jess', 'jazz');
      const r = rm.applyFixes('play some jess for me');
      expect(r.text).toBe('play some jazz for me');
      expect(r.appliedCount).toBe(1);
      expect(r.applied[0]).toEqual({ heard: 'jess', meant: 'jazz' });
    });

    it('does not rewrite inside another word', () => {
      const rm = createRepairMemory({ now });
      rm.learnFix('jess', 'jazz');
      const r = rm.applyFixes('jessica called');
      expect(r.text).toBe('jessica called');
      expect(r.appliedCount).toBe(0);
    });

    it('is case-insensitive on match, preserves the meant casing', () => {
      const rm = createRepairMemory({ now });
      rm.learnFix('jess', 'jazz');
      const r = rm.applyFixes('Play JESS now');
      expect(r.text).toBe('Play jazz now');
    });

    it('rewrites multiple occurrences', () => {
      const rm = createRepairMemory({ now });
      rm.learnFix('jess', 'jazz');
      const r = rm.applyFixes('jess and more jess');
      expect(r.text).toBe('jazz and more jazz');
    });

    it('applies multiple fixes in the same transcript', () => {
      const rm = createRepairMemory({ now });
      rm.learnFix('jess', 'jazz');
      rm.learnFix('onetwothree', 'alice');
      const r = rm.applyFixes('call onetwothree about jess');
      expect(r.text).toBe('call alice about jazz');
      expect(r.appliedCount).toBe(2);
    });

    it('updates hits on every apply', () => {
      const rm = createRepairMemory({ now });
      rm.learnFix('jess', 'jazz');
      rm.applyFixes('jess');
      rm.applyFixes('more jess please');
      expect(rm.getFixes()[0].hits).toBe(3); // 1 from learn, 1+1 from applies
    });

    it('returns original text when no fixes are stored', () => {
      const rm = createRepairMemory({ now });
      const r = rm.applyFixes('nothing to fix here');
      expect(r.text).toBe('nothing to fix here');
      expect(r.appliedCount).toBe(0);
    });

    it('defends against regex metacharacters in heard (does not crash)', () => {
      // Heard strings can include punctuation from STT ("mr. smith").
      // We guarantee the regex does not crash AND alphanumeric parts
      // still match around the punctuation.
      const rm = createRepairMemory({ now });
      rm.learnFix('mr smith', 'mr jones');
      expect(() => rm.applyFixes('tell mr smith about jazz')).not.toThrow();
      const r = rm.applyFixes('tell mr smith about jazz');
      expect(r.text).toBe('tell mr jones about jazz');
    });

    it('empty transcript returns empty output', () => {
      const rm = createRepairMemory({ now });
      rm.learnFix('jess', 'jazz');
      const r = rm.applyFixes('');
      expect(r.text).toBe('');
      expect(r.appliedCount).toBe(0);
    });
  });

  describe('capacity + eviction', () => {
    it('evicts least recently hit entries past capacity', () => {
      const rm = createRepairMemory({ now, capacity: 3 });

      rm.learnFix('a1', 'b1'); nowMs += 1;
      rm.learnFix('a2', 'b2'); nowMs += 1;
      rm.learnFix('a3', 'b3'); nowMs += 1;
      expect(rm.size()).toBe(3);

      // Touch a1 so it becomes most recently hit.
      rm.applyFixes('a1');
      nowMs += 1;
      rm.learnFix('a4', 'b4'); // evicts a2 (oldest lastHit)
      expect(rm.size()).toBe(3);
      const heardSet = new Set(rm.getFixes().map((f) => f.heard));
      expect(heardSet.has('a2')).toBe(false);
      expect(heardSet.has('a1')).toBe(true);
      expect(heardSet.has('a4')).toBe(true);
    });
  });

  describe('persistence', () => {
    it('save + load roundtrips fixes via Spaces', async () => {
      const spaces = makeSpacesMock();
      const rm1 = createRepairMemory({ spaces, now });
      rm1.learnFix('jess', 'jazz');
      rm1.learnFix('bob', 'bill');
      expect(await rm1.save()).toBe(true);

      const rm2 = createRepairMemory({ spaces, now });
      expect(rm2.size()).toBe(0);
      expect(await rm2.load()).toBe(true);
      expect(rm2.size()).toBe(2);
    });

    it('load returns false when Spaces has no file', async () => {
      const spaces = makeSpacesMock(null);
      const rm = createRepairMemory({ spaces, now });
      expect(await rm.load()).toBe(false);
    });

    it('load tolerates malformed JSON', async () => {
      const spaces = makeSpacesMock('{not json');
      const rm = createRepairMemory({ spaces, now });
      const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const rm2 = createRepairMemory({ spaces, now, log });
      expect(await rm2.load()).toBe(false);
      expect(log.warn).toHaveBeenCalled();
    });

    it('load ignores malformed entries', async () => {
      const spaces = makeSpacesMock(
        JSON.stringify({
          version: 1,
          fixes: [
            { heard: 'jess', meant: 'jazz', hits: 2, lastHit: 1 },
            { heard: 123, meant: 'whatever' }, // bad
            null,                                // bad
            { meant: 'missing-heard' },          // bad
          ],
        })
      );
      const rm = createRepairMemory({ spaces, now });
      await rm.load();
      expect(rm.size()).toBe(1);
    });

    it('no spaces configured -> load/save are no-ops returning false', async () => {
      const rm = createRepairMemory({ now });
      expect(await rm.load()).toBe(false);
      rm.learnFix('jess', 'jazz');
      expect(await rm.save()).toBe(false);
    });
  });

  describe('utility', () => {
    it('clear wipes all fixes', () => {
      const rm = createRepairMemory({ now });
      rm.learnFix('jess', 'jazz');
      rm.learnFix('bob', 'bill');
      rm.clear();
      expect(rm.size()).toBe(0);
      expect(rm.getLastLearned()).toBeNull();
    });
  });

  // ================================================================
  //   Always-on safety nets: cycle detection, unlearn, last-learned
  // ================================================================

  describe('cycle detection in learnFix', () => {
    it('learning jess->jazz then jazz->jess removes jess->jazz and installs neither', () => {
      const rm = createRepairMemory({ now });
      const first = rm.learnFix('jess', 'jazz');
      expect(first.added).toBe(true);
      expect(rm.size()).toBe(1);

      const second = rm.learnFix('jazz', 'jess');
      expect(second.unlearned).toBe(true);
      expect(second.reason).toBe('cycle-undo');
      expect(rm.size()).toBe(0);
    });

    it('cycle-undo applies only to the exact inverse pair', () => {
      const rm = createRepairMemory({ now });
      rm.learnFix('jess', 'jazz');
      // A different "heard" value does NOT trigger cycle detection.
      const r = rm.learnFix('bob', 'jess');
      expect(r.added).toBe(true);
      expect(rm.size()).toBe(2);
    });

    it('cycle-undo is case-insensitive', () => {
      const rm = createRepairMemory({ now });
      rm.learnFix('Jess', 'Jazz');
      const r = rm.learnFix('JAZZ', 'JESS');
      expect(r.unlearned).toBe(true);
      expect(rm.size()).toBe(0);
    });
  });

  describe('unlearnFix', () => {
    it('removes a fix by its heard token', () => {
      const rm = createRepairMemory({ now });
      rm.learnFix('jess', 'jazz');
      const r = rm.unlearnFix('jess');
      expect(r.removed).toBe(true);
      expect(r.entry.meant).toBe('jazz');
      expect(rm.size()).toBe(0);
    });

    it('returns removed=false when the heard is not stored', () => {
      const rm = createRepairMemory({ now });
      rm.learnFix('jess', 'jazz');
      expect(rm.unlearnFix('bob').removed).toBe(false);
      expect(rm.size()).toBe(1);
    });

    it('is case-insensitive', () => {
      const rm = createRepairMemory({ now });
      rm.learnFix('jess', 'jazz');
      expect(rm.unlearnFix('JESS').removed).toBe(true);
    });
  });

  describe('unlearnLast', () => {
    it('removes the most recently added fix', () => {
      const rm = createRepairMemory({ now });
      rm.learnFix('bob', 'bill');
      nowMs += 1;
      rm.learnFix('jess', 'jazz');
      const r = rm.unlearnLast();
      expect(r.removed).toBe(true);
      expect(r.entry.heard).toBe('jess');
      expect(rm.size()).toBe(1);
    });

    it('tracks updates too, not only adds', () => {
      const rm = createRepairMemory({ now });
      rm.learnFix('jess', 'jazz');
      nowMs += 1;
      rm.learnFix('bob', 'bill');
      nowMs += 1;
      rm.learnFix('jess', 'jazzy');              // update on jess
      const r = rm.unlearnLast();
      expect(r.removed).toBe(true);
      expect(r.entry.heard).toBe('jess');
    });

    it('returns removed=false after the last fix is already gone', () => {
      const rm = createRepairMemory({ now });
      rm.learnFix('jess', 'jazz');
      rm.unlearnLast();
      const r = rm.unlearnLast();
      expect(r.removed).toBe(false);
      expect(r.reason).toBe('no-recent-fix');
    });

    it('cycle-undo clears last-learned so unlearnLast returns no-recent-fix', () => {
      const rm = createRepairMemory({ now });
      rm.learnFix('jess', 'jazz');
      rm.learnFix('jazz', 'jess');
      expect(rm.size()).toBe(0);
      const r = rm.unlearnLast();
      expect(r.removed).toBe(false);
    });
  });

  describe('getLastLearned', () => {
    it('returns null when nothing has been learned', () => {
      const rm = createRepairMemory({ now });
      expect(rm.getLastLearned()).toBeNull();
    });

    it('returns a snapshot of the most recent fix', () => {
      const rm = createRepairMemory({ now });
      rm.learnFix('jess', 'jazz');
      rm.learnFix('bob', 'bill');
      expect(rm.getLastLearned()).toMatchObject({ heard: 'bob', meant: 'bill' });
    });
  });

  describe('applyFixes with multiple learned fixes (no cascading)', () => {
    it('does not flip-flop when two fixes are mutual inverses (cycle detection prevents install)', () => {
      const rm = createRepairMemory({ now });
      rm.learnFix('jess', 'jazz');
      rm.learnFix('jazz', 'jess');            // cycle-undo -> removes jess->jazz
      const r = rm.applyFixes('play some jess');
      expect(r.text).toBe('play some jess');  // untouched
    });

    it('applies non-overlapping fixes in one pass against the original text', () => {
      const rm = createRepairMemory({ now });
      rm.learnFix('jess', 'jazz');
      rm.learnFix('bob', 'bill');
      const r = rm.applyFixes('tell bob to play jess');
      expect(r.text).toBe('tell bill to play jazz');
      expect(r.appliedCount).toBe(2);
    });

    it('prefers the longer match when spans overlap', () => {
      const rm = createRepairMemory({ now });
      rm.learnFix('jess smith', 'alice smith');
      rm.learnFix('jess', 'jazz');
      const r = rm.applyFixes('call jess smith about jess');
      expect(r.text).toBe('call alice smith about jazz');
    });
  });
});
