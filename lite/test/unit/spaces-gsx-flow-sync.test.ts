/**
 * runGsxFlowSync — GSX Designer bots → Spaces, flows → agent assets
 * (ADR-091). Driven with a fake port + fake client; no graph, no GSX.
 */
import { describe, it, expect } from 'vitest';
import {
  runGsxFlowSync,
  gsxSyncIds,
  legacyGsxSyncIds,
  shortHash,
  designerFlowUrl,
  actionDeskViewUrl,
  viewsByFlow,
  flowAgentContent,
  isGraphOutage,
  GSX_DESIGNER_GROUP,
  type GsxFlowSyncDeps,
  type GsxFlowSyncClient,
} from '../../spaces/gsx-flow-sync.js';
import { GsxFlowsError, type GsxBot, type GsxFlow, type GsxView } from '../../spaces/gsx-flows-port.js';

interface Rec {
  spaces: Array<Parameters<GsxFlowSyncClient['upsertGsxFlowSpace']>[0]>;
  agents: Array<Parameters<GsxFlowSyncClient['upsertGsxFlowAgents']>[2][number] & { spaceId: string; gsxBotId: string }>;
  retired: string[];
  spans: string[];
  warns: string[];
  /** Designer reads (listBots calls) — a sweep that stood down makes none. */
  botsListed: number;
  /** Graph pings made. */
  pings: number;
}

function makeDeps(over: {
  bots?: GsxBot[] | Error;
  flows?: Record<string, GsxFlow[] | Error>;
  existing?: Record<string, Array<{ assetId: string; gsxFlowId: string }>>;
  takenNames?: string[];
  viewer?: string | null;
  dryRun?: boolean;
  createdSpaces?: Set<string>;
  views?: GsxView[] | Error;
  accountId?: string;
  ownSpaces?: Record<string, { id: string; name: string }>;
  /** Graph liveness: omitted = no ping method (older client); boolean = answer; Error = ping throws. */
  ping?: boolean | Error;
  /** Bot ids whose Space upsert throws this error (graph failure injection). */
  spaceUpsertFails?: Record<string, Error>;
} = {}): { deps: GsxFlowSyncDeps; rec: Rec } {
  const rec: Rec = { spaces: [], agents: [], retired: [], spans: [], warns: [], botsListed: 0, pings: 0 };
  const bots = over.bots ?? [];
  const client: GsxFlowSyncClient = {
    async upsertGsxFlowSpace(input) {
      const fail = over.spaceUpsertFails?.[input.gsxBotId];
      if (fail !== undefined) throw fail;
      rec.spaces.push(input);
      return { id: input.id, created: !(over.createdSpaces?.has(input.id) ?? false) };
    },
    async spaceNameTaken(name) {
      return (over.takenNames ?? []).includes(name);
    },
    async upsertGsxFlowAgents(spaceId, gsxBotId, rows) {
      for (const r of rows) rec.agents.push({ ...r, spaceId, gsxBotId });
      return rows.map((r) => ({ id: r.assetId, created: true }));
    },
    async listGsxFlowAgents(spaceId) {
      return over.existing?.[spaceId] ?? [];
    },
    async retireGsxFlowAgent(assetId) {
      rec.retired.push(assetId);
      return true;
    },
    ...(over.ownSpaces !== undefined
      ? { async spaceByGsxBotId(botId: string) { return over.ownSpaces?.[botId] ?? null; } }
      : {}),
    ...(over.ping !== undefined
      ? {
          async ping() {
            rec.pings += 1;
            if (over.ping instanceof Error) throw over.ping;
            return over.ping === true;
          },
        }
      : {}),
  };
  const deps: GsxFlowSyncDeps = {
    client,
    port: {
      async listBots() {
        rec.botsListed += 1;
        if (bots instanceof Error) throw bots;
        return bots;
      },
      async listFlows(botId) {
        const f = over.flows?.[botId];
        if (f instanceof Error) throw f;
        return f ?? [];
      },
      ...(over.views !== undefined
        ? {
            async listViews() {
              if (over.views instanceof Error) throw over.views;
              return over.views ?? [];
            },
          }
        : {}),
    },
    log: {
      start: (name) => {
        rec.spans.push(`${name}.start`);
        return { finish: () => rec.spans.push(`${name}.finish`), fail: () => rec.spans.push(`${name}.fail`) };
      },
      event: () => undefined,
      info: () => undefined,
      warn: (_c, m) => {
        rec.warns.push(m);
      },
    },
    viewerId: () => (over.viewer === undefined ? 'robb@onereach.com' : over.viewer),
    env: 'edison',
    ...(over.accountId !== undefined ? { accountId: over.accountId } : {}),
    ...(over.dryRun !== undefined ? { dryRun: over.dryRun } : {}),
  };
  return { deps, rec };
}

