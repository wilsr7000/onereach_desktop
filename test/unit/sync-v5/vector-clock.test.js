/**
 * Unit tests for lib/sync-v5/vector-clock.js
 *
 * Covers the algebra: bump, dominates, equals, concurrent, mergeMax,
 * mergeAndBump. These are the load-bearing invariants for the entire
 * Phase 3 architecture; conflict detection, tombstones, and rebind ops
 * all depend on them being correct.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../lib/log-event-queue', () => ({
  getLogQueue: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

const vc = require('../../../lib/sync-v5/vector-clock');

const A = '01HABC';
const B = '01HDEF';
const C = '01HGHI';

describe('sync-v5 / vector-clock', () => {
  describe('empty + bump', () => {
    it('empty() returns {}', () => {
      expect(vc.empty()).toEqual({});
    });

    it('bump on empty creates the slot at 1', () => {
      expect(vc.bump({}, A)).toEqual({ [A]: 1 });
    });

    it('bump increments the existing slot', () => {
      expect(vc.bump({ [A]: 3 }, A)).toEqual({ [A]: 4 });
    });

    it('bump leaves other slots untouched', () => {
      expect(vc.bump({ [A]: 3, [B]: 5 }, A)).toEqual({ [A]: 4, [B]: 5 });
    });

    it('bump returns a new object (immutable input)', () => {
      const before = { [A]: 1 };
      const after = vc.bump(before, A);
      expect(after).not.toBe(before);
      expect(before).toEqual({ [A]: 1 });
    });

    it('bump with empty deviceId throws', () => {
      expect(() => vc.bump({}, '')).toThrow(/deviceId/);
      expect(() => vc.bump({}, null)).toThrow(/deviceId/);
    });

    it('bump on invalid input falls through to empty + slot=1', () => {
      // Pass null vc; treated as empty.
      expect(vc.bump(null, A)).toEqual({ [A]: 1 });
    });
  });

  describe('get', () => {
    it('returns the slot value', () => {
      expect(vc.get({ [A]: 7 }, A)).toBe(7);
    });

    it('returns 0 for missing slots', () => {
      expect(vc.get({}, A)).toBe(0);
      expect(vc.get({ [B]: 5 }, A)).toBe(0);
    });

    it('returns 0 for invalid vc', () => {
      expect(vc.get(null, A)).toBe(0);
    });
  });

  describe('dominates / equals / concurrent', () => {
    it('equal vcs: equals=true, dominates=false, concurrent=false', () => {
      const x = { [A]: 1, [B]: 2 };
      const y = { [A]: 1, [B]: 2 };
      expect(vc.equals(x, y)).toBe(true);
      expect(vc.dominates(x, y)).toBe(false);
      expect(vc.dominates(y, x)).toBe(false);
      expect(vc.concurrent(x, y)).toBe(false);
    });

    it('strictly newer dominates: a > b on at least one slot, >= everywhere', () => {
      const a = { [A]: 2, [B]: 3 };
      const b = { [A]: 1, [B]: 3 };
      expect(vc.dominates(a, b)).toBe(true);
      expect(vc.dominates(b, a)).toBe(false);
      expect(vc.concurrent(a, b)).toBe(false);
    });

    it('concurrent: each has a slot the other doesn\'t', () => {
      const a = { [A]: 2, [B]: 1 };
      const b = { [A]: 1, [B]: 2 };
      expect(vc.dominates(a, b)).toBe(false);
      expect(vc.dominates(b, a)).toBe(false);
      expect(vc.concurrent(a, b)).toBe(true);
    });

    it('strict subset is dominated', () => {
      const a = { [A]: 1, [B]: 1 };
      const b = { [A]: 1 };
      expect(vc.dominates(a, b)).toBe(true);
      expect(vc.concurrent(a, b)).toBe(false);
    });

    it('three-way concurrent (regression for v5 4.7 N>2 case)', () => {
      const a = { [A]: 1 };
      const b = { [B]: 1 };
      const c = { [C]: 1 };
      expect(vc.concurrent(a, b)).toBe(true);
      expect(vc.concurrent(b, c)).toBe(true);
      expect(vc.concurrent(a, c)).toBe(true);
    });

    it('invalid inputs do not dominate or equal', () => {
      expect(vc.dominates(null, { [A]: 1 })).toBe(false);
      expect(vc.equals(null, null)).toBe(false);
      expect(vc.concurrent(null, { [A]: 1 })).toBe(false);
    });
  });

  describe('mergeMax + mergeAndBump', () => {
    it('mergeMax takes the max per slot', () => {
      const a = { [A]: 3, [B]: 1 };
      const b = { [A]: 1, [B]: 5 };
      expect(vc.mergeMax([a, b])).toEqual({ [A]: 3, [B]: 5 });
    });

    it('mergeMax of three concurrent vcs unifies all slots', () => {
      const a = { [A]: 1 };
      const b = { [B]: 1 };
      const c = { [C]: 1 };
      expect(vc.mergeMax([a, b, c])).toEqual({ [A]: 1, [B]: 1, [C]: 1 });
    });

    it('mergeMax with empty array returns empty', () => {
      expect(vc.mergeMax([])).toEqual({});
    });

    it('mergeMax skips invalid entries', () => {
      expect(vc.mergeMax([null, { [A]: 1 }, undefined])).toEqual({ [A]: 1 });
    });

    it('mergeAndBump dominates every input (the conflict-resolution invariant)', () => {
      const a = { [A]: 1, [B]: 1 };
      const b = { [A]: 1, [C]: 1 };
      const merged = vc.mergeAndBump([a, b], A);
      expect(vc.dominates(merged, a)).toBe(true);
      expect(vc.dominates(merged, b)).toBe(true);
      // Specifically: A's slot is bumped beyond mergeMax (1 -> 2)
      expect(merged[A]).toBe(2);
    });
  });

  describe('isValid', () => {
    it('accepts empty and well-formed vcs', () => {
      expect(vc.isValid({})).toBe(true);
      expect(vc.isValid({ [A]: 1, [B]: 2 })).toBe(true);
    });

    it('rejects null, arrays, primitives', () => {
      expect(vc.isValid(null)).toBe(false);
      expect(vc.isValid(undefined)).toBe(false);
      expect(vc.isValid([])).toBe(false);
      expect(vc.isValid(7)).toBe(false);
      expect(vc.isValid('vc')).toBe(false);
    });

    it('rejects non-integer or negative slot values', () => {
      expect(vc.isValid({ [A]: 1.5 })).toBe(false);
      expect(vc.isValid({ [A]: -1 })).toBe(false);
      expect(vc.isValid({ [A]: 'one' })).toBe(false);
      expect(vc.isValid({ [A]: NaN })).toBe(false);
    });

    it('rejects empty-string keys', () => {
      expect(vc.isValid({ '': 1 })).toBe(false);
    });
  });

  describe('toJSON / fromJSON', () => {
    it('roundtrips well-formed vcs', () => {
      const v = { [A]: 1, [B]: 2 };
      expect(vc.fromJSON(vc.toJSON(v))).toEqual(v);
    });

    it('fromJSON returns empty on garbage input (fail closed)', () => {
      expect(vc.fromJSON('not json')).toEqual({});
      expect(vc.fromJSON('null')).toEqual({});
      expect(vc.fromJSON('[1,2,3]')).toEqual({});
    });

    it('toJSON throws on invalid input', () => {
      expect(() => vc.toJSON(null)).toThrow();
    });
  });

  describe('format', () => {
    it('compact format with sorted keys', () => {
      const v = { [B]: 2, [A]: 1 };
      const f = vc.format(v);
      expect(f).toMatch(/^vc\{/);
      expect(f.indexOf(A.slice(0, 8))).toBeLessThan(f.indexOf(B.slice(0, 8)));
    });

    it('handles empty', () => {
      expect(vc.format({})).toBe('vc{}');
    });

    it('handles invalid', () => {
      expect(vc.format(null)).toBe('vc(invalid)');
    });
  });
});
