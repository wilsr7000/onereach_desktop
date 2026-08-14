/**
 * ADR-061 — meeting-graph bridge: completed WISER meetings mirror into
 * the SHARED account graph in exactly the shape Lite's ADR-058/059/060
 * read paths expect. These tests pin the wire contract (Edison neon
 * proxy body), the node/edge/commit shapes, idempotency-by-MERGE, the
 * transcript gates, and the never-throws contract.
 */
import { describe, it, expect } from 'vitest';

import {
  pushMeetingToSharedGraph,
  buildMeetingContent,
  meetingTitle,
  MEETINGS_SPACE,
  SHARED_GRAPH,
  MAX_TRANSCRIPT_CHARS,
} from '../../lib/meeting/meeting-graph-bridge.js';

/** Capture every proxy POST; script per-call responses by cypher substring. */
function buildFetchStub(responders = []) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body });
    for (const [needle, rows] of responders) {
      if (body.cypher.includes(needle)) {
        return { ok: true, json: async () => ({ records: rows }) };
      }
    }
    return { ok: true, json: async () => ({ records: [] }) };
  };
  return { calls, fetchImpl };
}

function meetingFixture(overrides = {}) {
  return {
    id: 'MTG-1',
    calendar: { vevent: { summary: 'Weekly Sync' } },
    contacts: [{ displayName: 'Robb' }, { displayName: 'Ada' }],
    during: { actualDuration: 42 },
    post: {
      summary: 'We aligned on the launch.',
      decisions: ['Ship Tier 2 first'],
      actionItems: [{ text: 'Cut the release', assignee: 'Robb' }],
    },
    ...overrides,
  };
}

const NOW = 1786500000000;

describe('meeting-graph bridge wire contract', () => {
  it('POSTs to the shared neon proxy with in-body credentials', async () => {
    const { calls, fetchImpl } = buildFetchStub();
    await pushMeetingToSharedGraph({ meeting: meetingFixture(), fetchImpl, nowMs: NOW });
    expect(calls.length).toBeGreaterThan(0);
    const first = calls[0];
    expect(first.url).toBe(SHARED_GRAPH.endpoint);
    expect(first.body).toMatchObject({
      neonUri: SHARED_GRAPH.uri,
      neonUser: SHARED_GRAPH.user,
      neonPassword: SHARED_GRAPH.password,
      database: SHARED_GRAPH.database,
    });
  });

  it('reuses an existing live Space named "WISER Meetings" instead of MERGEing its own', async () => {
    const { calls, fetchImpl } = buildFetchStub([
      ['toLower(coalesce(s.name', [{ id: 'user-made-space' }]],
    ]);
    await pushMeetingToSharedGraph({ meeting: meetingFixture(), fetchImpl, nowMs: NOW });
    expect(calls.some((c) => c.body.cypher.includes('MERGE (s:Space {id: $id})'))).toBe(false);
    const meetingCall = calls.find((c) => c.body.cypher.includes('SET a:Meeting'));
    expect(meetingCall?.body.parameters).toMatchObject({ spaceId: 'user-made-space' });
  });

  it('creates the deterministic landing Space when none exists', async () => {
    const { calls, fetchImpl } = buildFetchStub();
    await pushMeetingToSharedGraph({ meeting: meetingFixture(), fetchImpl, nowMs: NOW });
    const ensure = calls.find((c) => c.body.cypher.includes('MERGE (s:Space {id: $id})'));
    expect(ensure?.body.parameters).toMatchObject({
      id: MEETINGS_SPACE.id,
      name: MEETINGS_SPACE.name,
    });
  });
});

describe('meeting node shape (what Lite renders)', () => {
  async function meetingCall(transcriptText) {
    const { calls, fetchImpl } = buildFetchStub();
    await pushMeetingToSharedGraph({
      meeting: meetingFixture(),
      transcriptText,
      fetchImpl,
      nowMs: NOW,
    });
    return { calls, call: calls.find((c) => c.body.cypher.includes('SET a:Meeting')) };
  }

  it('MERGEs a dual-label :Asset:Meeting with both membership edges and dual-convention stamps', async () => {
    const { call } = await meetingCall();
    expect(call).toBeDefined();
    const q = call.body.cypher;
    expect(q).toContain('MERGE (a:Asset {id: $id})');
    expect(q).toContain('SET a:Meeting');
    expect(q).toContain('MERGE (a)-[:BELONGS_TO]->(s)');
    expect(q).toContain('MERGE (s)-[:CONTAINS]->(a)');
    expect(q).toContain('a.updatedAt = $nowMs');
    expect(q).toContain('a.updated_at = $nowMs');
    expect(call.body.parameters).toMatchObject({
      id: 'meeting_MTG-1',
      title: 'Weekly Sync',
      kind: 'text',
      nowMs: NOW,
    });
  });

  it('announces via an idempotent item:added Commit (deterministic hash)', async () => {
    const { call } = await meetingCall();
    expect(call.body.cypher).toContain("c.message = 'item:added'");
    expect(call.body.parameters['commitHash']).toBe('meeting-add-meeting_MTG-1');
  });

  it('meeting content carries summary, decisions, and action items', () => {
    const md = buildMeetingContent(meetingFixture(), 'Weekly Sync');
    expect(md).toContain('## Summary');
    expect(md).toContain('We aligned on the launch.');
    expect(md).toContain('- Ship Tier 2 first');
    expect(md).toContain('- [ ] Cut the release — Robb');
    expect(md).toContain('**Participants:** Robb, Ada');
  });

  it('falls back to a dated title when the calendar has none', () => {
    expect(meetingTitle({}, NOW)).toBe(`Meeting ${new Date(NOW).toISOString().slice(0, 10)}`);
  });
});

