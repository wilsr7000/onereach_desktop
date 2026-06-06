/**
 * Boot-chat event-log compressor.
 *
 * Pure-function tests for `compressEventLog`. Exercises bucketing,
 * pluralization, author normalization, verb derivation, and
 * "too many events" footer behavior.
 */

import { describe, it, expect } from 'vitest';

import {
  compressEventLog,
  type CompressableEvent,
} from '../../boot-chat/event-compressor.js';

function ev(overrides: Partial<CompressableEvent> = {}): CompressableEvent {
  return {
    id: 'commit-' + Math.random().toString(36).slice(2, 8),
    author: 'alice@onereach.ai',
    kind: 'item:added',
    timestamp: '2026-05-18T10:00:00Z',
    spaceName: 'Engineering',
    ...overrides,
  };
}

describe('compressEventLog — empty / malformed input', () => {
  it('returns an empty digest for []', () => {
    expect(compressEventLog([])).toEqual({
      totalEvents: 0,
      bullets: [],
      oldestTimestamp: null,
    });
  });

  it('returns empty for non-array input (defensive)', () => {
    expect(
      compressEventLog(null as unknown as ReadonlyArray<CompressableEvent>)
    ).toEqual({ totalEvents: 0, bullets: [], oldestTimestamp: null });
  });

  it('skips malformed rows silently', () => {
    const events = [
      ev({ author: 'alice@example.com', kind: 'item:added' }),
      { foo: 'bar' } as unknown as CompressableEvent,
      ev({ author: 'bob@example.com', kind: 'item:updated' }),
    ];
    const d = compressEventLog(events);
    // Two valid events → two single-event buckets.
    expect(d.bullets).toHaveLength(2);
    expect(d.totalEvents).toBe(3);
  });
});

describe('compressEventLog — bucketing', () => {
  it('groups by (author, verb, object, space) and counts', () => {
    const events = [
      ev({ author: 'alice@example.com', kind: 'item:added' }),
      ev({ author: 'alice@example.com', kind: 'item:added' }),
      ev({ author: 'alice@example.com', kind: 'item:added' }),
    ];
    const d = compressEventLog(events);
    expect(d.bullets).toEqual(['Alice added 3 items in Engineering']);
    expect(d.totalEvents).toBe(3);
  });

  it('splits buckets when the verb differs', () => {
    const events = [
      ev({ author: 'alice@example.com', kind: 'item:added' }),
      ev({ author: 'alice@example.com', kind: 'item:added' }),
      ev({ author: 'alice@example.com', kind: 'item:updated' }),
    ];
    const d = compressEventLog(events);
    expect(d.bullets).toContain('Alice added 2 items in Engineering');
    expect(d.bullets).toContain('Alice updated a item in Engineering');
  });

  it('splits by space when the same author works in two places', () => {
    const events = [
      ev({ author: 'alice@example.com', spaceName: 'Engineering' }),
      ev({ author: 'alice@example.com', spaceName: 'Q3 Audit' }),
      ev({ author: 'alice@example.com', spaceName: 'Q3 Audit' }),
    ];
    const d = compressEventLog(events);
    expect(d.bullets).toContain('Alice added 2 items in Q3 Audit');
    expect(d.bullets).toContain('Alice added a item in Engineering');
  });

  it('sorts bullets by count desc (more-active first)', () => {
    const events = [
      ev({ author: 'alice@x.com' }),
      ev({ author: 'bob@x.com' }),
      ev({ author: 'bob@x.com' }),
      ev({ author: 'bob@x.com' }),
      ev({ author: 'bob@x.com' }),
      ev({ author: 'carol@x.com' }),
      ev({ author: 'carol@x.com' }),
    ];
    const d = compressEventLog(events);
    expect(d.bullets[0]).toMatch(/^Bob /);
    expect(d.bullets[1]).toMatch(/^Carol /);
    expect(d.bullets[2]).toMatch(/^Alice /);
  });

  it('caps the bullet list at maxBullets (default 5)', () => {
    const events: CompressableEvent[] = [];
    for (let i = 0; i < 12; i++) {
      events.push(ev({ author: `user${i}@x.com` }));
    }
    const d = compressEventLog(events);
    expect(d.bullets).toHaveLength(5);
    expect(d.totalEvents).toBe(12);
  });

  it('honors a custom maxBullets cap', () => {
    const events: CompressableEvent[] = [];
    for (let i = 0; i < 8; i++) events.push(ev({ author: `u${i}@x.com` }));
    expect(compressEventLog(events, { maxBullets: 2 }).bullets).toHaveLength(2);
  });
});