const bot = (id: string, label: string): GsxBot => ({ id, label, description: '', dateModified: null });
const flow = (id: string, botId: string, label: string, over: Partial<GsxFlow> = {}): GsxFlow => ({
  id, botId, label, description: '', categories: [], version: 'v1', dateModified: 1776111207428, isDeleted: false, ...over,
});

describe('gsxSyncIds', () => {
  // ADR-099 — one mirror per bot for the ACCOUNT: the ids no longer carry
  // the viewer, so two people syncing land on the same Space.
  it('derives deterministic, account-level ids from the GSX ids', () => {
    const a = gsxSyncIds('bot-1', 'flow-9');
    const b = gsxSyncIds('bot-1', 'flow-9');
    expect(a).toEqual(b);
    expect(a.spaceId).toBe('space-gsxbot-bot-1');
    expect(a.assetId).toBe('asset-gsxflow-flow-9');
    expect(a.agentId).toBe('agent-gsxflow-flow-9');
    expect(a.typeId).toBe('agenttype-gsxflow-flow-9');
  });
  it('keeps the ADR-091 viewer-scoped ids only to find the legacy copies', () => {
    const robb = legacyGsxSyncIds('robb@onereach.com', 'bot-1', 'flow-9');
    const rich = legacyGsxSyncIds('rich@onereach.com', 'bot-1', 'flow-9');
    expect(robb.spaceId).toBe(`space-gsxbot-bot-1-${shortHash('robb@onereach.com')}`);
    expect(robb.assetId).toBe(`asset-gsxflow-flow-9-${shortHash('robb@onereach.com')}`);
    expect(robb.spaceId).not.toBe(rich.spaceId);
    expect(robb.spaceId).not.toBe(gsxSyncIds('bot-1').spaceId);
  });
  it('links to Designer', () => {
    expect(designerFlowUrl('edison', 'b', 'f')).toBe('https://studio.edison.onereach.ai/flows/b/f');
  });
});

