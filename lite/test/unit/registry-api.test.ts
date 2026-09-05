/**
 * Agent Registry API (ADR-086) — behaviour over a fake NEON transport:
 * viewer binding, sanitization, refusals, row mapping. Rule 12: every
 * module with an api.ts has its <module>-api.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { runApiConformanceContract } from '../harness/conformance.js';
import {
  RegistryApi,
  REGISTRY_API_METHODS,
  _resetRegistryApiForTesting,
  _setRegistryApiForTesting,
  getRegistryApi,
  rowToSummary,
  type RegistryManagerApi,
} from '../../registry/api.js';

runApiConformanceContract<RegistryManagerApi>({
  name: 'RegistryApi',
  getInstance: () => getRegistryApi(),
  resetForTesting: () => _resetRegistryApiForTesting(),
  setForTesting: (instance) => _setRegistryApiForTesting(instance),
  expectedMethods: REGISTRY_API_METHODS,
});

describe('not-initialized stub', () => {
  it('every method refuses with REGISTRY_NOT_INITIALIZED until configured', async () => {
    _resetRegistryApiForTesting();
    await expect(getRegistryApi().whoAmI()).rejects.toMatchObject({ code: 'REGISTRY_NOT_INITIALIZED' });
  });
});

describe('RegistryApi', () => {
  const mk = (rowsByQuery: (cypher: string) => Array<Record<string, unknown>>, viewer: string | null = 'robb@onereach.com') => {
    const calls: Array<{ cypher: string; params: Record<string, unknown> }> = [];
    const api = new RegistryApi({ query: (cypher, params) => { calls.push({ cypher, params }); return Promise.resolve(rowsByQuery(cypher)); }, viewerId: () => viewer, now: () => 1_000 });
    return { api, calls };
  };
  it('search binds normalized filters and maps rows, total and facets', async () => {
    const { api, calls } = mk((c) => c.includes('count(a) AS total') ? [{ total: 2 }] : c.includes("'source' AS facet") ? [{ facet: 'type', value: 'gsx', n: 2 }] : [{ id: 'a', name: 'A', reach: ['mcp', 'mcp'], updatedMs: 5 }, { id: '', name: 'ghost' }]);
    const out = await api.search({ q: '  Slack ', limit: 999, offset: -5 });
    expect(out.items).toHaveLength(1);
    expect(out.items[0]?.reach).toEqual(['mcp']);
    expect(out.total).toBe(2);
    expect(out.facets.types).toEqual([{ value: 'gsx', count: 2 }]);
    expect(calls[0]?.params).toMatchObject({ q: 'slack', limit: 200, offset: 0, viewerId: 'robb@onereach.com', nowMs: 1000 });
  });
  it('writes refuse when signed out, and report a refusal when the gate matches nothing', async () => {
    const out = mk(() => [], null);
    await expect(out.api.setEnabled('a', false)).rejects.toMatchObject({ code: 'REGISTRY_NOT_AUTHENTICATED' });
    const forbidden = mk(() => []);
    await expect(forbidden.api.setEnabled('a', false)).rejects.toMatchObject({ code: 'REGISTRY_FORBIDDEN' });
  });
  it('update sanitizes the patch: vocabulary enforced, keywords stored as JSON, type mirrored', async () => {
    const { api, calls } = mk((c) => c.includes('SET a += $patch') ? [{ id: 'a' }] : [{ id: 'a', name: 'A', description: 'x', status: 'active' }]);
    await expect(api.update('a', { status: 'bogus' })).rejects.toMatchObject({ code: 'REGISTRY_INVALID_INPUT' });
    await api.update('a', { type: 'gsx', keywords: [' one ', '', 'two'] });
    const patch = calls.find((c) => c.cypher.includes('SET a += $patch'))?.params['patch'] as Record<string, unknown>;
    expect(patch).toEqual({ agentType: 'gsx', type: 'gsx', keywords: '["one","two"]' });
  });
  it('listing requires the checklist to be complete', async () => {
    const { api } = mk((c) => c.includes('MATCH (a:Agent {id: $id})\n    RETURN') ? [{ id: 'a', name: 'A', description: 'short', enabled: true }] : [{ id: 'a' }]);
    await expect(api.setListing('a', 'listed')).rejects.toMatchObject({ code: 'REGISTRY_NOT_READY' });
  });
  it('rowToSummary tolerates missing fields', () => {
    expect(rowToSummary({ id: 'x' })).toMatchObject({ id: 'x', name: 'x', enabled: true, listing: 'unlisted', reach: [] });
    expect(rowToSummary({})).toBeNull();
  });
});

// ── ADR-089: where an agent lives ────────────────────────────────────
import { RegistryApi as Api089, rowToSummary as rowToSummary089 } from '../../registry/api.js';
describe('registry API — Spaces, hosting, Skills (ADR-089)', () => {
  const base = { id: 'ag-1', name: 'Extract Tickets', description: 'Break a document into tickets', type: 'micro-ui', category: 'writing', enabled: true, deleted: false, source: 'Playbooks', owner: 'robb@onereach.com', updatedMs: 1, listing: 'unlisted', builtin: false, isSystem: false, reach: [], idwCount: 0, knowledgeCount: 0 };
  it('maps hosting, account, the Skill marker and the sight-filtered Spaces (deduplicated, via kept)', () => {
    const s = rowToSummary089({ ...base, hosting: 'hosted', account: 'onereach.com', isSkill: true, spaces: [{ id: 's1', name: 'Procurement', via: 'asset' }, { id: 's1', name: 'Procurement', via: 'usage' }, { id: 's2', name: 'Ops', via: 'usage' }, { name: 'no id' }] })!;
    expect(s).toMatchObject({ hosting: 'hosted', account: 'onereach.com', isSkill: true });
    expect(s.spaces).toEqual([{ id: 's1', name: 'Procurement', via: 'asset' }, { id: 's2', name: 'Ops', via: 'usage' }]);
    expect(rowToSummary089({ ...base })!).toMatchObject({ hosting: 'catalog', account: '', isSkill: false, spaces: [] });
    expect(rowToSummary089({ ...base, hosting: 'bogus' })!.hosting).toBe('catalog');
  });
  it('search binds the Space, hosting and kind filters, and parses the new facets; listSpaces reads the Space list', async () => {
    const seen: Array<{ cypher: string; params: Record<string, unknown> }> = [];
    const query = async (cypher: string, params: Record<string, unknown>): Promise<Array<Record<string, unknown>>> => {
      seen.push({ cypher, params });
      if (/AS known/.test(cypher)) return [{ known: true, isAdmin: true, admins: [] }];
      if (/'hosting' AS facet/.test(cypher)) return [{ facet: 'hosting', value: 'hosted', n: 3189 }, { facet: 'kind', value: 'skill', n: 700 }, { facet: 'source', value: 'Playbooks', n: 12044 }];
      if (/RETURN count\(a\) AS total/.test(cypher)) return [{ total: 1 }];
      if (/MATCH \(sp:Space\)/.test(cypher)) return [{ id: 's1', name: 'Procurement', description: '', status: '2 agents' }];
      if (/MATCH \(a:Agent\)/.test(cypher)) return [{ ...base, hosting: 'library', account: 'onereach.com', isSkill: false, spaces: [] }];
      return [];
    };
    const api = new Api089({ query, viewerId: () => 'robb@onereach.com' });
    const res = await api.search({ spaceId: 's1', hosting: 'library', kind: 'agent' });
    const search = seen.find((s) => /SKIP toInteger\(\$offset\)/.test(s.cypher));
    expect(search?.params).toMatchObject({ spaceId: 's1', hosting: 'library', kind: 'agent' });
    expect(res.facets.hosting).toEqual([{ value: 'hosted', count: 3189 }]);
    expect(res.facets.kinds).toEqual([{ value: 'skill', count: 700 }]);
    expect(res.items[0]).toMatchObject({ hosting: 'library', account: 'onereach.com' });
    const spaces = await api.listSpaces();
    expect(spaces).toEqual([{ id: 's1', name: 'Procurement', description: '', status: '2 agents' }]);
    // Sight travels with the query: the Space list carries the viewer id and the ADR-084 grant predicate.
    const list = seen.find((s) => /MATCH \(sp:Space\)/.test(s.cypher));
    expect(list?.cypher).toContain('HAS_ACCESS');
    expect(list?.params).toMatchObject({ viewerId: 'robb@onereach.com' });
  });
});
