/**
 * ADR-088 — the registry admission checklist.
 *
 * The checklist is the Gartner-project page's; Lite ports its constants
 * and its compute() verbatim and shares its KV document. These tests pin
 * the port (same ticks → same rung, grade, admission), the shared-document
 * merge (Lite never clobbers the page's other agents), the analysis, and
 * the listing gate.
 */
import { describe, expect, it } from 'vitest';
import {
  ADMISSION_KV,
  ADMISSION_LINES,
  ADMISSION_LINE_IDS,
  ADMISSION_PLATFORMS,
  autoChecks,
  computeAdmission,
  findAdmissionEntry,
  slugAgentName,
  type AdmissionEntry,
  type AdmissionLineId,
} from '../../registry/admission.js';
import { RegistryApi } from '../../registry/api.js';

const tick = (ids: string[]): Partial<Record<AdmissionLineId, boolean>> => Object.fromEntries(ids.map((i) => [i, true]));
const section = (s: string): string[] => ADMISSION_LINE_IDS.filter((l) => l[0] === s);
const entry = (items: Partial<Record<AdmissionLineId, boolean>>, platform: AdmissionEntry['platform'] = 'gsx'): AdmissionEntry => ({ name: 'Procurement agent', items, platform });

describe('admission checklist — the page, ported', () => {
  it('carries the page: 27 lines A1–F2, six sections, ten platforms, MQ answer homes', () => {
    expect(ADMISSION_LINE_IDS).toEqual([...'abcde'].flatMap((s) => [1, 2, 3, 4, 5].map((n) => `${s}${n}`)).concat(['f1', 'f2']));
    expect(ADMISSION_LINES.every((l) => l.title.length > 0 && l.owner.length > 0 && l.test.length > 0 && l.why.length > 0)).toBe(true);
    expect(Object.keys(ADMISSION_PLATFORMS)).toEqual(['gsx', 'langgraph', 'a2a', 'copilot', 'agentforce', 'servicenow', 'chatgpt', 'claude', 'gemini', 'closed']);
    expect(ADMISSION_LINES.find((l) => l.id === 'c1')?.mq).toEqual(['Q16']);
    expect(ADMISSION_KV).toEqual({ collection: 'amp:rfi', key: 'registry:checklist' });
  });

  it('keys an agent exactly like the page: slug of the name', () => {
    expect(slugAgentName('  LangGraph Procurement Agent (picked) ')).toBe('langgraph-procurement-agent-picked');
    expect(slugAgentName('')).toBe('');
  });

  it('no entry → open, not graded, no rung', () => {
    const s = computeAdmission(null);
    expect(s).toMatchObject({ rung: 'none', grade: null, gradeLabel: 'not graded', admit: 'open', progress: { met: 0, total: 27 } });
  });

  it('the rungs: A earns L1, +C L2, +D L3, +B+E L4', () => {
    expect(computeAdmission(entry(tick(section('a')))).rung).toBe('l1');
    expect(computeAdmission(entry(tick([...section('a'), ...section('c')]))).rung).toBe('l2');
    expect(computeAdmission(entry(tick([...section('a'), ...section('c'), ...section('d')]))).rung).toBe('l3');
    expect(computeAdmission(entry(tick([...section('a'), ...section('b'), ...section('c'), ...section('d'), ...section('e')]))).rung).toBe('l4');
    // C without A earns nothing: the ladder is ordered.
    expect(computeAdmission(entry(tick(section('c')))).rung).toBe('none');
  });

  it('the grade is the worst unmet non-F line; F lines never grade', () => {
    const all = [...section('a'), ...section('b'), ...section('c'), ...section('d'), ...section('e')];
    expect(computeAdmission(entry(tick(all))).grade).toBe('l');
    expect(computeAdmission(entry(tick(all.filter((l) => l !== 'e2')))).grade).toBe('m');
    expect(computeAdmission(entry(tick(all.filter((l) => l !== 'd3')))).grade).toBe('h');
    expect(computeAdmission(entry(tick(all.filter((l) => l !== 'a1')))).grade).toBe('c');
    const s = computeAdmission(entry(tick(all.filter((l) => l !== 'a1'))));
    expect(s.why).toContain('Set by A1');
    expect(s.admit).toBe('not admitted to act');
  });

  it('B4 and E3 grade together: both unmet is Critical, one unmet is High', () => {
    const all = [...section('a'), ...section('b'), ...section('c'), ...section('d'), ...section('e')];
    expect(computeAdmission(entry(tick(all.filter((l) => l !== 'b4' && l !== 'e3')))).grade).toBe('c');
    expect(computeAdmission(entry(tick(all.filter((l) => l !== 'b4')))).grade).toBe('h');
    expect(computeAdmission(entry(tick(all.filter((l) => l !== 'e3')))).grade).toBe('h');
  });

  it('a platform ceiling caps the rung, and its blocked lines neither count nor grade', () => {
    const all = [...section('a'), ...section('b'), ...section('c'), ...section('d'), ...section('e')];
    const s = computeAdmission(entry(tick(all), 'copilot'));
    expect(s.ceiling).toBe('l3');
    expect(s.rung).toBe('l3');
    expect(s.lines.find((l) => l.id === 'd1')?.blocked).toContain('Microsoft');
    expect(s.lines.find((l) => l.id === 'd1')?.met).toBe(false);
    expect(s.lines.find((l) => l.id === 'a3')?.federated).toBe('Entra Agent ID');
    // Blocked lines are excluded from the section's allMet, so A+C+D (minus D1/D2/D4) still earns L3.
    const s2 = computeAdmission(entry(tick([...section('a'), ...section('c'), 'd3', 'd5']), 'copilot'));
    expect(s2.rung).toBe('l3');
    // …and the grade explains itself: unmet blocked lines are named as not possible.
    expect(computeAdmission(entry(tick(section('a')), 'copilot')).why).toContain('not possible on this platform');
  });

  it('admission follows the sign-offs: F1+F2 → admitted, else pending; Critical is never admitted', () => {
    const all = [...section('a'), ...section('b'), ...section('c'), ...section('d'), ...section('e')];
    expect(computeAdmission(entry(tick(all))).admit).toBe('pending sign-off (F1, F2)');
    expect(computeAdmission(entry(tick([...all, 'f1', 'f2']))).admit).toBe('admitted, signed off');
    expect(computeAdmission(entry(tick(['f1', 'f2']))).admit).toBe('not admitted to act');
  });

  it('finds an entry by NEON id first, then by the page name slug', () => {
    const doc = { v: 1, agents: { 'procurement-agent': entry({}), other: { ...entry({}), name: 'Other', agentId: 'ag-9' } } };
    expect(findAdmissionEntry(doc, 'ag-9', 'Procurement agent').key).toBe('other');
    expect(findAdmissionEntry(doc, 'ag-1', 'Procurement agent').key).toBe('procurement-agent');
    expect(findAdmissionEntry(doc, 'ag-1', 'Unknown').entry).toBeNull();
    expect(findAdmissionEntry(null, 'ag-1', 'Unknown').entry).toBeNull();
  });

  it('auto checks prove only what the record shows: card, roster, GSX-fronted MCP tools, version', () => {
    const rich = autoChecks({ name: 'Procurement agent', description: 'Raises purchase orders from approved requests and tracks them.', owner: 'robb@onereach.com', keywords: ['purchasing'], capabilities: ['po.create'], version: '1.4.0', endpoints: [{ kind: 'mcp', url: 'https://mcp.edison.api.onereach.ai/x' }], gsxEndpoint: '', executionType: 'local' });
    expect(Object.fromEntries(rich.map((c) => [c.line, c.passed]))).toEqual({ a1: true, a4: true, d5: true, e2: true });
    const bare = autoChecks({ name: 'x', description: '', owner: '', keywords: [], capabilities: [], version: '', endpoints: [{ kind: 'api', url: 'https://example.com/api' }], gsxEndpoint: '', executionType: '' });
    expect(Object.fromEntries(bare.map((c) => [c.line, c.passed]))).toEqual({ a1: false, a4: true, d5: false, e2: false });
    expect(bare.find((c) => c.line === 'd5')?.evidence).toContain('example.com');
  });
});