describe('transcript + recording artifacts', () => {
  it('pushes the transcript as :Asset:Transcript linked via HAS_TRANSCRIPT', async () => {
    const { calls, fetchImpl } = buildFetchStub();
    await pushMeetingToSharedGraph({
      meeting: meetingFixture(),
      transcriptText: 'line one\n'.repeat(20),
      fetchImpl,
      nowMs: NOW,
    });
    const t = calls.find((c) => c.body.cypher.includes('SET a:Transcript'));
    expect(t).toBeDefined();
    expect(t.body.cypher).toContain('MERGE (m)-[:HAS_TRANSCRIPT]->(a)');
    expect(t.body.parameters).toMatchObject({
      id: 'transcript_MTG-1',
      kind: 'transcript',
      meetingNodeId: 'meeting_MTG-1',
    });
  });

  it('skips transcripts under the minimum length', async () => {
    const { calls, fetchImpl } = buildFetchStub();
    const result = await pushMeetingToSharedGraph({
      meeting: meetingFixture(),
      transcriptText: 'too short',
      fetchImpl,
      nowMs: NOW,
    });
    expect(result.ok).toBe(true);
    expect(result.pushed.transcript).toBeNull();
    expect(calls.some((c) => c.body.cypher.includes('SET a:Transcript'))).toBe(false);
  });

  it('caps marathon transcripts at MAX_TRANSCRIPT_CHARS', async () => {
    const { calls, fetchImpl } = buildFetchStub();
    await pushMeetingToSharedGraph({
      meeting: meetingFixture(),
      transcriptText: 'x'.repeat(MAX_TRANSCRIPT_CHARS + 5000),
      fetchImpl,
      nowMs: NOW,
    });
    const t = calls.find((c) => c.body.cypher.includes('SET a:Transcript'));
    expect(String(t.body.parameters['content']).length).toBe(MAX_TRANSCRIPT_CHARS);
  });

  it('recording stubs link via HAS_RECORDING without a feed commit', async () => {
    const { calls, fetchImpl } = buildFetchStub();
    const result = await pushMeetingToSharedGraph({
      meeting: meetingFixture(),
      recordingItemIds: ['rec-item-9'],
      fetchImpl,
      nowMs: NOW,
    });
    const r = calls.find((c) => c.body.cypher.includes('SET a:Recording'));
    expect(r).toBeDefined();
    expect(r.body.cypher).toContain('MERGE (m)-[:HAS_RECORDING]->(a)');
    expect(r.body.cypher).not.toContain('item:added');
    expect(r.body.parameters['commitHash']).toBeUndefined();
    expect(result.pushed.recordings).toEqual(['recording_rec-item-9']);
  });
});

