/**
 * Unit tests for lib/events/events-store.js -- :Event nodes in the graph,
 * exercised through the _setTestDeps client seam (no vi.mock of requires).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../lib/log-event-queue', () => ({
  getLogQueue: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import * as store from '../../lib/events/events-store.js';

const NOW = new Date(2026, 7, 3, 10, 0, 0); // Monday

let queries;
let client;

beforeEach(() => {
  queries = [];
  client = {
    executeQuery: vi.fn(async (cypher, params) => {
      queries.push({ cypher, params });
      return [];
    }),
  };
  store._setTestDeps({ getClient: () => client, now: () => NOW });
});

afterEach(() => {
  store._setTestDeps(null);
});

describe('addEvent', () => {
  it('MERGEs an :Event node with normalized properties', async () => {
    const event = await store.addEvent({
      title: '  Dentist ',
      startsAt: new Date(2026, 7, 4, 15, 0).toISOString(),
      recurrence: 'weekly',
      byDay: [2, 9, -1, 4],
      notes: 'bring insurance card',
    });

    expect(event.id).toMatch(/^evt_[0-9a-f]{12}$/);
    expect(event.title).toBe('Dentist');
    expect(event.recurrence).toBe('weekly');
    expect(event.byDay).toEqual([2, 4]); // out-of-range weekdays dropped

    expect(client.executeQuery).toHaveBeenCalledTimes(1);
    const { cypher, params } = queries[0];
    expect(cypher).toMatch(/MERGE \(e:Event \{id: \$id\}\)/);
    expect(params.id).toBe(event.id);
    expect(params.props.source).toBe('or-desktop');
    expect(params.props.active).toBe(true);
    expect(params.props.byDay).toBe('2,4');
    expect(params.props.createdAt).toBe(NOW.toISOString());
  });

  it('defaults unknown recurrence to none', async () => {
    const event = await store.addEvent({ title: 'X', startsAt: NOW.toISOString(), recurrence: 'fortnightly' });
    expect(event.recurrence).toBe('none');
  });

  it('rejects missing title or invalid start time without touching the graph', async () => {
    await expect(store.addEvent({ title: '', startsAt: NOW.toISOString() })).rejects.toThrow(/title/);
    await expect(store.addEvent({ title: 'X', startsAt: 'garbage' })).rejects.toThrow(/start time/);
    expect(client.executeQuery).not.toHaveBeenCalled();
  });
});

describe('listEvents', () => {
  it('maps records and parses byDay CSV back to numbers', async () => {
    client.executeQuery.mockResolvedValue([
      { id: 'evt_1', title: 'Standup', startsAt: '2026-08-04T09:30:00.000Z', recurrence: 'weekly', byDay: '1,2,3', notes: '', active: true },
      { id: 'evt_2', title: 'Dentist', startsAt: '2026-08-04T15:00:00.000Z', recurrence: null, byDay: '', notes: 'x', active: true },
    ]);
    const events = await store.listEvents();
    expect(events).toHaveLength(2);
    expect(events[0].byDay).toEqual([1, 2, 3]);
    expect(events[1].recurrence).toBe('none');
    const cypher = client.executeQuery.mock.calls[0][0];
    expect(cypher).toMatch(/MATCH \(e:Event\)/);
    expect(cypher).toMatch(/coalesce\(e\.active, true\) = true/);
  });
});

describe('deleteEvent', () => {
  it('soft-deletes by id', async () => {
    client.executeQuery.mockResolvedValue([{ deleted: 1 }]);
    const out = await store.deleteEvent({ id: 'evt_1' });
    expect(out.deleted).toBe(1);
    expect(client.executeQuery.mock.calls[0][0]).toMatch(/SET e\.active = false/);
    expect(client.executeQuery.mock.calls[0][1].id).toBe('evt_1');
  });

  it('soft-deletes by case-insensitive title when no id', async () => {
    client.executeQuery.mockResolvedValue([{ deleted: 1 }]);
    await store.deleteEvent({ title: 'Dentist' });
    expect(client.executeQuery.mock.calls[0][0]).toMatch(/toLower\(e\.title\) = toLower\(\$title\)/);
  });

  it('requires an id or title', async () => {
    await expect(store.deleteEvent({})).rejects.toThrow(/id or title/);
  });
});

describe('nextEvents', () => {
  it('returns recurrence-aware upcoming occurrences, soonest first, with phrasing', async () => {
    client.executeQuery.mockResolvedValue([
      { id: 'evt_a', title: 'Dentist', startsAt: new Date(2026, 7, 4, 15, 0).toISOString(), recurrence: 'none', byDay: '', active: true },
      { id: 'evt_b', title: 'Standup', startsAt: new Date(2026, 6, 6, 9, 30).toISOString(), recurrence: 'weekly', byDay: '1,2,3,4,5', active: true },
      { id: 'evt_c', title: 'Gone', startsAt: new Date(2026, 6, 1, 9, 0).toISOString(), recurrence: 'none', byDay: '', active: true },
    ]);
    const list = await store.nextEvents(5);
    expect(list.map((e) => e.event.id)).toEqual(['evt_b', 'evt_a']);
    expect(list[0].when).toMatch(/^tomorrow at/); // Tue 9:30 from Monday 10:00
    expect(list[1].when).toMatch(/^tomorrow at/);
  });
});
