/**
 * Mic Injector - Unit Tests
 *
 * Verifies scripted transcript emission, partial streaming, clock
 * advancement, and resilient subscriber handling.
 *
 * Run:  npx vitest run test/unit/mic-injector.test.js
 */

import { describe, it, expect, beforeEach } from 'vitest';

const { MicInjector } = require('../harness/mic-injector');

describe('MicInjector', () => {
  let mic;

  beforeEach(() => {
    mic = new MicInjector();
  });

  it('say() emits a finalized transcript event', () => {
    const seen = [];
    mic.onTranscript((ev) => seen.push(ev));
    mic.say('hello there');
    expect(seen).toHaveLength(1);
    expect(seen[0].text).toBe('hello there');
    expect(seen[0].final).toBe(true);
    expect(seen[0].confidence).toBe(1.0);
  });

  it('sayPartial() emits interim with final=false', () => {
    const seen = [];
    mic.onTranscript((ev) => seen.push(ev));
    mic.sayPartial('hello');
    expect(seen[0]).toMatchObject({ text: 'hello', final: false });
  });

  it('sayWithPartials emits partials then final with incremental clock', () => {
    const seen = [];
    mic.onTranscript((ev) => seen.push(ev));
    mic.sayWithPartials(['set', 'set a', 'set a timer for five minutes'], {
      partialIntervalMs: 100,
    });
    expect(seen.map((e) => e.final)).toEqual([false, false, true]);
    expect(seen[2].text).toBe('set a timer for five minutes');
    // Clock advanced between partials so timestamps increase
    expect(seen[0].timestamp).toBe(0);
    expect(seen[1].timestamp).toBe(100);
    expect(seen[2].timestamp).toBe(200);
  });

  it('onTranscript returns an unsubscribe function', () => {
    const seen = [];
    const off = mic.onTranscript((ev) => seen.push(ev));
    mic.say('one');
    off();
    mic.say('two');
    expect(seen.map((e) => e.text)).toEqual(['one']);
  });

  it('supports multiple simultaneous subscribers', () => {
    const a = [];
    const b = [];
    mic.onTranscript((ev) => a.push(ev));
    mic.onTranscript((ev) => b.push(ev));
    mic.say('shared');
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });

  it('advance() increases the clock used on subsequent events', () => {
    const seen = [];
    mic.onTranscript((ev) => seen.push(ev));
    mic.say('first');
    mic.advance(500);
    mic.say('second');
    expect(seen[0].timestamp).toBe(0);
    expect(seen[1].timestamp).toBe(500);
  });

  it('reset() clears events, subscribers, and clock', () => {
    const seen = [];
    mic.onTranscript((ev) => seen.push(ev));
    mic.say('hello');
    mic.advance(250);

    mic.reset();
    expect(mic.events).toEqual([]);
    expect(mic.now()).toBe(0);

    // Prior subscriber should be gone -- new say() does not reach it.
    mic.say('after reset');
    expect(seen.map((e) => e.text)).toEqual(['hello']);
    // But mic.events still records its own emissions.
    expect(mic.events.map((e) => e.text)).toEqual(['after reset']);
  });

  it('captures its own events in .events even with no subscribers', () => {
    mic.say('no subscribers yet');
    expect(mic.events).toHaveLength(1);
  });

  it('subscriber that throws does not break emission for other subscribers', () => {
    const good = [];
    mic.onTranscript(() => {
      throw new Error('bad subscriber');
    });
    mic.onTranscript((ev) => good.push(ev));
    mic.say('still works');
    expect(good).toHaveLength(1);
    expect(mic.events[0].subscriberError).toMatch(/bad subscriber/);
  });

  it('rejects non-function callbacks', () => {
    expect(() => mic.onTranscript('not a function')).toThrow(TypeError);
    expect(() => mic.onTranscript(null)).toThrow(TypeError);
  });

  it('negative advance is a no-op', () => {
    const before = mic.now();
    mic.advance(-100);
    expect(mic.now()).toBe(before);
  });

  it('sayWithPartials with empty array is a no-op', () => {
    const seen = [];
    mic.onTranscript((ev) => seen.push(ev));
    mic.sayWithPartials([]);
    expect(seen).toEqual([]);
  });
});
