/**
 * The daily-brief contributors added on 2026-09-15 -- tickets (NEON + KV),
 * Slack, IDW feed, email nudge -- and the read-only NEON client under them.
 * Every network seam is injected; nothing here touches the wire.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../lib/log-event-queue', () => ({
  getLogQueue: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const { isReadOnlyCypher, neonRead, extractRecords } = require('../../lib/neon-read-client');
const ticketsAgent = require('../../packages/agents/tickets-agent');
const slackAgent = require('../../packages/agents/slack-agent');
const feedAgent = require('../../packages/agents/idw-feed-agent');

const NOW = new Date(2026, 8, 15, 7, 25).getTime();

describe('neon-read-client', () => {
  it('refuses writes, allows reads (string literals do not count)', () => {
    expect(isReadOnlyCypher('MATCH (t:Ticket) RETURN t')).toBe(true);
    expect(isReadOnlyCypher("MATCH (t:Ticket {title: 'Set up SSO'}) RETURN t")).toBe(true);
    expect(isReadOnlyCypher('MERGE (p:Person {id: 1})')).toBe(false);
    expect(isReadOnlyCypher('MATCH (n) SET n.x = 1')).toBe(false);
    expect(isReadOnlyCypher('MATCH (n) DETACH DELETE n')).toBe(false);
    expect(isReadOnlyCypher('')).toBe(false);
  });
  it('tags the statement, sends no password, returns the records', async () => {
    let sent;
    const fetchImpl = async (url, init) => {
      sent = { url, body: JSON.parse(init.body) };
      return { ok: true, status: 200, json: async () => ({ result: { status: 'ok', records: [{ n: 1 }] } }) };
    };
    const rows = await neonRead('MATCH (n) RETURN count(n) AS n', {}, { fetchImpl });
    expect(rows).toEqual([{ n: 1 }]);
    expect(sent.body.cypher.startsWith('/* caller:onereach-desktop-brief */\n')).toBe(true);
    expect(Object.keys(sent.body)).toEqual(['cypher', 'parameters']);
    expect(sent.url).toContain('/omnidata/neon2');
  });
  it('throws on HTTP or proxy errors and on write statements', async () => {
    await expect(neonRead('MATCH (n) RETURN n', {}, { fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }) })).rejects.toThrow(/HTTP 500/);
    await expect(neonRead('MATCH (n) RETURN n', {}, { fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ error: 'boom' }) }) })).rejects.toThrow(/boom/);
    await expect(neonRead('CREATE (n)', {}, { fetchImpl: async () => ({ ok: true }) })).rejects.toThrow(/write keyword/);
    expect(extractRecords({ records: [{ a: 1 }] })).toEqual([{ a: 1 }]);
    expect(extractRecords([{ a: 1 }])).toEqual([{ a: 1 }]);
  });
});

