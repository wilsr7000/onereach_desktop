/**
 * Phase 2e (calendar agent overhaul) -- regression guard for the
 * identity-keyed snapshot diff.
 *
 * The bug being prevented: keying on `${recurringEventId}:${currentStartTime}`
 * makes a moved recurring instance look like remove(old) + add(new) instead
 * of move. The fix uses Google's `originalStartTime` (the recurrence's
 * intended slot, immutable across moves) with a stable-id fallback.
 *
 * Also covers:
 *   - eventKey() for one-off events (just `event.id`)
 *   - buildSnapshotMap shape (title/startISO/endISO/recurringEventId)
 *   - diffSnapshots produces clean added/removed/moved/retitled buckets
 *   - writeBriefSnapshot upsert-by-date semantics
 *   - getMostRecentBriefSnapshot returns the highest date strictly < target
 *   - retention: snapshots older than retentionDays are pruned on write
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

const calendarMemory = require('../../lib/calendar-memory');
const { eventKey, buildSnapshotMap, diffSnapshots } = calendarMemory;

// Test seam matching the other calendar-memory test files.
function makeFakeStore(initialRaw) {
  const sections = new Map();
  let raw = initialRaw || '';
  if (raw) {
    const lines = raw.split('\n');
    let cur = '_header';
    let buf = [];
    for (const line of lines) {
      const m = line.match(/^##\s+(.+)$/);
      if (m) {
        sections.set(cur, buf.join('\n').trim());
        cur = m[1].trim();
        buf = [];
      } else {
        if (cur === '_header' && /^#\s+/.test(line)) continue;
        buf.push(line);
      }
    }
    sections.set(cur, buf.join('\n').trim());
  }
  const store = {
    isLoaded: () => true,
    isDirty: () => store._dirty,
    _dirty: false,
    async load() { return true; },
    async save() { store._dirty = false; return true; },
    getSection(name) { return sections.get(name) || null; },
    updateSection(name, content) { sections.set(name, content); store._dirty = true; },
    appendToSection(name, entry) {
      const cur = sections.get(name) || '';
      sections.set(name, cur ? `${cur}\n${entry}` : entry);
      store._dirty = true;
    },
    getSectionNames() { return [...sections.keys()].filter((k) => k !== '_header'); },
    parseSectionAsKeyValue() { return {}; },
    getRaw() { return raw; },
    setRaw(r) { raw = r; store._dirty = true; },
  };
  return store;
}

let tmpDir;

beforeEach(() => {
  calendarMemory._resetForTests();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cal-snap-test-'));
  calendarMemory._setSidecarPathForTests(path.join(tmpDir, 'sidecar.jsonl'));
});

afterEach(() => {
  calendarMemory._resetForTests();
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe('Phase 2e: eventKey identity rules', () => {
  it('one-off event: key = event.id', () => {
    const e = { id: 'one-off-123', start: { dateTime: '2026-04-29T09:00:00Z' } };
    expect(eventKey(e)).toBe('one-off-123');
  });

  it('recurring instance with originalStartTime: key uses the original slot', () => {
    const e = {
      id: 'recur_123_20260429T090000Z',
      recurringEventId: 'recur_123',
      originalStartTime: { dateTime: '2026-04-29T09:00:00Z' },
      start: { dateTime: '2026-04-29T10:00:00Z' }, // currently moved to 10am
    };
    // Key reflects the ORIGINAL slot, not the current one.
    expect(eventKey(e)).toBe('recur_123:2026-04-29T09:00:00Z');
  });

  it('recurring instance without originalStartTime: falls back to stable id', () => {
    // Google's instance ids embed the original timestamp, so they're stable
    // across reschedules even when originalStartTime isn't normalized through.
    const e = {
      id: 'recur_456_20260429T090000Z',
      recurringEventId: 'recur_456',
      start: { dateTime: '2026-04-29T10:00:00Z' },
    };
    expect(eventKey(e)).toBe('recur_456_20260429T090000Z');
  });

  it('returns null for null/empty events', () => {
    expect(eventKey(null)).toBeNull();
    expect(eventKey({})).toBeNull();
  });

  it('THE REGRESSION: moved recurring instance keeps its key', () => {
    // Same recurring series, same originalStartTime, different current start.
    // Naive `${recurringEventId}:${currentStart}` keying would change here;
    // the originalStartTime keying preserves identity across the move.
    const before = {
      id: 'recur_x_20260429T090000Z',
      recurringEventId: 'recur_x',
      originalStartTime: { dateTime: '2026-04-29T09:00:00Z' },
      start: { dateTime: '2026-04-29T09:00:00Z' },
    };
    const after = {
      id: 'recur_x_20260429T090000Z',
      recurringEventId: 'recur_x',
      originalStartTime: { dateTime: '2026-04-29T09:00:00Z' },
      start: { dateTime: '2026-04-29T10:00:00Z' }, // moved
    };
    expect(eventKey(before)).toBe(eventKey(after));
  });
});

describe('Phase 2e: buildSnapshotMap', () => {
  it('produces a key->{title,startISO,endISO,recurringEventId} map', () => {
    const events = [
      {
        id: 'e1',
        summary: 'Standup',
        start: { dateTime: '2026-04-29T09:00:00Z' },
        end: { dateTime: '2026-04-29T09:30:00Z' },
      },
    ];
    const map = buildSnapshotMap(events);
    expect(map.e1).toEqual({
      title: 'Standup',
      startISO: '2026-04-29T09:00:00Z',
      endISO: '2026-04-29T09:30:00Z',
      recurringEventId: null,
    });
  });

  it('skips events without a derivable key', () => {
    const map = buildSnapshotMap([{ summary: 'no id' }, { id: 'e1', summary: 'x' }]);
    expect(Object.keys(map)).toEqual(['e1']);
  });

  it('preserves recurringEventId for recurring instances', () => {
    const events = [
      {
        id: 'recur_123_t',
        recurringEventId: 'recur_123',
        originalStartTime: { dateTime: '2026-04-29T09:00:00Z' },
        summary: 'Standup',
        start: { dateTime: '2026-04-29T09:00:00Z' },
        end: { dateTime: '2026-04-29T09:30:00Z' },
      },
    ];
    const map = buildSnapshotMap(events);
    const k = 'recur_123:2026-04-29T09:00:00Z';
    expect(map[k].recurringEventId).toBe('recur_123');
  });
});

describe('Phase 2e: diffSnapshots', () => {
  it('empty diff when both sides match', () => {
    const a = { e1: { title: 'X', startISO: 't1' } };
    const out = diffSnapshots(a, { ...a });
    expect(out.added).toHaveLength(0);
    expect(out.removed).toHaveLength(0);
    expect(out.moved).toHaveLength(0);
    expect(out.retitled).toHaveLength(0);
  });

  it('detects added events', () => {
    const out = diffSnapshots(
      { e1: { title: 'A', startISO: 't1' } },
      { e1: { title: 'A', startISO: 't1' }, e2: { title: 'B', startISO: 't2' } }
    );
    expect(out.added).toHaveLength(1);
    expect(out.added[0].key).toBe('e2');
  });

  it('detects removed events', () => {
    const out = diffSnapshots(
      { e1: { title: 'A', startISO: 't1' }, e2: { title: 'B', startISO: 't2' } },
      { e1: { title: 'A', startISO: 't1' } }
    );
    expect(out.removed).toHaveLength(1);
    expect(out.removed[0].key).toBe('e2');
  });

  it('detects moved events (same key, different startISO)', () => {
    const out = diffSnapshots(
      { e1: { title: 'A', startISO: '2026-04-29T09:00:00Z' } },
      { e1: { title: 'A', startISO: '2026-04-29T10:00:00Z' } }
    );
    expect(out.moved).toHaveLength(1);
    expect(out.moved[0].key).toBe('e1');
    expect(out.moved[0].fromStart).toBe('2026-04-29T09:00:00Z');
    expect(out.moved[0].toStart).toBe('2026-04-29T10:00:00Z');
  });

  it('detects retitled events (same key, different title)', () => {
    const out = diffSnapshots(
      { e1: { title: 'old', startISO: 't1' } },
      { e1: { title: 'new', startISO: 't1' } }
    );
    expect(out.retitled).toHaveLength(1);
    expect(out.retitled[0].fromTitle).toBe('old');
    expect(out.retitled[0].toTitle).toBe('new');
  });

  it('THE REGRESSION: a moved recurring instance is "moved", not remove+add', () => {
    // Build the snapshots from real events.
    const yesterdayEvents = [
      {
        id: 'recur_x_20260429T090000Z',
        recurringEventId: 'recur_x',
        originalStartTime: { dateTime: '2026-04-29T09:00:00Z' },
        summary: 'Standup',
        start: { dateTime: '2026-04-29T09:00:00Z' },
        end: { dateTime: '2026-04-29T09:30:00Z' },
      },
    ];
    const todayEvents = [
      {
        id: 'recur_x_20260429T090000Z',
        recurringEventId: 'recur_x',
        originalStartTime: { dateTime: '2026-04-29T09:00:00Z' },
        summary: 'Standup',
        start: { dateTime: '2026-04-29T10:00:00Z' }, // user moved to 10am
        end: { dateTime: '2026-04-29T10:30:00Z' },
      },
    ];
    const out = diffSnapshots(buildSnapshotMap(yesterdayEvents), buildSnapshotMap(todayEvents));
    expect(out.added).toHaveLength(0);
    expect(out.removed).toHaveLength(0);
    expect(out.moved).toHaveLength(1); // <-- the property that locks the regression out
  });

  it('handles null/empty inputs without throwing', () => {
    expect(diffSnapshots(null, {}).added).toEqual([]);
    expect(diffSnapshots({}, null).added).toEqual([]);
    expect(diffSnapshots(null, null).added).toEqual([]);
  });
});

describe('Phase 2e: Brief Snapshots persistence', () => {
  let mem;
  beforeEach(async () => {
    mem = new calendarMemory.CalendarMemory();
    mem._setStoreForTests(makeFakeStore(''));
    await mem.load();
  });

  function evt(id, dateTime, title = id) {
    return {
      id,
      summary: title,
      start: { dateTime },
      end: { dateTime: new Date(new Date(dateTime).getTime() + 30 * 60 * 1000).toISOString() },
    };
  }

  it('writeBriefSnapshot persists events to the section', async () => {
    await mem.writeBriefSnapshot('2026-04-29', [evt('e1', '2026-04-29T09:00:00Z', 'Standup')]);

    const snap = mem.readBriefSnapshot('2026-04-29');
    expect(snap.date).toBe('2026-04-29');
    expect(snap.events.e1.title).toBe('Standup');
  });

  it('upserts: re-writing the same date replaces the prior row', async () => {
    await mem.writeBriefSnapshot('2026-04-29', [evt('e1', '2026-04-29T09:00:00Z', 'Old')]);
    await mem.writeBriefSnapshot('2026-04-29', [evt('e1', '2026-04-29T09:00:00Z', 'Updated')]);

    const snap = mem.readBriefSnapshot('2026-04-29');
    expect(snap.events.e1.title).toBe('Updated');

    const all = mem.readEntries('Brief Snapshots');
    expect(all.length).toBe(1); // upserted, not duplicated
  });

  it('getMostRecentBriefSnapshot returns the highest date strictly < target', async () => {
    await mem.writeBriefSnapshot('2026-04-26', [evt('a', '2026-04-26T09:00:00Z')]);
    await mem.writeBriefSnapshot('2026-04-28', [evt('b', '2026-04-28T09:00:00Z')]);
    await mem.writeBriefSnapshot('2026-04-29', [evt('c', '2026-04-29T09:00:00Z')]);

    const prior = mem.getMostRecentBriefSnapshot('2026-04-29');
    expect(prior.date).toBe('2026-04-28');
    expect(prior.events.b).toBeTruthy();
    expect(prior.ageDays).toBe(1);
  });

  it('getMostRecentBriefSnapshot age reflects gap, not a fixed 1', async () => {
    await mem.writeBriefSnapshot('2026-04-22', [evt('a', '2026-04-22T09:00:00Z')]);
    const prior = mem.getMostRecentBriefSnapshot('2026-04-29');
    expect(prior.ageDays).toBe(7);
  });

  it('returns null when no prior snapshot exists', async () => {
    expect(mem.getMostRecentBriefSnapshot('2026-04-29')).toBeNull();
  });

  it('prunes snapshots older than briefSnapshots.retentionDays on write', async () => {
    // 14-day retention by default. Write a snapshot 30 days old, then a new
    // one. The 30-day-old one should be dropped.
    const old = '2026-03-15';
    const recent = '2026-04-25';
    const today = '2026-04-29';
    await mem.writeBriefSnapshot(old, [evt('a', `${old}T09:00:00Z`)]);
    await mem.writeBriefSnapshot(recent, [evt('b', `${recent}T09:00:00Z`)]);
    await mem.writeBriefSnapshot(today, [evt('c', `${today}T09:00:00Z`)]);

    expect(mem.readBriefSnapshot(old)).toBeNull();
    expect(mem.readBriefSnapshot(recent)).toBeTruthy();
    expect(mem.readBriefSnapshot(today)).toBeTruthy();
  });
});
