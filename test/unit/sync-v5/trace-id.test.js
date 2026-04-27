/**
 * Unit tests for lib/sync-v5/trace-id.js
 *
 * Covers: format, validation, timestamp roundtrip, lex-sortability,
 * uniqueness, header construction, edge cases.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../lib/log-event-queue', () => ({
  getLogQueue: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

const {
  newTraceId,
  isValidTraceId,
  timestampFromTraceId,
  traceHeader,
  TRACE_ID_HEADER,
  TRACE_ID_PATTERN,
  _encodeTime,
  _encodeRandom,
} = require('../../../lib/sync-v5/trace-id');

describe('sync-v5 / trace-id', () => {
  describe('newTraceId', () => {
    it('produces a 26-char Crockford base32 string', () => {
      const id = newTraceId();
      expect(id).toHaveLength(26);
      expect(TRACE_ID_PATTERN.test(id)).toBe(true);
    });

    it('produces unique IDs across rapid calls', () => {
      const ids = new Set();
      for (let i = 0; i < 1000; i++) ids.add(newTraceId());
      expect(ids.size).toBe(1000);
    });

    it('encodes the timestamp in the first 10 characters', () => {
      const ts = 1730000000000;
      const id = newTraceId(ts);
      expect(timestampFromTraceId(id)).toBe(ts);
    });

    it('is lex-sortable by creation time', () => {
      const ids = [
        newTraceId(1730000000000),
        newTraceId(1730000001000),
        newTraceId(1730000002000),
      ];
      const sorted = [...ids].sort();
      expect(sorted).toEqual(ids);
    });

    it('rejects negative or out-of-range timestamps', () => {
      expect(() => newTraceId(-1)).toThrow(/out of range/);
      expect(() => newTraceId(0xffffffffffff + 1)).toThrow(/out of range/);
    });

    it('rejects non-Buffer or wrong-size random bytes', () => {
      expect(() => newTraceId(Date.now(), 'not a buffer')).toThrow(/10-byte Buffer/);
      expect(() => newTraceId(Date.now(), Buffer.alloc(5))).toThrow(/10-byte Buffer/);
    });

    it('produces consistent output for fixed inputs (deterministic test)', () => {
      const ts = 1730000000000;
      const bytes = Buffer.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
      const id1 = newTraceId(ts, bytes);
      const id2 = newTraceId(ts, bytes);
      expect(id1).toBe(id2);
      expect(id1).toHaveLength(26);
    });
  });

  describe('isValidTraceId', () => {
    it('accepts a freshly-generated ID', () => {
      expect(isValidTraceId(newTraceId())).toBe(true);
    });

    it('rejects wrong length', () => {
      expect(isValidTraceId('TOO-SHORT')).toBe(false);
      expect(isValidTraceId('A'.repeat(27))).toBe(false);
    });

    it('rejects characters outside Crockford alphabet (I, L, O, U)', () => {
      const bad = '0123456789ABCDEFGHIJKLMNOP'; // contains I, L, O
      expect(isValidTraceId(bad)).toBe(false);
    });

    it('rejects non-string input', () => {
      expect(isValidTraceId(null)).toBe(false);
      expect(isValidTraceId(undefined)).toBe(false);
      expect(isValidTraceId(123)).toBe(false);
      expect(isValidTraceId({})).toBe(false);
    });
  });

  describe('timestampFromTraceId', () => {
    it('roundtrips through encode/decode', () => {
      const samples = [0, 1, 1000, 1730000000000, 1234567890123];
      for (const ts of samples) {
        const id = newTraceId(ts);
        expect(timestampFromTraceId(id)).toBe(ts);
      }
    });

    it('throws on invalid IDs', () => {
      expect(() => timestampFromTraceId('not-a-ulid')).toThrow(/Invalid trace ID/);
    });
  });

  describe('traceHeader', () => {
    it('returns an object keyed by the canonical header name', () => {
      const id = newTraceId();
      const h = traceHeader(id);
      expect(h).toEqual({ [TRACE_ID_HEADER]: id });
      expect(TRACE_ID_HEADER).toBe('X-Trace-Id');
    });

    it('throws on invalid trace ID', () => {
      expect(() => traceHeader('garbage')).toThrow(/Invalid trace ID/);
    });
  });

  describe('encoder internals', () => {
    it('_encodeTime produces 10 chars', () => {
      expect(_encodeTime(0)).toHaveLength(10);
      expect(_encodeTime(0)).toMatch(/^0+$/);
      expect(_encodeTime(1730000000000)).toHaveLength(10);
    });

    it('_encodeRandom produces 16 chars', () => {
      const out = _encodeRandom(Buffer.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
      expect(out).toHaveLength(16);
      expect(out).toMatch(/^0+$/);
      const out2 = _encodeRandom(Buffer.from([255, 255, 255, 255, 255, 255, 255, 255, 255, 255]));
      expect(out2).toHaveLength(16);
    });
  });
});
