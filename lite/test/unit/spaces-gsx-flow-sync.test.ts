/**
 * runGsxFlowSync — GSX Designer bots → Spaces, flows → agent assets
 * (ADR-091). Driven with a fake port + fake client; no graph, no GSX.
 */
import { describe, it, expect } from 'vitest';
import {
  runGsxFlowSync,
  gsxSyncIds,
  shortHash,
  designerFlowUrl,
  flowAgentContent,
  type GsxFlowSyncDeps,
  type GsxFlowSyncClient,
} from '../../spaces/gsx-flow-sync.js';
import { GsxFlowsError, type GsxBot, type GsxFlow } from '../../spaces/gsx-flows-port.js';

interface Rec {
  spaces: Array<Parameters<GsxFlowSyncClient['upsertGsxFlowSpace']>[0]>;
  agents: Array<Parameters<GsxFlowSyncClient['upsertGsxFlowAgents']>[2][number] & { spaceId: string; gsxBotId: string }>;
  retired: string[];
  spans: string[];
  warns: string[];
}

function makeDeps(over: {
  bots?: GsxBot[] | Error;
  flows?: Record<string, GsxFlow[] | Error>;
  existing?: Record<string, Array<{ assetId: string; gsxFlowId: string }>>;
  takenNames?: string[];
  viewer?: string | null;
  dryRun?: boolean;
  createdSpaces?: Set<string>;
} = {}): { deps: GsxFlowSyncDeps; rec: Rec } {
  const rec: Rec = { spaces: [], agents: [], retired: [], spans: [], warns: [] };
  const bots = over.bots ?? [];
  const client: GsxFlowSyncClient = {
    async upsertGsxFlowSpace(input) {
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
  };
  const deps: GsxFlowSyncDeps = {
    client,
    port: {
      async listBots() {
        if (bots instanceof Error) throw bots;
        return bots;
      },
      async listFlows(botId) {
        const f = over.flows?.[botId];
        if (f instanceof Error) throw f;
        return f ?? [];
      },
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
    ...(over.dryRun !== undefined ? { dryRun: over.dryRun } : {}),
  };
  return { deps, rec };
}

const bot = (id: string, label: string): GsxBot => ({ id, label, description: '', dateModified: null });
const flow = (id: string, botId: string, label: string, over: Partial<GsxFlow> = {}): GsxFlow => ({
  id, botId, label, description: '', categories: [], version: 'v1', dateModified: 1776111207428, isDeleted: false, ...over,
});

describe('gsxSyncIds', () => {
  it('derives deterministic, viewer-scoped ids from the GSX ids', () => {
    const a = gsxSyncIds('robb@onereach.com', 'bot-1', 'flow-9');
    const b = gsxSyncIds('robb@onereach.com', 'bot-1', 'flow-9');
    const c = gsxSyncIds('rich@onereach.com', 'bot-1', 'flow-9');
    expect(a).toEqual(b);
    expect(a.spaceId).toBe(`space-gsxbot-bot-1-${shortHash('robb@onereach.com')}`);
    expect(a.assetId).toBe(`asset-gsxflow-flow-9-${shortHash('robb@onereach.com')}`);
    expect(a.spaceId).not.toBe(c.spaceId); // one Space per creator
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
    const ids = gsxSyncIds('robb@onereach.com', 'b1', 'f1');
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
    const sid = gsxSyncIds('robb@onereach.com', 'b1').spaceId;
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
      existing: { [gsxSyncIds('robb@onereach.com', 'b1').spaceId]: [{ assetId: 'a-keep', gsxFlowId: 'f-x' }] },
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
