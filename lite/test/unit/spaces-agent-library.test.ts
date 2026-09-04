/**
 * Agent library picker (2026-09-04): the whole LIVE catalog is reachable
 * — tombstones excluded, relevance-ranked, paged, with provenance and
 * reachability on every row — and identical per-document copies collapse.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { CYPHER, SdkSpacesClient } from '../../spaces/sdk-client.js';
import {
  agentSourceLabel,
  buildAgentLibraryFooter,
  buildAgentLibraryRow,
  collapseAgentCopies,
  type AgentLibraryRowEntry,
} from '../../spaces/spaces.js';

describe('AGENT_LIBRARY_SEARCH / COUNT', () => {
  it('excludes deleted tombstones, matches keywords + id, ranks prefix > contains, pages, and returns provenance', () => {
    const q = CYPHER.AGENT_LIBRARY_SEARCH;
    expect(q).toContain('coalesce(g.deleted, false) = false');
    expect(q).toContain("toLower(coalesce(g.keywords, '')) CONTAINS toLower($q)");
    expect(q).toContain("toLower(coalesce(g.id, '')) CONTAINS toLower($q)");
    expect(q).toContain('STARTS WITH toLower($q) THEN 0');
    // library / built-in / reachable agents lead; per-document Playbooks copies follow, newest first
    expect(q).toContain('ORDER BY rank ASC, tier ASC, updatedMs DESC');
    expect(q).toContain('EXISTS { MATCH (:Library)-[:CONTAINS]->(g) }');
    expect(q).toContain('SKIP toInteger($offset) LIMIT toInteger($limit)');
    expect(q).toContain('AS source');
    expect(q).toContain('[(g)-[:REACHABLE_VIA]->(e:AgentEndpoint) | e.kind] AS reach');
    // still the ADR-084 catalog rule: represented agents follow their asset
    expect(q).toContain('NOT EXISTS { MATCH (:Asset)-[:REPRESENTS]->(g) }');
    expect(CYPHER.AGENT_LIBRARY_COUNT).toContain('count(g) AS total');
    expect(CYPHER.AGENT_LIBRARY_COUNT).toContain('coalesce(g.deleted, false) = false');
  });
});

describe('SdkSpacesClient agent library', () => {
  const mk = (rows: Array<Record<string, unknown>>) => {
    const calls: Array<{ cypher: string; params: Record<string, unknown> }> = [];
    const client = new SdkSpacesClient({
      query: (cypher: string, params?: Record<string, unknown>) => {
        calls.push({ cypher, params: params ?? {} });
        return Promise.resolve(rows);
      },
    } as never);
    return { client, calls };
  };
  it('binds offset + limit and maps source / reach (de-duplicated) / updatedMs / category', async () => {
    const { client, calls } = mk([{ id: 'a', name: 'Slack Share', description: 'Post', agentType: 'gsx', source: 'Playbooks', reach: ['api', 'api', 'mcp'], updatedMs: 5, category: 'social' }]);
    const rows = await client.searchAgentLibrary(' slack ', 50, 100);
    expect(calls[0]?.params).toMatchObject({ q: 'slack', limit: 50, offset: 100 });
    expect(rows[0]).toMatchObject({ id: 'a', source: 'Playbooks', reach: ['api', 'mcp'], updatedMs: 5, category: 'social' });
  });
  it('countAgentLibrary returns the total (0 when the row is missing)', async () => {
    expect(await mk([{ total: 12079 }]).client.countAgentLibrary('')).toBe(12079);
    expect(await mk([]).client.countAgentLibrary('x')).toBe(0);
  });
});

const entry = (over: Partial<AgentLibraryRowEntry>): AgentLibraryRowEntry => ({
  id: 'x', name: 'Slack Share', description: 'Post to Slack channel', agentType: 'gsx', source: 'Playbooks', reach: ['api'], updatedMs: 1, ...over,
});

describe('collapseAgentCopies', () => {
  it('folds identical name+description+source rows into one, keeping the newest id and counting copies', () => {
    const out = collapseAgentCopies([
      entry({ id: 'old', updatedMs: 1 }),
      entry({ id: 'newest', updatedMs: 9 }),
      entry({ id: 'mid', updatedMs: 5 }),
      entry({ id: 'other', name: 'Medium Article', description: 'Publish to Medium' }),
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ id: 'newest', copies: 3 });
    expect(out[1]).toMatchObject({ id: 'other', copies: 1 });
  });
  it('keeps different sources apart', () => {
    const out = collapseAgentCopies([entry({ id: 'p', source: 'Playbooks' }), entry({ id: 'l', source: 'GSX-Desktop' })]);
    expect(out.map((e) => e.id)).toEqual(['p', 'l']);
  });
});

describe('row + footer', () => {
  it('a row shows type, source label, reach chips, copies and recency', () => {
    const row = buildAgentLibraryRow(entry({ reach: ['mcp', 'api'], copies: 251, source: 'GSX-Desktop', updatedMs: Date.now() - 3600_000 }));
    const chips = Array.from(row.querySelectorAll('.spaces-agent-result-chip')).map((c) => c.textContent);
    expect(chips).toEqual(expect.arrayContaining(['Library', 'MCP', 'RESTful', '×251 copies']));
    expect(row.querySelector('.spaces-agent-result-type')?.textContent).toBe('gsx');
    expect(agentSourceLabel('Playbooks')).toBe('Playbooks');
    expect(agentSourceLabel('Onereach.ai Lite')).toBe('Lite');
  });
  it('the footer says N of M, counts collapsed copies, and Show more pages', () => {
    let more = 0;
    const footer = buildAgentLibraryFooter([entry({ copies: 3 }), entry({ id: 'y', copies: 1 })], { total: 12079, loaded: 50, hasMore: true, onMore: () => void (more += 1) });
    expect(footer.textContent).toContain('Showing 50 of 12,079 agents in NEON');
    expect(footer.textContent).toContain('2 duplicate copies collapsed');
    const btn = footer.querySelector('button') as HTMLButtonElement;
    btn.click();
    expect(more).toBe(1);
    expect(btn.disabled).toBe(true);
    const last = buildAgentLibraryFooter([entry({})], { total: 1, loaded: 1, hasMore: false, onMore: () => undefined });
    expect(last.querySelector('button')).toBeNull();
  });
});
