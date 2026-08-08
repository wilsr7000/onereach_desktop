/**
 * Asset versioning (ADR-057) — edits go back in time.
 *
 * Load-bearing behaviors:
 *
 *   1. A REAL edit snapshots the replaced state; a NO-OP edit does not.
 *      The client hashes the outgoing vs incoming state and only sets
 *      `$doSnapshot` when they differ — otherwise every metadata-only
 *      touch would mint an identical, useless version.
 *
 *   2. RESTORE is an edit, not a rewrite. The current state is
 *      snapshotted first (stamped restoredFromSeq), so nothing — not
 *      even the present — is lost, and you can restore back to it.
 *
 *   3. Every version READ carries the ADR-051 visibility predicate.
 */

import { describe, it, expect } from 'vitest';
import { SdkSpacesClient, CYPHER, hashAssetState } from '../../spaces/sdk-client.js';

const NOW = Date.parse('2026-08-08T12:00:00.000Z');

interface Recorded {
  cypher: string;
  params: Record<string, unknown>;
}

function client(respond: (cypher: string) => Array<Record<string, unknown>>): {
  api: SdkSpacesClient;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  const api = new SdkSpacesClient({
    now: () => NOW,
    viewerId: () => 'robb@onereach.com',
    query: async (cypher: string, params?: Record<string, unknown>) => {
      calls.push({ cypher, params: params ?? {} });
      return respond(cypher);
    },
  });
  return { api, calls };
}

/** A GET_ITEM row the pre-read reads back. */
function itemRow(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'a-1',
    title: 'Doc',
    kind: 'text',
    description: 'desc',
    content: 'hello world',
    createdAt: '',
    updatedAt: '',
    otherSpaces: [],
    producedBy: null,
    ...over,
  };
}

// ─── 1. The snapshot decision ────────────────────────────────────────────

describe('hashAssetState — the no-op-edit guard', () => {
  it('is stable for identical state and field-separated (no boundary collisions)', () => {
    expect(hashAssetState('a', 'b', 'c', 'text')).toBe(hashAssetState('a', 'b', 'c', 'text'));
    // "ab|c" must not equal "a|bc"
    expect(hashAssetState('ab', 'c', '', 'text')).not.toBe(hashAssetState('a', 'bc', '', 'text'));
  });

  it('changes when any field changes', () => {
    const base = hashAssetState('t', 'd', 'body', 'text');
    expect(hashAssetState('t2', 'd', 'body', 'text')).not.toBe(base);
    expect(hashAssetState('t', 'd', 'body2', 'text')).not.toBe(base);
  });
});

describe('updateItem — snapshot only on real change', () => {
  it('sets doSnapshot=true and a versionId when content actually changes', async () => {
    const { api, calls } = client((cypher) =>
      cypher.includes('coalesce(a.type, a.assetType') || cypher.includes('MATCH (a:Asset {id:')
        ? [itemRow()]
        : []
    );
    await api.updateItem('a-1', { content: 'goodbye world' });
    const update = calls.find((c) => c.cypher.includes('CREATE (v:AssetVersion'));
    expect(update?.params['doSnapshot']).toBe(true);
    expect(String(update?.params['versionId'])).toMatch(/^version-/);
    expect(update?.params['prevHash']).not.toBe(update?.params['newHash']);
    expect(update?.params['maxVersions']).toBe(50);
  });

  it('sets doSnapshot=false when the resulting state is identical', async () => {
    const { api, calls } = client(() => [itemRow()]);
    // Re-submit the SAME content/title/description the pre-read returns.
    await api.updateItem('a-1', {
      title: 'Doc',
      description: 'desc',
      content: 'hello world',
    });
    const update = calls.find((c) => c.cypher.includes('CREATE (v:AssetVersion'));
    expect(update?.params['doSnapshot']).toBe(false);
    expect(update?.params['prevHash']).toBe(update?.params['newHash']);
  });

  it('writes an item:edited Commit shape', () => {
    expect(CYPHER.UPDATE_ITEM).toContain("c.message = 'item:edited'");
    expect(CYPHER.UPDATE_ITEM).toContain('currentMatchesSeq');
  });
});