// ── the API over a fake graph + fake KV + fake AI ────────────────────
// The GET row as NEON returns it (every column the parser reads).
const AGENT_ROW = {
  id: 'ag-1', name: 'Procurement agent', description: 'Raises purchase orders from approved requests and tracks them to receipt.', type: 'simple', category: 'ops', enabled: true, deleted: false, source: 'lite', owner: 'robb@onereach.com', updatedMs: 1, createdMs: 1, listing: 'unlisted', listedAt: null, manualChecks: '{}', builtin: false, isSystem: false, status: 'active', version: '1.4.0', keywords: ['purchasing'], capabilities: ['po.create'], executionType: 'local', gsxEndpoint: '', endpoints: [{ id: 'ep-1', kind: 'mcp', url: 'https://mcp.edison.api.onereach.ai/x', channels: [] }], idws: [], knowledgeModels: [], capabilityNodes: [], usedInSpaces: [], representedBy: [], contributedPlaybooks: 0, enabledBy: 0, library: '',
};
function fakeGraph(role = 'USER', viewer = 'robb@onereach.com') {
  const calls: string[] = [];
  const query = async (cypher: string, params: Record<string, unknown>): Promise<Array<Record<string, unknown>>> => {
    calls.push(cypher);
    if (/AS known/.test(cypher)) return [{ known: true, isAdmin: /admin|owner/i.test(role), admins: [] }];
    if (/MATCH \(a:Agent \{id: \$id\}\)/.test(cypher)) return params['id'] === AGENT_ROW.id ? [AGENT_ROW] : [];
    return [];
  };
  return { query, calls, viewerId: () => viewer };
}
function fakeKv(initial: unknown = null) {
  const store = new Map<string, unknown>();
  if (initial !== null) store.set('amp:rfi/registry:checklist', initial);
  return {
    store,
    get: async (c: string, k: string) => store.get(`${c}/${k}`) ?? null,
    set: async (c: string, k: string, v: unknown) => {
      store.set(`${c}/${k}`, JSON.parse(JSON.stringify(v)));
    },
  };
}