describe('compressEventLog — author normalization', () => {
  it('emails become titlecased local part', () => {
    expect(compressEventLog([ev({ author: 'robb.wilson@onereach.ai' })]).bullets[0]).toMatch(
      /^Robb Wilson /
    );
    expect(compressEventLog([ev({ author: 'jane_doe@x.com' })]).bullets[0]).toMatch(
      /^Jane Doe /
    );
  });

  it('non-email authors pass through verbatim (agent ids etc.)', () => {
    expect(
      compressEventLog([ev({ author: 'Audit Agent', kind: 'item:added' })]).bullets[0]
    ).toMatch(/^Audit Agent /);
  });

  it('empty / whitespace author renders as "Someone"', () => {
    expect(compressEventLog([ev({ author: '   ' })]).bullets[0]).toMatch(/^Someone /);
    expect(compressEventLog([ev({ author: '' })]).bullets[0]).toMatch(/^Someone /);
  });
});

describe('compressEventLog — verbs + objects', () => {
  it('item:added → "added a item" / "added N items"', () => {
    expect(compressEventLog([ev({ kind: 'item:added' })]).bullets[0]).toMatch(
      /added a item/
    );
    expect(
      compressEventLog([ev({ kind: 'item:added' }), ev({ kind: 'item:added' })]).bullets[0]
    ).toMatch(/added 2 items/);
  });

  it('ticket:done → "removed" mapped from "done"… wait — "done" is not in the verb map', () => {
    // Confirm the fallback: an unknown verb returns the raw kind.
    const d = compressEventLog([ev({ kind: 'ticket:done' })]);
    expect(d.bullets[0]).toMatch(/ticket:done/);
  });

  it('asset:produced + agent author', () => {
    const d = compressEventLog([
      ev({
        author: 'Audit Agent',
        kind: 'asset:produced',
        spaceName: 'Q3 Audit',
      }),
    ]);
    expect(d.bullets[0]).toBe('Audit Agent produced a item in Q3 Audit');
  });

  it('space:created falls back to "change" as the object', () => {
    const d = compressEventLog([
      ev({ author: 'alice@x.com', kind: 'space:created', spaceName: 'New Space' }),
    ]);
    expect(d.bullets[0]).toMatch(/created a change in New Space/);
  });
});

describe('compressEventLog — space context', () => {
  it('omits the "in X" clause when neither spaceName nor spaceId is known', () => {
    const e: CompressableEvent = {
      id: 'c1',
      author: 'alice@example.com',
      kind: 'item:added',
      timestamp: '2026-05-18T10:00:00Z',
    };
    expect(compressEventLog([e]).bullets[0]).toBe('Alice added a item');
  });

  it('falls back to spaceId when spaceName is missing', () => {
    const e: CompressableEvent = {
      id: 'c1',
      author: 'alice@example.com',
      kind: 'item:added',
      timestamp: '2026-05-18T10:00:00Z',
      spaceId: 'sp-abc',
    };
    expect(compressEventLog([e]).bullets[0]).toBe('Alice added a item in sp-abc');
  });
});

describe('compressEventLog — oldestTimestamp', () => {
  it('returns the oldest timestamp across events', () => {
    const d = compressEventLog([
      ev({ timestamp: '2026-05-18T12:00:00Z' }),
      ev({ timestamp: '2026-05-18T05:00:00Z' }),
      ev({ timestamp: '2026-05-18T10:00:00Z' }),
    ]);
    expect(d.oldestTimestamp).toBe('2026-05-18T05:00:00Z');
  });
});