// ─── 2. Restore is an edit ────────────────────────────────────────────────

describe('restoreItemVersion — snapshots the present first', () => {
  it('snapshots current (restoredFromSeq) before copying the target back', async () => {
    const { api, calls } = client((cypher) =>
      cypher.includes('RESTORE') || cypher.includes('CREATE (cur:AssetVersion')
        ? [{ id: 'a-1' }]
        : [itemRow()]
    );
    await api.restoreItemVersion('a-1', 3, 'robb@onereach.com');
    const restore = calls.find((c) => c.cypher.includes('CREATE (cur:AssetVersion'));
    expect(restore?.params['seq']).toBe(3);
    expect(restore?.params['editorId']).toBe('robb@onereach.com');
    expect(restore?.params['viewerId']).toBe('robb@onereach.com');
  });

  it('the restore Cypher stamps restoredFromSeq and never deletes history except pruning', () => {
    expect(CYPHER.RESTORE_ASSET_VERSION).toContain('restoredFromSeq: $seq');
    expect(CYPHER.RESTORE_ASSET_VERSION).toContain("c.message = 'item:restored'");
    // The only DELETE is the prune of versions older than maxVersions.
    const deletes = CYPHER.RESTORE_ASSET_VERSION.match(/DETACH DELETE/g) ?? [];
    expect(deletes.length).toBe(1);
    expect(CYPHER.RESTORE_ASSET_VERSION).toContain('$maxVersions');
  });
});

// ─── 3. Visibility + schema shape ────────────────────────────────────────

describe('version queries carry visibility + register schema', () => {
  it('all version reads are ASSET_VISIBLE-gated ($viewerId)', () => {
    expect(CYPHER.LIST_ASSET_VERSIONS).toContain('$viewerId');
    expect(CYPHER.GET_ASSET_VERSION).toContain('$viewerId');
    expect(CYPHER.RESTORE_ASSET_VERSION).toContain('$viewerId');
    expect(CYPHER.ANNOTATE_VERSION_BY_HASH).toContain('$viewerId');
  });

  it('history is newest-first and content-free in the list projection', () => {
    expect(CYPHER.LIST_ASSET_VERSIONS).toContain('ORDER BY v.seq DESC');
    expect(CYPHER.LIST_ASSET_VERSIONS).not.toContain('v.content AS content');
  });

  it('the schema registry write covers the entity and the edge', () => {
    expect(CYPHER.ENSURE_VERSION_SCHEMA).toContain("entity: 'AssetVersion'");
    expect(CYPHER.ENSURE_VERSION_SCHEMA).toContain('hasVersion');
  });

  it('listItemVersions returns [] cleanly when there is no history', async () => {
    const { api } = client(() => []);
    const rows = await api.listItemVersions('a-1');
    expect(rows).toEqual([]);
  });
});

describe('AI annotation targets the version by hash, not "latest"', () => {
  it('the annotate Cypher matches contentHash and takes the newest such snapshot', () => {
    expect(CYPHER.ANNOTATE_VERSION_BY_HASH).toContain('{contentHash: $prevHash}');
    expect(CYPHER.ANNOTATE_VERSION_BY_HASH).toContain('ORDER BY v.seq DESC LIMIT 1');
  });

  it('describeVersion sends the hash + clipped summary', async () => {
    const { api, calls } = client(() => [{ seq: 2 }]);
    await api.describeVersion('a-1', 'hash-abc', '  Rewrote the intro.  ');
    const call = calls.find((c) => c.cypher.includes('contentHash: $prevHash'));
    expect(call?.params['prevHash']).toBe('hash-abc');
    expect(call?.params['summary']).toBe('Rewrote the intro.');
  });
});