describe('resilience contract', () => {
  it('never throws — a proxy outage returns {ok:false} instead', async () => {
    const failing = async () => {
      throw new Error('network down');
    };
    const result = await pushMeetingToSharedGraph({
      meeting: meetingFixture(),
      fetchImpl: failing,
      nowMs: NOW,
    });
    expect(result).toMatchObject({ ok: false, error: 'network down' });
  });

  it('rejects a meeting without an id (no writes attempted)', async () => {
    const { calls, fetchImpl } = buildFetchStub();
    const result = await pushMeetingToSharedGraph({ meeting: {}, fetchImpl, nowMs: NOW });
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

// ─── ADR-062: the meeting ring signal ────────────────────────────────────

import {
  announceMeetingLive,
  endMeetingLive,
  prettyRoomTitle,
} from '../../lib/meeting/meeting-graph-bridge.js';

describe('ADR-062 ring signal', () => {
  it('announce MERGEs an ephemeral :MeetingLive (no :Asset, no membership) and sweeps stale ones', async () => {
    const { calls, fetchImpl } = buildFetchStub();
    const r = await announceMeetingLive({
      roomName: 'weekly-sync-a1b2c3',
      joinUrl: 'https://guest/join.html?room=weekly-sync-a1b2c3#k=PUB',
      host: 'Robb',
      fetchImpl,
      nowMs: NOW,
    });
    expect(r.ok).toBe(true);
    const call = calls.find((c) => c.body.cypher.includes('MERGE (m:MeetingLive'));
    expect(call).toBeDefined();
    const q = call.body.cypher;
    expect(q).not.toContain(':Asset');
    expect(q).not.toContain('BELONGS_TO');
    expect(q).toContain('m.startedAt = coalesce(m.startedAt, $nowMs)');
    expect(q).toContain('DETACH DELETE old');
    expect(call.body.parameters).toMatchObject({
      id: 'live_weekly-sync-a1b2c3',
      title: 'Weekly Sync',
      host: 'Robb',
    });
  });

  it('re-announcing preserves startedAt semantics via coalesce (idempotent MERGE on id)', async () => {
    const { calls, fetchImpl } = buildFetchStub();
    await announceMeetingLive({ roomName: 'r-1', fetchImpl, nowMs: NOW });
    await announceMeetingLive({ roomName: 'r-1', fetchImpl, nowMs: NOW + 1000 });
    const merges = calls.filter((c) => c.body.cypher.includes('MERGE (m:MeetingLive'));
    expect(merges).toHaveLength(2);
    expect(merges[0].body.parameters['id']).toBe(merges[1].body.parameters['id']);
  });

  it('end deletes the signal; both paths never throw on outage', async () => {
    const { calls, fetchImpl } = buildFetchStub();
    const r = await endMeetingLive('weekly-sync-a1b2c3', { fetchImpl });
    expect(r.ok).toBe(true);
    const del = calls.find((c) => c.body.cypher.includes('DETACH DELETE m'));
    expect(del?.body.parameters).toMatchObject({ id: 'live_weekly-sync-a1b2c3' });
    const failing = async () => {
      throw new Error('down');
    };
    expect((await announceMeetingLive({ roomName: 'x', fetchImpl: failing })).ok).toBe(false);
    expect((await endMeetingLive('x', { fetchImpl: failing })).ok).toBe(false);
  });

  it('prettyRoomTitle strips the space-hash salt and title-cases', () => {
    expect(prettyRoomTitle('weekly-sync-a1b2c3')).toBe('Weekly Sync');
    expect(prettyRoomTitle('design_review-9f8e7d6c')).toBe('Design Review');
    expect(prettyRoomTitle('')).toBe('Meeting');
    expect(prettyRoomTitle(undefined)).toBe('Meeting');
  });
});

// ═══════════════════════════════════════════════════════════════════
// RING ACCESS GRANTS — "inviting" someone IS making them a member of the
// WISER Meetings Space (ADR-065: the doorbell rings members only). These
// pin the wire contract: normalized deduped emails, HAS_ACCESS MERGE with
// no expiry (GRANT_LIVE passes on expiresUnixMs IS NULL), never throws.
// ═══════════════════════════════════════════════════════════════════

import { grantMeetingRingAccess } from '../../lib/meeting/meeting-graph-bridge.js';

describe('grantMeetingRingAccess (the invite half of the meeting ring)', () => {
  it('grants HAS_ACCESS on the WISER Meetings space for each invitee email', async () => {
    const { calls, fetchImpl } = buildFetchStub();
    const out = await grantMeetingRingAccess(
      ['Erika@Example.com', 'jonas@example.com', 'erika@example.com ', 'not-an-email'],
      { fetchImpl, nowMs: NOW, grantedBy: 'robb@onereach.com' }
    );
    expect(out.ok).toBe(true);
    expect(out.granted).toBe(2); // normalized + deduped, non-email dropped

    const grant = calls.find((c) => c.body.cypher.includes('HAS_ACCESS'));
    expect(grant).toBeTruthy();
    expect(grant.body.parameters.spaceId).toBe(MEETINGS_SPACE.id);
    expect(grant.body.parameters.emails).toEqual(['erika@example.com', 'jonas@example.com']);
    expect(grant.body.parameters.grantedBy).toBe('robb@onereach.com');
    // No expiry property is ever set -- GRANT_LIVE must pass on NULL.
    expect(grant.body.cypher).not.toContain('expiresUnixMs');
    // The space is ensured before granting into it.
    expect(calls.findIndex((c) => c.body.cypher.includes('MERGE (s:Space'))).toBeLessThan(
      calls.indexOf(grant)
    );
  });

  it('is a no-op without valid emails (no network at all)', async () => {
    const { calls, fetchImpl } = buildFetchStub();
    const out = await grantMeetingRingAccess(['', 'nope', null], { fetchImpl, nowMs: NOW });
    expect(out).toEqual({ ok: true, granted: 0 });
    expect(calls).toHaveLength(0);
  });

  it('never throws: a proxy failure returns ok:false', async () => {
    const fetchImpl = async () => {
      throw new Error('graph unreachable');
    };
    const out = await grantMeetingRingAccess(['a@b.com'], { fetchImpl, nowMs: NOW });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/unreachable/);
  });
});

// ═══════════════════════════════════════════════════════════════════
// PER-MEETING RING AUDIENCE — the doorbell rings host + explicit invitees
// ONLY (sticky space membership must never be the invite list).
// ═══════════════════════════════════════════════════════════════════

// announceMeetingLive already imported by the ADR-062 block above.
import { addLiveInvitees, listInvitablePeople } from '../../lib/meeting/meeting-graph-bridge.js';

describe('per-meeting ring audience', () => {
  it('announce stores normalized invitees + hostId on the live node', async () => {
    const { calls, fetchImpl } = buildFetchStub();
    await announceMeetingLive({
      roomName: 'product-abc123',
      joinUrl: 'https://x/join.html?room=product-abc123',
      hostId: 'Robb@OneReach.com',
      invitees: ['Erika@Example.com', 'erika@example.com', 'jonas@example.com', 'nope'],
      fetchImpl,
      nowMs: NOW,
    });
    const announce = calls.find((c) => c.body.cypher.includes('MERGE (m:MeetingLive'));
    expect(announce).toBeTruthy();
    expect(announce.body.parameters.hostId).toBe('robb@onereach.com');
    expect(announce.body.parameters.invitees).toEqual(['erika@example.com', 'jonas@example.com']);
    expect(announce.body.cypher).toContain('m.invitees = $invitees');
    expect(announce.body.cypher).toContain('m.hostId = $hostId');
  });

  it('announce without invitees stores an EMPTY audience (fail-closed), never null', async () => {
    const { calls, fetchImpl } = buildFetchStub();
    await announceMeetingLive({ roomName: 'r1', fetchImpl, nowMs: NOW });
    const announce = calls.find((c) => c.body.cypher.includes('MERGE (m:MeetingLive'));
    expect(announce.body.parameters.invitees).toEqual([]);
  });

  it('addLiveInvitees appends deduped emails to the live audience', async () => {
    const { calls, fetchImpl } = buildFetchStub();
    const out = await addLiveInvitees('product-abc123', ['New@Person.com', 'new@person.com'], {
      fetchImpl,
      nowMs: NOW,
    });
    expect(out.ok).toBe(true);
    expect(out.added).toBe(1);
    const upd = calls.find((c) => c.body.cypher.includes('m.invitees ='));
    expect(upd.body.parameters.id).toBe('live_product-abc123');
    expect(upd.body.parameters.emails).toEqual(['new@person.com']);
    // Cypher-side dedupe: existing entries matching new ones are removed first.
    expect(upd.body.cypher).toContain('WHERE NOT x IN $emails');
  });

  it('listInvitablePeople scopes to space members and maps rows', async () => {
    const { calls, fetchImpl } = buildFetchStub([
      ['MATCH (p:Person)-[:HAS_ACCESS]', [
        { email: 'erika@example.com', name: 'Erika' },
        { email: 'svc-bot@example.com', name: 'svc-bot' },
      ]],
    ]);
    const out = await listInvitablePeople({ spaceId: 'space-1', fetchImpl, nowMs: NOW });
    expect(out.ok).toBe(true);
    const q = calls[0].body;
    expect(q.cypher).toContain('HAS_ACCESS');
    expect(q.parameters.spaceId).toBe('space-1');
    // Humans-only filter applies (service identities dropped).
    expect(out.people.map((p) => p.email)).toContain('erika@example.com');
  });

  it('listInvitablePeople never throws — outage yields an empty list', async () => {
    const out = await listInvitablePeople({
      fetchImpl: async () => { throw new Error('down'); },
      nowMs: NOW,
    });
    expect(out.ok).toBe(false);
    expect(out.people).toEqual([]);
  });
});

describe('invite roster hygiene (live-test findings)', () => {
  it('excludes the host and anonymous@ service identities from the picker', async () => {
    const { fetchImpl } = buildFetchStub([
      ['MATCH (p:Person)', [
        { email: 'robb@onereach.com', name: 'robb' },
        { email: 'anonymous@playbooks.app', name: 'anonymous@playbooks.app' },
        { email: 'erika@example.com', name: 'Erika' },
      ]],
    ]);
    const out = await listInvitablePeople(
      { excludeEmails: ['Robb@OneReach.com'], fetchImpl, nowMs: NOW }
    );
    expect(out.people.map((p) => p.email)).toEqual(['erika@example.com']);
  });
});