describe('tickets-agent.getBriefing', () => {
  afterEach(() => ticketsAgent._setBriefDepsForTests(null));

  const graphRows = [
    { id: 'tkt_1', title: 'Stage: spawnTestHarness', status: 'Open', priority: 'Medium', playbook: 'Playbook Generator Step', updated: NOW - 3600000 * 30 },
    { id: 'tkt_2', title: 'Stage: wireInputs', status: 'Open', priority: 'Medium', playbook: 'Playbook Generator Step', updated: NOW - 3600000 * 30 },
    { id: 'tkt_3', title: 'Stage: testWithUI', status: 'Open', priority: 'Medium', playbook: 'Current Weather Step', updated: NOW - 3600000 * 100 },
    { id: 'tsk_4', title: 'Add temp security to the Landing page', status: 'PENDING', priority: 'normal', section: 'inbox', updated: '2026-09-11T18:03:57.455Z' },
    { id: 'tsk_5', title: 'Build step: Lesson Plan', status: 'BLOCKED', isBlocked: true, section: 'next-actions', updated: '2026-09-07T00:00:00Z' },
  ];
  const kvRows = [{ id: 'tsk_test_1770182031', title: 'Test Ticket from LLM', status: 'pending', priority: 'normal', section: 'inbox', isCompleted: false, updatedAt: '2026-02-04T05:13:54Z' }];

  it('scopes the graph read to the user with parameters, merges KV, compresses blocked-first', async () => {
    const calls = [];
    ticketsAgent._setBriefDepsForTests({
      userId: 'robb@onereach.com',
      now: NOW,
      read: async (cypher, params) => {
        calls.push({ cypher, params });
        return graphRows;
      },
      kvAll: async () => kvRows,
    });
    const b = await ticketsAgent.getBriefing();
    expect(calls[0].params).toEqual({ user: 'robb@onereach.com', statuses: ['open', 'pending', 'in_progress', 'in progress', 'blocked'] });
    expect(calls[0].cypher).toContain('$user IN creators');
    expect(calls[0].cypher).not.toContain('robb@');
    expect(b.section).toBe('Tickets');
    expect(b.headline).toBe('6 open tickets (3 pipeline build stages), 1 blocked');
    expect(b.counts).toMatchObject({ open: 6, blocked: 1, stages: 3, playbooksWithStages: 2, graph: 5, tms: 1 });
    expect(b.items[0]).toMatchObject({ kind: 'blocked', spoken: 'Build step: Lesson Plan is blocked.' });
    expect(b.items[0].line).toMatch(/^Blocked · Build step: Lesson Plan · \d+ days ago$/);
    expect(b.items[1].line).toMatch(/^Pending · Add temp security to the Landing page · \d+ days ago$/);
    expect(b.items.find((i) => i.kind === 'stages').line).toBe('Playbook Generator Step · 2 build stage tickets open (spawnTestHarness, wireInputs)');
    expect(b.content).toContain('Open items (blocked first, then most recent):');
  });

  it('no signed-in user -> says so, reads nothing', async () => {
    const read = vi.fn();
    ticketsAgent._setBriefDepsForTests({ userId: null, read });
    const b = await ticketsAgent.getBriefing();
    expect(read).not.toHaveBeenCalled();
    expect(b.content).toMatch(/can't tell which tickets are yours/);
  });

  it('graph down + KV empty -> unavailable line; graph down + KV rows -> still briefs', async () => {
    ticketsAgent._setBriefDepsForTests({ userId: 'u', read: async () => { throw new Error('neon 500'); }, kvAll: async () => [] });
    expect((await ticketsAgent.getBriefing()).content).toMatch(/unavailable/);
    ticketsAgent._setBriefDepsForTests({ userId: 'u', now: NOW, read: async () => { throw new Error('neon 500'); }, kvAll: async () => kvRows });
    const b = await ticketsAgent.getBriefing();
    expect(b.headline).toBe('1 open ticket, none blocked');
  });

  it('compressTickets dedupes ids across stores and names the stage groups once', () => {
    const s = ticketsAgent._compressTickets([{ id: 'a', title: 'Stage: x', status: 'Open', playbook: 'P' }, { id: 'a', title: 'Stage: x', status: 'Open', playbook: 'P' }], [{ id: 'a', title: 'dup', status: 'pending' }], { now: NOW });
    expect(s.counts.open).toBe(1);
    expect(s.headline).toBe('1 open ticket, all of them pipeline build stages, none blocked');
  });
});

describe('slack-agent', () => {
  afterEach(() => slackAgent._setDepsForTests(null));

  it('without a token: one honest line, no network', async () => {
    const fetchImpl = vi.fn();
    slackAgent._setDepsForTests({ token: null, fetchImpl });
    const b = await slackAgent.getBriefing();
    expect(b.section).toBe('Slack');
    expect(b.notConnected).toBe(true);
    expect(b.content).toMatch(/slackUserToken/);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await slackAgent.execute({ content: 'any mentions?' })).toMatchObject({ success: true, message: expect.stringContaining("isn't connected") });
  });

  it('with a token: mentions + DMs compressed to items', async () => {
    const sinceSec = Math.floor((NOW - 16 * 3600000) / 1000);
    const fetchImpl = async (url) => {
      const u = new URL(url);
      const m = u.pathname.split('/').pop();
      const ok = (data) => ({ ok: true, status: 200, json: async () => ({ ok: true, ...data }) });
      if (m === 'auth.test') return ok({ user_id: 'U1' });
      if (m === 'search.messages') {
        expect(u.searchParams.get('query')).toMatch(/^<@U1> after:\d{4}-\d{2}-\d{2}$/);
        return ok({ messages: { matches: [{ user: 'U2', username: 'antony', text: '<@U1> can you review the PR?', ts: String(sinceSec + 100), channel: { name: 'idw-sync' } }, { user: 'U1', text: 'mine', ts: String(sinceSec + 200), channel: { name: 'x' } }] } });
      }
      if (m === 'conversations.list') return ok({ channels: [{ id: 'D1', user: 'U3' }, { id: 'D2', user: 'U4', is_user_deleted: true }] });
      if (m === 'conversations.history') return ok({ messages: [{ user: 'U3', text: 'ping about the demo', ts: String(sinceSec + 300) }, { user: 'U1', text: 'me', ts: String(sinceSec + 301) }] });
      if (m === 'users.info') return ok({ user: { real_name: 'Oleksandra H', profile: { display_name: 'oleksandra' } } });
      throw new Error(`unexpected ${m}`);
    };
    slackAgent._setDepsForTests({ token: 'xoxp-test', fetchImpl, now: NOW });
    const b = await slackAgent.getBriefing();
    expect(b.headline).toBe('1 mention, 1 DM waiting');
    expect(b.items[0].line).toMatch(/^#idw-sync · antony: “@someone can you review the PR\?” · \d+ hrs? ago$/);
    expect(b.items[0].spoken).toBe('antony mentioned you in idw-sync: @someone can you review the PR?.');
    expect(b.items[1].line).toMatch(/^DM · oleksandra: “ping about the demo”/);
  });

  it('compressSlack with nothing new', () => {
    const s = slackAgent._compressSlack({ mentions: [], dms: [] }, { now: NOW });
    expect(s.headline).toBe('Nothing new on Slack');
    expect(s.items).toEqual([]);
  });
});

describe('idw-feed-agent', () => {
  afterEach(() => feedAgent._setDepsForTests(null));

  const rss = (items) => `<?xml version="1.0"?><rss version="2.0"><channel><title>T</title>${items
    .map((i) => `<item><title><![CDATA[${i.title}]]></title><link>${i.link}</link><pubDate>${i.date}</pubDate><description><![CDATA[<p>${i.desc || ''}</p>]]></description></item>`)
    .join('')}</channel></rss>`;

  it('parses RSS, prefers fresh articles, one { line, spoken } per article', async () => {
    const fresh = new Date(NOW - 5 * 3600000).toUTCString();
    const old = new Date(NOW - 30 * 24 * 3600000).toUTCString();
    const fetchImpl = async (url) => ({
      ok: true,
      status: 200,
      text: async () =>
        url.includes('uxmag')
          ? rss([{ title: 'Designing for agents', link: 'https://uxmag.com/a', date: fresh }])
          : rss([{ title: 'Old post', link: 'https://onereach.ai/b', date: old }, { title: 'New post &amp; more', link: 'https://onereach.ai/c', date: fresh }]),
    });
    feedAgent._setDepsForTests({ fetchImpl, now: NOW });
    const b = await feedAgent.getBriefing();
    expect(b.section).toBe('Feed');
    expect(b.headline).toBe('2 new articles in the last 2 days');
    expect(b.items.map((i) => i.line)).toEqual(['UX Magazine · Designing for agents · 5 hrs ago', 'OneReach · New post & more · 5 hrs ago']);
    expect(b.items[0].spoken).toBe('From UX Magazine: Designing for agents.');
  });

  it('nothing fresh -> latest few, labelled as such; all feeds down -> section omitted', async () => {
    const old = new Date(NOW - 30 * 24 * 3600000).toUTCString();
    feedAgent._setDepsForTests({ fetchImpl: async () => ({ ok: true, status: 200, text: async () => rss([{ title: 'Old', link: 'x', date: old }]) }), now: NOW });
    const b = await feedAgent.getBriefing();
    expect(b.headline).toMatch(/^Nothing new in the last 2 days; latest from/);
    feedAgent._setDepsForTests({ fetchImpl: async () => { throw new Error('offline'); } });
    expect((await feedAgent.getBriefing()).content).toBeNull();
  });

  it('parses Atom too', () => {
    const atom = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Atom entry</title><link href="https://x/1"/><updated>2026-09-15T10:00:00Z</updated><summary>s</summary></entry></feed>`;
    const out = feedAgent._parseFeed(atom);
    expect(out).toEqual([{ title: 'Atom entry', link: 'https://x/1', publishedMs: Date.parse('2026-09-15T10:00:00Z'), summary: 's' }]);
  });

  it('execute with empty input never fetches', async () => {
    const fetchImpl = vi.fn();
    feedAgent._setDepsForTests({ fetchImpl });
    const r = await feedAgent.execute({ content: '' });
    expect(r.success).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('email-agent.getBriefing when not connected', () => {
  it('says how to connect instead of vanishing', async () => {
    const emailAgent = require('../../packages/agents/email-agent');
    const b = await emailAgent.getBriefing();
    expect(b.section).toBe('Email');
    // Either a real summary (if an inbox is configured in this environment)
    // or the nudge -- never null.
    expect(typeof b.content).toBe('string');
    if (b.notConnected) expect(b.content).toMatch(/set up email/);
  });
});