describe('runGsxFlowSync', () => {
  it('a bot becomes a Space and each live flow an agent asset in it (deleted flows skipped)', async () => {
    const { deps, rec } = makeDeps({
      bots: [bot('b1', 'Tickets')],
      flows: { b1: [flow('f1', 'b1', 'Create a Ticket', { categories: ['ops'] }), flow('f2', 'b1', 'Gone', { isDeleted: true })] },
    });
    const r = await runGsxFlowSync(deps);
    expect(r).toMatchObject({ bots: 1, spacesCreated: 1, flows: 1, agentsCreated: 1, agentsRetired: 0, botsFailed: 0, aborted: false });
    const ids = gsxSyncIds('b1', 'f1');
    expect(rec.spaces[0]).toMatchObject({ id: ids.spaceId, gsxBotId: 'b1', name: 'Tickets' });
    expect(rec.spaces[0]?.description).toContain('https://studio.edison.onereach.ai/flows/b1');
    const a = rec.agents[0]!;
    expect(a).toMatchObject({ spaceId: ids.spaceId, assetId: ids.assetId, agentId: ids.agentId, typeId: ids.typeId, gsxFlowId: 'f1', name: 'Create a Ticket' });
    expect(a.sourceUrl).toBe('https://studio.edison.onereach.ai/flows/b1/f1');
    expect(a.metadata).toMatchObject({ source: 'gsx-designer', gsxBotId: 'b1', gsxFlowId: 'f1', gsxCategories: 'ops' });
    expect(a.content).toContain('# Create a Ticket');
    expect(a.content).toContain('Open in Designer: https://studio.edison.onereach.ai/flows/b1/f1');
  });

  it('retires agents whose flow left Designer, and only those', async () => {
    const sid = gsxSyncIds('b1').spaceId;
    const { deps, rec } = makeDeps({
      bots: [bot('b1', 'Tickets')],
      flows: { b1: [flow('f1', 'b1', 'Keep')] },
      existing: { [sid]: [{ assetId: 'asset-keep', gsxFlowId: 'f1' }, { assetId: 'asset-stale', gsxFlowId: 'f-old' }] },
      createdSpaces: new Set([sid]),
    });
    const r = await runGsxFlowSync(deps);
    expect(rec.retired).toEqual(['asset-stale']);
    expect(r.agentsRetired).toBe(1);
    expect(r.spacesUpdated).toBe(1);
  });

  it('a user Space that already owns the bot\'s name yields "<name> (GSX)"', async () => {
    const { deps, rec } = makeDeps({ bots: [bot('b1', 'Tickets')], takenNames: ['Tickets'] });
    await runGsxFlowSync(deps);
    expect(rec.spaces[0]?.name).toBe('Tickets (GSX)');
  });

  it('one bot\'s flow list failing is counted and skipped — its Space keeps its agents', async () => {
    const { deps, rec } = makeDeps({
      bots: [bot('b1', 'AI Build Tools'), bot('b2', 'Omni Data')],
      flows: { b1: new Error('Internal Server Error'), b2: [flow('f9', 'b2', 'Ingest')] },
      existing: { [gsxSyncIds('b1').spaceId]: [{ assetId: 'a-keep', gsxFlowId: 'f-x' }] },
    });
    const r = await runGsxFlowSync(deps);
    expect(r.botsFailed).toBe(1);
    expect(r.bots).toBe(2);
    expect(r.agentsCreated).toBe(1);
    expect(rec.retired).toEqual([]); // never retire on a failed list
    expect(rec.warns.some((w) => w.includes('flows unavailable'))).toBe(true);
  });

  it('signed out → aborts quietly; no bots read, nothing written', async () => {
    const { deps, rec } = makeDeps({ bots: [bot('b1', 'X')], viewer: null });
    const r = await runGsxFlowSync(deps);
    expect(r).toMatchObject({ aborted: true, reason: 'signed-out', bots: 0 });
    expect(rec.spaces).toEqual([]);
  });

  it('an account without the refresh_token flow (404) aborts with its own reason', async () => {
    const { deps } = makeDeps({ bots: new GsxFlowsError('answered 404', 404) });
    const r = await runGsxFlowSync(deps);
    expect(r).toMatchObject({ aborted: true, reason: 'no-refresh-token-flow' });
  });

  // 2026-09-05: the neon2 proxy answered every query (even RETURN 1) with
  // HTTP 500 after 29 s. The sweep, fired on every Spaces open, then spent
  // 12 bots × 29 s failing writes that could never land. A graph outage
  // must cost one ping — or, mid-sweep, one bot — and nothing more.
  describe('graph outage', () => {
    const outage = Object.assign(
      new Error('Neon query failed: HTTP 500 from https://em.edison.api.onereach.ai/http/acct/omnidata/neon2'),
      { code: 'SPACES_CYPHER' }
    );

    it('pre-flight: a dead ping aborts BEFORE Designer is read — no bots listed, nothing written', async () => {
      const { deps, rec } = makeDeps({ bots: [bot('b1', 'Tickets')], flows: { b1: [flow('f1', 'b1', 'Triage')] }, ping: false });
      const r = await runGsxFlowSync(deps);
      expect(r).toMatchObject({ aborted: true, reason: 'graph-unavailable', bots: 0, botsFailed: 0 });
      expect(rec.pings).toBe(1);
      expect(rec.botsListed).toBe(0);
      expect(rec.spaces).toEqual([]);
      expect(rec.agents).toEqual([]);
      expect(rec.warns.some((w) => w.includes('graph unavailable'))).toBe(true);
      expect(rec.spans).toEqual(['spaces.gsxFlowSync.start', 'spaces.gsxFlowSync.finish']);
    });

    it('pre-flight: a ping that THROWS is the same as a dead one', async () => {
      const { deps, rec } = makeDeps({ bots: [bot('b1', 'Tickets')], ping: new Error('timeout for event: 29000 ms') });
      const r = await runGsxFlowSync(deps);
      expect(r).toMatchObject({ aborted: true, reason: 'graph-unavailable' });
      expect(rec.botsListed).toBe(0);
    });

    it('a live ping lets the sweep run exactly as before (one ping, then Designer)', async () => {
      const { deps, rec } = makeDeps({ bots: [bot('b1', 'Tickets')], flows: { b1: [flow('f1', 'b1', 'Triage')] }, ping: true });
      const r = await runGsxFlowSync(deps);
      expect(r).toMatchObject({ aborted: false, bots: 1, agentsCreated: 1 });
      expect(rec.pings).toBe(1);
      expect(rec.botsListed).toBe(1);
    });

    it('a client without ping (older client, fakes) skips the pre-flight and still sweeps', async () => {
      const { deps, rec } = makeDeps({ bots: [bot('b1', 'Tickets')], flows: { b1: [flow('f1', 'b1', 'Triage')] } });
      const r = await runGsxFlowSync(deps);
      expect(r).toMatchObject({ aborted: false, agentsCreated: 1 });
      expect(rec.pings).toBe(0);
    });

    it('circuit-breaker: the first bot failing on a GRAPH error stops the sweep — later bots are not attempted', async () => {
      const { deps, rec } = makeDeps({
        bots: [bot('b1', 'Tickets'), bot('b2', 'Omni Data'), bot('b3', 'News Feed')],
        flows: { b1: [flow('f1', 'b1', 'Triage')], b2: [flow('f2', 'b2', 'Ingest')], b3: [flow('f3', 'b3', 'Digest')] },
        ping: true,
        spaceUpsertFails: { b1: outage },
      });
      const r = await runGsxFlowSync(deps);
      expect(r).toMatchObject({ aborted: true, reason: 'graph-unavailable', bots: 3, botsFailed: 1 });
      expect(rec.spaces).toEqual([]); // b2 and b3 never reached the graph
      expect(rec.agents).toEqual([]);
      expect(rec.warns.some((w) => w.includes('sweep stopped'))).toBe(true);
      expect(rec.spans.filter((s) => s === 'spaces.gsxFlowSync.bot.start')).toHaveLength(1);
      expect(rec.spans).toContain('spaces.gsxFlowSync.bot.fail');
    });

    it('circuit-breaker trips on a mid-sweep outage too: bots before it keep their results', async () => {
      const { deps, rec } = makeDeps({
        bots: [bot('b1', 'Tickets'), bot('b2', 'Omni Data'), bot('b3', 'News Feed')],
        flows: { b1: [flow('f1', 'b1', 'Triage')], b2: [flow('f2', 'b2', 'Ingest')], b3: [flow('f3', 'b3', 'Digest')] },
        ping: true,
        spaceUpsertFails: { b2: Object.assign(new Error('boom'), { name: 'NeonError' }) },
      });
      const r = await runGsxFlowSync(deps);
      expect(r).toMatchObject({ aborted: true, reason: 'graph-unavailable', bots: 3, botsFailed: 1, agentsCreated: 1 });
      expect(rec.spaces.map((s) => s.gsxBotId)).toEqual(['b1']);
    });

    it('a NON-graph bot failure still skips just that bot (the breaker does not trip)', async () => {
      const { deps, rec } = makeDeps({
        bots: [bot('b1', 'Tickets'), bot('b2', 'Omni Data')],
        flows: { b1: [flow('f1', 'b1', 'Triage')], b2: [flow('f2', 'b2', 'Ingest')] },
        ping: true,
        spaceUpsertFails: { b1: Object.assign(new Error('not writable by the viewer'), { code: 'SPACES_FORBIDDEN' }) },
      });
      const r = await runGsxFlowSync(deps);
      expect(r).toMatchObject({ aborted: false, bots: 2, botsFailed: 1, agentsCreated: 1 });
      expect(rec.spaces.map((s) => s.gsxBotId)).toEqual(['b2']);
      expect(rec.warns.some((w) => w.includes('sweep stopped'))).toBe(false);
    });
  });

  describe('isGraphOutage', () => {
    it('recognises the client wrap, the neon error class, and the proxy message; nothing else', () => {
      expect(isGraphOutage(Object.assign(new Error('x'), { code: 'SPACES_CYPHER' }))).toBe(true);
      expect(isGraphOutage(Object.assign(new Error('x'), { name: 'NeonError' }))).toBe(true);
      expect(isGraphOutage(new Error('Neon query failed: HTTP 500 from https://em.edison.api.onereach.ai/http/a/omnidata/neon2'))).toBe(true);
      expect(isGraphOutage(new Error('HTTP 500 from …/omnidata/neon'))).toBe(true);
      expect(isGraphOutage(Object.assign(new Error('x'), { code: 'SPACES_FORBIDDEN' }))).toBe(false);
      expect(isGraphOutage(new GsxFlowsError('Internal Server Error', 500))).toBe(false);
      expect(isGraphOutage(new Error('Internal Server Error'))).toBe(false);
      expect(isGraphOutage(null)).toBe(false);
      expect(isGraphOutage('Neon query failed')).toBe(false);
    });

    // 2026-09-06 review: the client wraps every graph error as
    // SPACES_CYPHER, so the wrap alone cannot tell an outage from a query
    // the graph refused. Look through to the transport error: a refusal
    // (bad Cypher, a constraint, a 4xx) is one bot's problem; a timeout,
    // a network failure, a 5xx, or an unclassified transport error is
    // the graph.
    it('a query the graph refused is not an outage; a timeout, a 5xx or a network failure is', () => {
      const neon = (code: string, status?: number) => Object.assign(new Error(code), { name: 'NeonError', code, status });
      const wrapped = (cause: Error) => Object.assign(new Error('Neon query failed'), { code: 'SPACES_CYPHER', cause });
      expect(isGraphOutage(wrapped(neon('NEON_QUERY')))).toBe(false);
      expect(isGraphOutage(wrapped(neon('NEON_BAD_INPUT')))).toBe(false);
      expect(isGraphOutage(wrapped(neon('NEON_HTTP', 400)))).toBe(false);
      expect(isGraphOutage(wrapped(neon('NEON_HTTP', 500)))).toBe(true);
      expect(isGraphOutage(wrapped(neon('NEON_HTTP')))).toBe(true);
      expect(isGraphOutage(wrapped(neon('NEON_TIMEOUT')))).toBe(true);
      expect(isGraphOutage(wrapped(neon('NEON_NETWORK')))).toBe(true);
      expect(isGraphOutage(neon('NEON_QUERY'))).toBe(false);
      expect(isGraphOutage(neon('NEON_TIMEOUT'))).toBe(true);
      expect(isGraphOutage(Object.assign(new Error('Neon request timed out'), { code: 'SPACES_NETWORK' }))).toBe(true);
    });
  });

  it('dry run reads Designer and touches nothing', async () => {
    const { deps, rec } = makeDeps({ bots: [bot('b1', 'Tickets')], flows: { b1: [flow('f1', 'b1', 'A')] }, dryRun: true });
    const r = await runGsxFlowSync(deps);
    expect(r).toMatchObject({ bots: 1, flows: 1, spacesCreated: 1, agentsCreated: 1 });
    expect(rec.spaces).toEqual([]);
    expect(rec.agents).toEqual([]);
  });

  it('emits the catalogued spans (spaces.gsxFlowSync, spaces.gsxFlowSync.bot)', async () => {
    const { deps, rec } = makeDeps({ bots: [bot('b1', 'T')], flows: { b1: [] } });
    await runGsxFlowSync(deps);
    expect(rec.spans).toEqual(['spaces.gsxFlowSync.start', 'spaces.gsxFlowSync.bot.start', 'spaces.gsxFlowSync.bot.finish', 'spaces.gsxFlowSync.finish']);
  });

  it('flowAgentContent is plain markdown with the Designer link first', () => {
    const c = flowAgentContent({ label: 'L', botLabel: 'B', description: '', categories: [], version: '', dateModified: null, url: 'https://x' });
    expect(c.split('\n')[0]).toBe('# L');
    expect(c).toContain('- Open in Designer: https://x');
  });
});

