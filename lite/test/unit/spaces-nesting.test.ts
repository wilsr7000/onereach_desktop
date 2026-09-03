/**
 * ADR-085 — nested Spaces: a Space inside one or more Spaces, permissions
 * landing on the inner Space by default, with a per-edge opt-in to
 * inherit the parent's. Pins the query surface and the client contract.
 */

import { describe, it, expect } from 'vitest';
import { CYPHER, SdkSpacesClient } from '../../spaces/sdk-client.js';

const codeOf = (e: unknown): string | undefined =>
  (e as { code?: string }).code ?? (e as { details?: { code?: string } }).details?.code;

describe('NEST_SPACE', () => {
  const q = CYPHER.NEST_SPACE;
  it('is a write to BOTH Spaces', () => {
    expect(q).toContain("coalesce(s.createdBy, '') = $viewerId");
    expect(q).toContain("coalesce(p.createdBy, '') = $viewerId");
    expect(q).toContain("<> 'reader'");
  });
  it('refuses self-nesting and cycles', () => {
    expect(q).toContain('s.id <> p.id');
    expect(q).toContain('NOT EXISTS { MATCH (p)-[:NESTED_IN*1..8]->(s) }');
  });
  it('writes the edge child → parent with the opt-in flag, idempotently', () => {
    expect(q).toContain('MERGE (s)-[n:NESTED_IN]->(p)');
    expect(q).toContain('SET n.inheritsPermissions = $inherit, n.inheritsUntilUnixMs = $inheritUntil');
  });
});

describe('UNNEST_SPACE / SET_NEST_INHERITANCE', () => {
  it('either writer may unnest; only the CHILD\'s writer decides inheritance', () => {
    expect(CYPHER.UNNEST_SPACE).toContain("coalesce(s.createdBy, '') = $viewerId");
    expect(CYPHER.UNNEST_SPACE).toContain("coalesce(p.createdBy, '') = $viewerId");
    expect(CYPHER.SET_NEST_INHERITANCE).toContain("coalesce(s.createdBy, '') = $viewerId");
    expect(CYPHER.SET_NEST_INHERITANCE).not.toContain("coalesce(p.createdBy, '') = $viewerId");
  });
});

describe('listings gate both ends', () => {
  it('LIST_CHILD_SPACES gates the parent (s) and each child on its own', () => {
    expect(CYPHER.LIST_CHILD_SPACES).toContain("coalesce(s.createdBy, '') = $viewerId");
    expect(CYPHER.LIST_CHILD_SPACES).toContain("coalesce(child.createdBy, '') = $viewerId");
    // the alias helper rewrote the nested-chain pattern for the child too
    expect(CYPHER.LIST_CHILD_SPACES).toContain('(child)-[:NESTED_IN*1..6]->(top_child:Space)');
    expect(CYPHER.LIST_CHILD_SPACES).toContain('HAS_ACCESS]->(top_child)');
  });
  it('LIST_PARENT_SPACES gates the child (s) and each parent on its own', () => {
    expect(CYPHER.LIST_PARENT_SPACES).toContain("coalesce(parent.createdBy, '') = $viewerId");
    expect(CYPHER.LIST_PARENT_SPACES).toContain('(parent)-[:NESTED_IN*1..6]->(top_parent:Space)');
  });
});

describe('SdkSpacesClient nesting contract', () => {
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

  it('nestSpace refuses self-nesting before touching the graph', async () => {
    const { client, calls } = mk([]);
    await expect(client.nestSpace('space-a', 'space-a', false)).rejects.toSatisfy((e: unknown) => codeOf(e) === 'SPACES_INVALID_INPUT');
    expect(calls).toHaveLength(0);
  });

  it('nestSpace binds the opt-in flag and returns the edge as written', async () => {
    const { client, calls } = mk([{ childId: 'space-a', parentId: 'space-b', inheritsPermissions: true }]);
    const out = await client.nestSpace('space-a', 'space-b', true);
    expect(out).toEqual({ childId: 'space-a', parentId: 'space-b', inheritsPermissions: true });
    expect(calls[0]?.params['inherit']).toBe(true);
    expect(calls[0]?.cypher).toContain('MERGE (s)-[n:NESTED_IN]->(p)');
  });

  it('a TTL on the opt-in binds as epoch ms and comes back as ISO; it is dropped when inherit is off', async () => {
    const until = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const { client, calls } = mk([{ childId: 'space-a', parentId: 'space-b', inheritsPermissions: true, inheritsUntilUnixMs: Date.parse(until) }]);
    const out = await client.nestSpace('space-a', 'space-b', true, until);
    expect(typeof calls[0]?.params['inheritUntil']).toBe('number');
    expect(calls[0]?.params['inheritUntil']).toBeGreaterThan(Date.now());
    expect(out.inheritsUntil).toBe(new Date(Date.parse(until)).toISOString());
    const off = mk([{ childId: 'space-a', parentId: 'space-b', inheritsPermissions: false }]);
    await off.client.nestSpace('space-a', 'space-b', false, until);
    expect(off.calls[0]?.params['inheritUntil']).toBeNull();
  });

  it('an empty result is a refusal with a reason (no write access, or a cycle)', async () => {
    const { client } = mk([]);
    await expect(client.nestSpace('space-a', 'space-b', false)).rejects.toSatisfy((e: unknown) => codeOf(e) === 'SPACES_NOT_FOUND');
    await expect(client.setNestInheritance('space-a', 'space-b', true)).rejects.toSatisfy((e: unknown) => codeOf(e) === 'SPACES_NOT_FOUND');
    await expect(client.unnestSpace('space-a', 'space-b')).rejects.toSatisfy((e: unknown) => codeOf(e) === 'SPACES_NOT_FOUND');
  });

  it('listings map rows and drop the id-less', async () => {
    const { client } = mk([
      { id: 'space-c', name: 'Child', color: '#123456', kind: 'user', inheritsPermissions: false },
      { id: '', name: 'ghost' },
    ]);
    const out = await client.listChildSpaces('space-p');
    expect(out).toEqual([{ id: 'space-c', name: 'Child', color: '#123456', kind: 'user', inheritsPermissions: false }]);
  });
});