describe('admission checklist — the API over the shared document', () => {
  it('reads the agent entry from the shared document and grades it like the page', async () => {
    const g = fakeGraph();
    const kv = fakeKv({ v: 1, agents: { 'procurement-agent': { name: 'Procurement agent', platform: 'gsx', items: tick(section('a')) } } });
    const api = new RegistryApi({ query: g.query, viewerId: g.viewerId, kv });
    const view = await api.admissionGet('ag-1');
    expect(view.key).toBe('procurement-agent');
    expect(view.status.rung).toBe('l1');
    expect(view.status.grade).toBe('c');
    expect(view.canWrite).toBe(true); // the creator may edit
    expect(view.pageUrl).toMatch(/registry-admission-checklist\.html$/);
  });

  it('save merges into the shared document: other agents untouched, provenance stamped, NEON id recorded', async () => {
    const g = fakeGraph();
    const kv = fakeKv({ v: 1, agents: { 'shadow-agent': { name: 'Shadow agent', platform: 'closed', items: {} } } });
    const api = new RegistryApi({ query: g.query, viewerId: g.viewerId, kv, now: () => Date.UTC(2026, 8, 4) });
    const view = await api.admissionSave('ag-1', { platform: 'copilot', ownerEmail: 'owner@x.com', items: { a1: true, zz: true } as never });
    const doc = kv.store.get('amp:rfi/registry:checklist') as { agents: Record<string, AdmissionEntry> };
    expect(Object.keys(doc.agents).sort()).toEqual(['procurement-agent', 'shadow-agent']);
    expect(doc.agents['procurement-agent']).toMatchObject({ name: 'Procurement agent', platform: 'copilot', ownerEmail: 'owner@x.com', items: { a1: true }, agentId: 'ag-1', by: 'robb@onereach.com', updatedAt: '2026-09-04T00:00:00.000Z' });
    expect(doc.agents['shadow-agent']).toMatchObject({ platform: 'closed' });
    expect(view.status.platform).toBe('copilot');
    // A later save keeps earlier ticks (merge, not replace).
    const again = await api.admissionSave('ag-1', { items: { a2: true } });
    expect(again.entry?.items).toEqual({ a1: true, a2: true });
  });

  it('only an admin or the creator may write; a stranger is refused', async () => {
    const g = fakeGraph('USER', 'someone@else.com');
    const api = new RegistryApi({ query: g.query, viewerId: g.viewerId, kv: fakeKv() });
    await expect(api.admissionSave('ag-1', { items: { a1: true } })).rejects.toMatchObject({ code: 'REGISTRY_FORBIDDEN' });
    expect((await api.admissionGet('ag-1')).canWrite).toBe(false);
  });

  it('analyze ticks only graph-proven lines, records the AI grading, and never unticks', async () => {
    const g = fakeGraph();
    const kv = fakeKv({ v: 1, agents: { 'procurement-agent': { name: 'Procurement agent', platform: 'gsx', items: { c1: true } } } });
    const prompts: string[] = [];
    const ai = {
      chat: async (input: { system?: string; messages: Array<{ content: string }> }) => {
        prompts.push(input.messages[0]?.content ?? '');
        return { content: 'Here you go:\n{"summary":"Looks registered; nothing shows observability.","lines":[{"id":"A1","verdict":"met","note":"card complete"},{"id":"c2","verdict":"unmet","note":"no heartbeat"},{"id":"zz","verdict":"met","note":"bogus"}]}' };
      },
    };
    const api = new RegistryApi({ query: g.query, viewerId: g.viewerId, kv, ai, now: () => Date.UTC(2026, 8, 4) });
    const { view, analysis } = await api.admissionAnalyze('ag-1');
    expect(analysis.auto.filter((c) => c.passed).map((c) => c.line)).toEqual(['a1', 'a4', 'd5', 'e2']);
    expect(analysis.ai?.lines).toEqual([{ id: 'a1', verdict: 'met', note: 'card complete' }, { id: 'c2', verdict: 'unmet', note: 'no heartbeat' }]);
    expect(view.entry?.items).toEqual({ c1: true, a1: true, a4: true, d5: true, e2: true });
    expect(view.entry?.lite?.analysis?.at).toBe('2026-09-04T00:00:00.000Z');
    expect(prompts[0]).toContain('LINES ALREADY TICKED: C1');
    expect(prompts[0]).toContain('A1 A1 · The card');
  });

  it('analyze survives a missing or failing model: the graph checks still land, the error is recorded', async () => {
    const g = fakeGraph();
    const kv = fakeKv();
    const api = new RegistryApi({ query: g.query, viewerId: g.viewerId, kv, ai: { chat: async () => { throw new Error('no key'); } } });
    const { view, analysis } = await api.admissionAnalyze('ag-1');
    expect(analysis.ai).toBeNull();
    expect(analysis.aiError).toBe('no key');
    expect(view.entry?.items).toMatchObject({ a1: true });
    const noAi = new RegistryApi({ query: g.query, viewerId: g.viewerId, kv });
    expect((await noAi.admissionAnalyze('ag-1')).analysis.aiError).toContain('not configured');
  });

  it('listing is gated by admission: unstarted or Critical is refused; listing needs the sign-offs', async () => {
    const g = fakeGraph('admin');
    const all = [...section('a'), ...section('b'), ...section('c'), ...section('d'), ...section('e')];
    const kv = fakeKv({ v: 1, agents: {} });
    const api = new RegistryApi({ query: g.query, viewerId: g.viewerId, kv });
    await expect(api.setListing('ag-1', 'submitted')).rejects.toMatchObject({ code: 'REGISTRY_NOT_READY', message: /not been started/ });
    await api.admissionSave('ag-1', { items: tick(all.filter((l) => l !== 'a1')) });
    await expect(api.setListing('ag-1', 'submitted')).rejects.toMatchObject({ code: 'REGISTRY_NOT_READY', message: /Not admitted to act/ });
    await api.admissionSave('ag-1', { items: { a1: true } });
    await expect(api.setListing('ag-1', 'listed')).rejects.toMatchObject({ code: 'REGISTRY_NOT_READY', message: /F1, F2/ });
  });
});