// ── GSX agent flows (2026-09-05): the name, and the two links ──────────
describe('GSX agent flows — naming and the Designer + view links', () => {
  const view = (id: string, flowId: string | null, label: string, dateModified: number | null = 1, botId: string | null = null): GsxView =>
    ({ id, label, flowId, botId, dateModified });

  it('calls them GSX agent flows, not Designer flows', async () => {
    const { deps, rec } = makeDeps({ bots: [bot('b1', 'Tickets')], flows: { b1: [flow('f1', 'b1', 'Create a Ticket')] } });
    await runGsxFlowSync(deps);
    expect(rec.spaces[0]?.description).toContain('the GSX agent flows of bot “Tickets”');
    expect(rec.agents[0]?.description).toBe('GSX agent flow in Tickets.');
    expect(rec.agents[0]?.content).toContain('A GSX agent flow in **Tickets**');
    expect(rec.agents[0]?.content).not.toContain('Designer flow');
  });

  it('a flow with a view links to it in Action Desk (with the account), in metadata and in the body', async () => {
    const { deps, rec } = makeDeps({
      bots: [bot('b1', 'Tickets')],
      flows: { b1: [flow('f1', 'b1', 'Create a Ticket'), flow('f2', 'b1', 'No view yet')] },
      views: [view('v-old', 'f1', 'Create a Ticket', 5), view('v-new', 'f1', 'Create a Ticket v2', 9), view('v-bot', null, 'Space view', 1, 'b1')],
      accountId: 'acct-1',
    });
    await runGsxFlowSync(deps);
    const withView = rec.agents.find((a) => a.gsxFlowId === 'f1')!;
    const viewUrl = 'https://actiondesk.edison.onereach.ai/views/v-new?accountId=acct-1';
    expect(withView.metadata).toMatchObject({
      gsxDesignerUrl: 'https://studio.edison.onereach.ai/flows/b1/f1',
      gsxViewId: 'v-new', // the most recently modified of the flow's views
      gsxViewUrl: viewUrl,
      gsxViewLabel: 'Create a Ticket v2',
    });
    expect(withView.content).toContain('- Open in Designer: https://studio.edison.onereach.ai/flows/b1/f1');
    expect(withView.content).toContain(`- Open view (Create a Ticket v2): ${viewUrl}`);

    const without = rec.agents.find((a) => a.gsxFlowId === 'f2')!;
    expect(without.metadata).toMatchObject({ gsxDesignerUrl: 'https://studio.edison.onereach.ai/flows/b1/f2' });
    expect(without.metadata).not.toHaveProperty('gsxViewUrl');
    expect(without.content).not.toContain('Open view');
  });

  it('views unavailable (or a port without them) never stops the sweep — agents link to Designer only', async () => {
    const failing = makeDeps({ bots: [bot('b1', 'Tickets')], flows: { b1: [flow('f1', 'b1', 'A')] }, views: new Error('auth fail: wrong keyId') });
    const r1 = await runGsxFlowSync(failing.deps);
    expect(r1).toMatchObject({ aborted: false, agentsCreated: 1 });
    expect(failing.rec.agents[0]?.metadata).not.toHaveProperty('gsxViewUrl');

    const legacyPort = makeDeps({ bots: [bot('b1', 'Tickets')], flows: { b1: [flow('f1', 'b1', 'A')] } });
    const r2 = await runGsxFlowSync(legacyPort.deps);
    expect(r2).toMatchObject({ aborted: false, agentsCreated: 1 });
  });

  it('helpers: the Action Desk link and the newest-view-per-flow rule', () => {
    expect(actionDeskViewUrl('edison', 'v 1')).toBe('https://actiondesk.edison.onereach.ai/views/v%201');
    expect(actionDeskViewUrl('edison', 'v1', 'a/b')).toBe('https://actiondesk.edison.onereach.ai/views/v1?accountId=a%2Fb');
    const m = viewsByFlow([view('a', 'f', 'A', 1), view('b', 'f', 'B', 3), view('c', 'f', 'C', 2), view('d', null, 'D')]);
    expect(m.get('f')?.id).toBe('b');
    expect(m.size).toBe(1);
    const c = flowAgentContent({ label: 'L', botLabel: 'B', description: '', categories: [], version: '', dateModified: null, url: 'https://x', viewUrl: 'https://v', viewLabel: 'V' });
    expect(c).toContain('- Open in Designer: https://x');
    expect(c).toContain('- Open view (V): https://v');
    expect(flowAgentContent({ label: 'L', botLabel: 'B', description: '', categories: [], version: '', dateModified: null, url: 'https://x', viewUrl: null })).not.toContain('Open view');
  });
});

