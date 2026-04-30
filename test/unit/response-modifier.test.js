/**
 * Response Modifier - Unit Tests
 *
 * Run:  npx vitest run test/unit/response-modifier.test.js
 */

import { describe, it, expect } from 'vitest';

const { adjustResponse } = require('../../lib/naturalness/response-modifier');

// Deterministic RNG helper: always picks the first element.
const FIRST = () => 0;

describe('adjustResponse', () => {
  describe('neutral / missing affect', () => {
    it('no affect -> no change', () => {
      const r = adjustResponse({ text: 'ok, so let me check the weather' });
      expect(r.modified).toBe(false);
      expect(r.text).toBe('ok, so let me check the weather');
      expect(r.transforms).toHaveLength(0);
    });

    it('null affect -> no change', () => {
      const r = adjustResponse({ text: 'hello', affect: null });
      expect(r.modified).toBe(false);
    });

    it('neutral label -> no change', () => {
      const r = adjustResponse({
        text: "ok, let me see what's going on",
        affect: { label: 'neutral' },
      });
      expect(r.modified).toBe(false);
    });

    it('empty text -> no change even with strong affect', () => {
      const r = adjustResponse({ text: '', affect: { label: 'excited' } });
      expect(r.modified).toBe(false);
    });
  });

  describe('frustrated', () => {
    it('strips filler opening and prepends empathy', () => {
      const r = adjustResponse({
        text: "OK, so let me check the weather for you",
        affect: { label: 'frustrated' },
        rng: FIRST,
      });
      expect(r.modified).toBe(true);
      expect(r.transforms).toContain('strip-filler');
      expect(r.transforms).toContain('prepend-empathy');
      expect(r.text.toLowerCase()).toMatch(/^got it/);
      expect(r.text).not.toMatch(/^OK/);
    });

    it('no existing filler -> still prepends empathy', () => {
      const r = adjustResponse({
        text: 'Playing some jazz for you now',
        affect: { label: 'frustrated' },
        rng: FIRST,
      });
      expect(r.modified).toBe(true);
      expect(r.transforms).toContain('prepend-empathy');
      expect(r.transforms).not.toContain('strip-filler');
    });

    it('is idempotent: empathy prefix is not doubled', () => {
      const first = adjustResponse({
        text: 'Playing some jazz',
        affect: { label: 'frustrated' },
        rng: FIRST,
      });
      const second = adjustResponse({
        text: first.text,
        affect: { label: 'frustrated' },
        rng: FIRST,
      });
      expect(second.modified).toBe(false);
    });
  });

  describe('rushed', () => {
    it('strips filler and caps at 2 sentences', () => {
      const r = adjustResponse({
        text: "OK, so let me see. First I'll do this. Then that. Finally the other.",
        affect: { label: 'rushed' },
        rng: FIRST,
      });
      expect(r.modified).toBe(true);
      expect(r.transforms).toContain('cap-sentences:2');
      // Should keep only 2 sentences' worth.
      expect(r.text.split(/[.!?]/).filter((s) => s.trim()).length).toBeLessThanOrEqual(2);
    });

    it('very short response -> no cap applied, no filler present = no-op', () => {
      const r = adjustResponse({
        text: "It's three o'clock.",
        affect: { label: 'rushed' },
        rng: FIRST,
      });
      expect(r.modified).toBe(false);
    });

    it('does NOT prepend empathy for rushed', () => {
      const r = adjustResponse({
        text: 'Playing jazz now.',
        affect: { label: 'rushed' },
        rng: FIRST,
      });
      expect(r.modified).toBe(false);
      expect(r.transforms).not.toContain('prepend-empathy');
    });
  });

  describe('excited', () => {
    it('prepends an energy prefix at the start', () => {
      const r = adjustResponse({
        text: 'Your task is done',
        affect: { label: 'excited' },
        rng: FIRST,
      });
      expect(r.modified).toBe(true);
      expect(r.transforms).toContain('prepend-energy');
      expect(r.text.toLowerCase()).toMatch(/^nice!/);
    });

    it('is idempotent: energy prefix is not doubled', () => {
      const first = adjustResponse({
        text: 'Your task is done',
        affect: { label: 'excited' },
        rng: FIRST,
      });
      const second = adjustResponse({
        text: first.text,
        affect: { label: 'excited' },
        rng: FIRST,
      });
      expect(second.modified).toBe(false);
    });

    it('does not strip filler openings (keeping response warm)', () => {
      const r = adjustResponse({
        text: "OK, so let me play the next one",
        affect: { label: 'excited' },
        rng: FIRST,
      });
      // Energy prefix applied, filler preserved.
      expect(r.transforms).toContain('prepend-energy');
      expect(r.transforms).not.toContain('strip-filler');
    });
  });

  describe('hesitant / deliberate', () => {
    it('hesitant -> no change (avoid being patronising)', () => {
      const r = adjustResponse({
        text: 'Let me walk you through the options',
        affect: { label: 'hesitant' },
      });
      expect(r.modified).toBe(false);
    });

    it('deliberate -> no change (preserve verbosity)', () => {
      const r = adjustResponse({
        text: 'There are three approaches to consider',
        affect: { label: 'deliberate' },
      });
      expect(r.modified).toBe(false);
    });
  });

  describe('unknown label', () => {
    it('unknown label -> no change', () => {
      const r = adjustResponse({
        text: 'hello',
        affect: { label: 'furious' },
      });
      expect(r.modified).toBe(false);
    });
  });
});
