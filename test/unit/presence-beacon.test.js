/**
 * ADR-064 — presence beacon: the "who is doing what" standard. Pins
 * the graph now-snapshot shape (TTL doctrine, facet merge semantics,
 * the Person-never-touched rule), the temporal KV log the graph
 * points to (append/prune/cap, heartbeats never write it), identity
 * gating, and the never-throws contract.
 */
import { describe, it, expect } from 'vitest';

import {
  beat,
  clear,
  listPresence,
  readPresenceLog,
  presenceStatus,
  presenceId,
  presenceLogRef,
  PRESENCE_ACTIVE_MS,
  PRESENCE_IDLE_MS,
  PRESENCE_LOG_COLLECTION,
} from '../../lib/presence-beacon.js';

const NOW = 1786600000000;

/** Route-aware fetch stub: neon POSTs vs KV GET/PUTs, both captured. */
function buildStub({ kvValue = null, presenceRows = [] } = {}) {
  const cypher = [];
  const kv = [];
  const fetchImpl = async (url, init = {}) => {
    if (String(url).includes('/omnidata/neon')) {
      const body = JSON.parse(init.body);
      cypher.push(body);
      return { ok: true, json: async () => ({ records: presenceRows }) };
    }
    kv.push({ url: String(url), method: init.method || 'GET', body: init.body });
    if ((init.method || 'GET') === 'GET') {
      return {
        ok: true,
        text: async () => (kvValue === null ? '' : JSON.stringify({ value: JSON.stringify(kvValue) })),
      };
    }
    return { ok: true, text: async () => '' };
  };
  return { fetchImpl, cypher, kv };
}

describe('beat — graph now-snapshot', () => {
  it('MERGEs the Presence node with TTL sweep, KV pointer, and facet merge — never touching the Person', async () => {
    const { fetchImpl, cypher } = buildStub();
    const r = await beat({
      personId: 'robb@onereach.com',
      appId: 'onereach-lite',
      appName: 'Onereach.ai Lite',
      facets: { tool: 'spaces' },
      fetchImpl,
      nowMs: NOW,
    });
    expect(r.ok).toBe(true);
    expect(cypher).toHaveLength(1);
    const q = cypher[0].cypher;
    expect(q).toContain('MERGE (pr:Presence {id: $id})');
    expect(q).toContain('SET pr += $facets');
    expect(q).toContain('MERGE (pr)-[:PRESENCE_OF]->(p)');
    expect(q).toContain('DETACH DELETE stale');
    // Heartbeats must never pong ADR-060 recency: the Person is
    // MERGEd for the edge and NOTHING is ever set on it.
    expect(q).not.toMatch(/SET p\./);
    expect(q).not.toContain('p.updated');
    expect(cypher[0].parameters).toMatchObject({
      id: presenceId('robb@onereach.com', 'onereach-lite'),
      kvCollection: PRESENCE_LOG_COLLECTION,
      kvRef: presenceLogRef('robb@onereach.com', 'onereach-lite'),
      facets: { tool: 'spaces' },
    });
  });

  it('drops facets outside the allow-list and stamps lastActionAt with lastAction', async () => {
    const { fetchImpl, cypher } = buildStub();
    await beat({
      personId: 'r@x.y',
      appId: 'a',
      facets: { lastAction: 'edited “Roadmap”', evil: 'nope' },
      fetchImpl,
      nowMs: NOW,
    });
    const facets = cypher[0].parameters.facets;
    expect(facets.lastAction).toBe('edited “Roadmap”');
    expect(facets.lastActionAt).toBe(NOW);
    expect('evil' in facets).toBe(false);
  });

  it('null facets pass through (Cypher += removes them: "left the meeting")', async () => {
    const { fetchImpl, cypher } = buildStub();
    await beat({
      personId: 'r@x.y',
      appId: 'a',
      facets: { meetingRoom: null },
      fetchImpl,
      nowMs: NOW,
    });
    expect(cypher[0].parameters.facets).toEqual({ meetingRoom: null });
  });

  it('no identity → no traffic at all; network failure → {ok:false}, never throws', async () => {
    const { fetchImpl, cypher, kv } = buildStub();
    expect((await beat({ personId: '', appId: 'a', fetchImpl })).ok).toBe(false);
    expect(cypher).toHaveLength(0);
    expect(kv).toHaveLength(0);
    const failing = async () => {
      throw new Error('offline');
    };
    const r = await beat({ personId: 'r@x.y', appId: 'a', fetchImpl: failing, nowMs: NOW });
    expect(r).toMatchObject({ ok: false, error: 'offline' });
  });
});