// ── ADR-092: a Space created in Lite is the bot's home ─────────────────
describe('a Space created in Lite that became the bot (ADR-092)', () => {
  it('receives the bot’s flows; no mirror Space is minted and its own name/description stay', async () => {
    const { deps, rec } = makeDeps({
      bots: [bot('b1', 'Customer Care')],
      flows: { b1: [flow('f1', 'b1', 'Triage')] },
      ownSpaces: { b1: { id: 'space-user-1', name: 'Customer Care' } },
      takenNames: ['Customer Care'], // would have forced "(GSX)" on a mirror
    });
    const r = await runGsxFlowSync(deps);
    expect(rec.spaces).toHaveLength(0); // nothing upserted for this bot
    expect(rec.agents.map((a) => a.spaceId)).toEqual(['space-user-1']);
    expect(r).toMatchObject({ bots: 1, spacesCreated: 0, spacesUpdated: 1, agentsCreated: 1, aborted: false });
  });

  it('retires stale agents inside that Space too, and other bots still get their mirror Space', async () => {
    const { deps, rec } = makeDeps({
      bots: [bot('b1', 'Customer Care'), bot('b2', 'Tickets')],
      flows: { b1: [flow('f1', 'b1', 'Keep')], b2: [flow('f2', 'b2', 'Create a Ticket')] },
      ownSpaces: { b1: { id: 'space-user-1', name: 'Customer Care' } },
      existing: { 'space-user-1': [{ assetId: 'asset-keep', gsxFlowId: 'f1' }, { assetId: 'asset-stale', gsxFlowId: 'f-old' }] },
    });
    const r = await runGsxFlowSync(deps);
    expect(rec.retired).toEqual(['asset-stale']);
    expect(rec.spaces.map((s) => s.gsxBotId)).toEqual(['b2']);
    expect(r).toMatchObject({ spacesCreated: 1, spacesUpdated: 1, agentsRetired: 1 });
  });
});

