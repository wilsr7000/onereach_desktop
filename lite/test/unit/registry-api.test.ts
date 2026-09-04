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