describe('temporal KV log — the graph just points at it', () => {
  it('a bare heartbeat writes the graph only (no KV traffic)', async () => {
    const { fetchImpl, cypher, kv } = buildStub();
    await beat({ personId: 'r@x.y', appId: 'a', fetchImpl, nowMs: NOW });
    expect(cypher).toHaveLength(1);
    expect(kv).toHaveLength(0);
  });

  it('a meaningful beat appends {at, ...facets} to the rolling log', async () => {
    const { fetchImpl, kv } = buildStub({
      kvValue: { personId: 'r@x.y', appId: 'a', entries: [{ at: NOW - 1000, tool: 'spaces' }] },
    });
    await beat({
      personId: 'r@x.y',
      appId: 'a',
      facets: { tool: 'meeting' },
      fetchImpl,
      nowMs: NOW,
    });
    const put = kv.find((c) => c.method === 'PUT');
    expect(put).toBeDefined();
    const stored = JSON.parse(JSON.parse(put.body).itemValue);
    expect(stored.entries).toHaveLength(2);
    expect(stored.entries[1]).toMatchObject({ at: NOW, tool: 'meeting' });
  });

  it('the log prunes by age and caps entry count', async () => {
    const bloated = Array.from({ length: 260 }, (_, i) => ({ at: NOW - i * 1000, n: String(i) }));
    bloated.push({ at: NOW - 48 * 60 * 60 * 1000, n: 'ancient' });
    const { fetchImpl, kv } = buildStub({ kvValue: { entries: bloated } });
    await beat({ personId: 'r@x.y', appId: 'a', facets: { tool: 'x' }, fetchImpl, nowMs: NOW });
    const stored = JSON.parse(JSON.parse(kv.find((c) => c.method === 'PUT').body).itemValue);
    expect(stored.entries.length).toBeLessThanOrEqual(200);
    expect(stored.entries.some((e) => e.n === 'ancient')).toBe(false);
  });

  it('readPresenceLog returns newest-first and never throws', async () => {
    const { fetchImpl } = buildStub({
      kvValue: { entries: [{ at: 1 }, { at: 2 }, { at: 3 }] },
    });
    const entries = await readPresenceLog('r@x.y', 'a', { fetchImpl });
    expect(entries.map((e) => e.at)).toEqual([3, 2, 1]);
    const failing = async () => {
      throw new Error('down');
    };
    expect(await readPresenceLog('r@x.y', 'a', { fetchImpl: failing })).toEqual([]);
  });
});

describe('read side — TTL classification', () => {
  it('presenceStatus: active < 3m, idle < 30m, gone after', () => {
    expect(presenceStatus(NOW - 1000, NOW)).toBe('active');
    expect(presenceStatus(NOW - PRESENCE_ACTIVE_MS - 1, NOW)).toBe('idle');
    expect(presenceStatus(NOW - PRESENCE_IDLE_MS - 1, NOW)).toBe('gone');
    expect(presenceStatus(undefined, NOW)).toBe('gone');
  });

  it('listPresence TTL-gates in Cypher and stamps status per row', async () => {
    const { fetchImpl, cypher } = buildStub({
      presenceRows: [
        { id: 'presence_r_a', personId: 'r@x.y', lastSeenAt: NOW - 1000, appId: 'a' },
        { id: 'presence_r_b', personId: 'r@x.y', lastSeenAt: NOW - 10 * 60 * 1000, appId: 'b' },
      ],
    });
    const rows = await listPresence({ fetchImpl, nowMs: NOW });
    expect(cypher[0].cypher).toContain('coalesce(pr.lastSeenAt, 0) > $nowMs - $windowMs');
    expect(rows[0].status).toBe('active');
    expect(rows[1].status).toBe('idle');
  });

  it('clear deletes the beacon eagerly', async () => {
    const { fetchImpl, cypher } = buildStub();
    await clear({ personId: 'r@x.y', appId: 'a', fetchImpl, nowMs: NOW });
    expect(cypher[0].cypher).toContain('DETACH DELETE pr');
    expect(cypher[0].parameters.id).toBe('presence_r@x.y_a');
  });
});