// ─── ADR-099 — one mirror per bot, born nested, convergence, orphans ────

describe('ADR-099: account-level mirrors', () => {
  interface Rec098 {
    nests: Array<[string, string, boolean, string | null]>;
    folds: Array<[string, string]>;
    archived: Array<[string, string]>;
    groupUpserts: number;
    warns: string[];
    agentBatches: number;
  }
  function make(over: {
    bots?: GsxBot[];
    created?: boolean;
    group?: { id: string; name: string } | null | Error;
    fold?: { folded: boolean; agentsRetired: number; itemsKept: number };
    mirrors?: Array<{ id: string; gsxBotId: string }>;
    ping?: boolean;
    dryRun?: boolean;
    withoutOptional?: boolean;
    /** Another person's sync keeps the mirror: this person holds read sight only. */
    readOnly?: boolean;
    flows?: GsxFlow[];
  } = {}): { deps: GsxFlowSyncDeps; rec: Rec098 } {
    const rec: Rec098 = { nests: [], folds: [], archived: [], groupUpserts: 0, warns: [], agentBatches: 0 };
    const created = over.created ?? true;
    const base: GsxFlowSyncClient = {
      async upsertGsxFlowSpace(input) {
        return over.readOnly === true ? { id: input.id, created: false, writable: false } : { id: input.id, created };
      },
      async spaceNameTaken() {
        return false;
      },
      async upsertGsxFlowAgents(_s, _b, rows) {
        rec.agentBatches += 1;
        return rows.map((r) => ({ id: r.assetId, created: true }));
      },
      async listGsxFlowAgents() {
        return [];
      },
      async retireGsxFlowAgent() {
        return true;
      },
      ...(over.ping !== undefined ? { async ping() { return over.ping === true; } } : {}),
    };
    const optional: Partial<GsxFlowSyncClient> = over.withoutOptional === true ? {} : {
      async upsertGroupSpace(input) {
        rec.groupUpserts += 1;
        if (over.group instanceof Error) throw over.group;
        return over.group === undefined ? { id: input.id, name: input.name } : over.group;
      },
      async nestSpace(childId, parentId, inherit, until) {
        rec.nests.push([childId, parentId, inherit, until]);
        return {};
      },
      async foldLegacyGsxMirror(legacyId, targetId) {
        rec.folds.push([legacyId, targetId]);
        return over.fold ?? { folded: false, agentsRetired: 0, itemsKept: 0 };
      },
      async listGsxMirrorSpaces() {
        return over.mirrors ?? [];
      },
      async archiveSpace(id, reason) {
        rec.archived.push([id, reason]);
        return true;
      },
    };
    const deps: GsxFlowSyncDeps = {
      client: { ...base, ...optional },
      port: {
        async listBots() {
          return over.bots ?? [bot('b1', 'Tickets')];
        },
        async listFlows() {
          return over.flows ?? [];
        },
      },
      log: {
        start: () => ({ finish: () => undefined, fail: () => undefined }),
        event: () => undefined,
        info: () => undefined,
        warn: (_c, m) => {
          rec.warns.push(m);
        },
      },
      viewerId: () => 'robb@onereach.com',
      env: 'edison',
      ...(over.dryRun === true ? { dryRun: true } : {}),
    };
    return { deps, rec };
  }

  it('a NEW mirror is born inside the GSX Designer group, inheritance off; the group is resolved once per sweep', async () => {
    const { deps, rec } = make({ bots: [bot('b1', 'Tickets'), bot('b2', 'Agents')] });
    const r = await runGsxFlowSync(deps);
    expect(r.spacesCreated).toBe(2);
    expect(rec.groupUpserts).toBe(1);
    expect(rec.nests).toEqual([
      ['space-gsxbot-b1', GSX_DESIGNER_GROUP.id, false, null],
      ['space-gsxbot-b2', GSX_DESIGNER_GROUP.id, false, null],
    ]);
  });

  it('an EXISTING mirror the person keeps (creator) refreshes and is not re-nested', async () => {
    const { deps, rec } = make({ created: false, flows: [flow('f1', 'b1', 'Create a Ticket')] });
    const r = await runGsxFlowSync(deps);
    expect(r.spacesUpdated).toBe(1);
    expect(rec.agentBatches).toBe(1);
    expect(rec.nests).toEqual([]);
    expect(rec.groupUpserts).toBe(0);
  });

  it("another person's mirror: this person holds READ sight and writes nothing into it", async () => {
    const { deps, rec } = make({ readOnly: true, flows: [flow('f1', 'b1', 'Create a Ticket')], fold: { folded: true, agentsRetired: 3, itemsKept: 0 } });
    const r = await runGsxFlowSync(deps);
    expect(r.spacesUpdated).toBe(1);
    expect(r.agentsCreated).toBe(0);
    expect(rec.agentBatches).toBe(0);
    expect(rec.nests).toEqual([]);
    expect(rec.folds).toEqual([]); // the fold follows a fill this person did not do
    expect(r.legacyFolded).toBe(0);
  });

  it('convergence: this person\'s legacy viewer-suffixed copy is folded AFTER the account Space is filled, and counted', async () => {
    const order: string[] = [];
    const { deps, rec } = make({ fold: { folded: true, agentsRetired: 38, itemsKept: 1 }, flows: [flow('f1', 'b1', 'Create a Ticket')] });
    const client = deps.client;
    const upsertAgents = client.upsertGsxFlowAgents.bind(client);
    client.upsertGsxFlowAgents = async (...args) => {
      order.push('agents');
      return upsertAgents(...args);
    };
    const fold = client.foldLegacyGsxMirror!.bind(client);
    client.foldLegacyGsxMirror = async (...args) => {
      order.push('fold');
      return fold(...args);
    };
    const r = await runGsxFlowSync(deps);
    expect(rec.folds).toEqual([[legacyGsxSyncIds('robb@onereach.com', 'b1').spaceId, 'space-gsxbot-b1']]);
    expect(order).toEqual(['agents', 'fold']);
    expect(r.legacyFolded).toBe(1);
    const again = make({ fold: { folded: false, agentsRetired: 0, itemsKept: 0 } });
    expect((await runGsxFlowSync(again.deps)).legacyFolded).toBe(0);
  });

  it('after a complete sweep, a mirror whose bot left Designer is archived — and only that one', async () => {
    const { deps, rec } = make({
      mirrors: [
        { id: 'space-gsxbot-b1', gsxBotId: 'b1' },
        { id: 'space-gsxbot-gone', gsxBotId: 'gone' },
      ],
    });
    const r = await runGsxFlowSync(deps);
    expect(rec.archived).toEqual([['space-gsxbot-gone', 'gsx-bot-gone']]);
    expect(r.spacesArchived).toBe(1);
  });

  it('an empty Designer listing or an aborted sweep never archives anything', async () => {
    const empty = make({ bots: [], mirrors: [{ id: 'space-gsxbot-b1', gsxBotId: 'b1' }] });
    await runGsxFlowSync(empty.deps);
    expect(empty.rec.archived).toEqual([]);
    const down = make({ ping: false, mirrors: [{ id: 'space-gsxbot-b1', gsxBotId: 'b1' }] });
    const r = await runGsxFlowSync(down.deps);
    expect(r.aborted).toBe(true);
    expect(down.rec.archived).toEqual([]);
  });

  it('dry run touches nothing new either', async () => {
    const { deps, rec } = make({ dryRun: true, created: false, fold: { folded: true, agentsRetired: 1, itemsKept: 0 }, mirrors: [{ id: 'x', gsxBotId: 'gone' }] });
    const r = await runGsxFlowSync(deps);
    expect(rec.nests).toEqual([]);
    expect(rec.folds).toEqual([]);
    expect(rec.archived).toEqual([]);
    expect(r.legacyFolded).toBe(0);
    expect(r.spacesArchived).toBe(0);
  });

  it('a missing or failing group leaves mirrors top-level and the sync intact', async () => {
    const gone = make({ group: null });
    const r1 = await runGsxFlowSync(gone.deps);
    expect(r1.spacesCreated).toBe(1);
    expect(gone.rec.nests).toEqual([]);
    const failing = make({ group: new Error('graph hiccup') });
    const r2 = await runGsxFlowSync(failing.deps);
    expect(r2.spacesCreated).toBe(1);
    expect(failing.rec.nests).toEqual([]);
    expect(failing.rec.warns.some((w) => w.includes('group Space unavailable'))).toBe(true);
  });

  it('an older client without the optional methods still syncs (ADR-091 behaviour)', async () => {
    const { deps, rec } = make({ withoutOptional: true });
    const r = await runGsxFlowSync(deps);
    expect(r).toMatchObject({ spacesCreated: 1, aborted: false, legacyFolded: 0, spacesArchived: 0 });
    expect(rec.nests).toEqual([]);
  });
});
