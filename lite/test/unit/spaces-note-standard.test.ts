/**
 * ADR-059 — universal notes (registry entity `Note` v1.1.0).
 *
 * Lite is one writer among many (WISER Playbooks / OR-Mobile, agents)
 * against shared `:Note` nodes whose BODY lives in the shared Edison
 * KV store. These tests pin the contract Lite must hold up:
 *
 * - `note_<UUID>` ids, subtype labels, `notes:<account>` KV pointers
 * - KV merges NEVER drop fields other apps own (`basicNoteData`, …)
 * - the guarded update enforces newer-wins on `updated_at` and stamps
 *   schema_version + full writer provenance
 * - a conflict skips the KV write too (registry conflict rule)
 * - Lite-born notes are dual-label `:Asset:Note:BasicNote` with
 *   BELONGS_TO + CONTAINS written in lockstep
 */
import { describe, expect, it } from 'vitest';

import {
  buildNoteKvBody,
  createNoteCypher,
  generateNoteId,
  mergeNoteKvBody,
  noteKvCollection,
  noteKvRef,
  NOTE_SCHEMA_VERSION,
  NOTE_SUBTYPE_LABELS,
  UPDATE_NOTE_GUARDED,
  type NoteKvStore,
} from '../../spaces/note-standard';
import { CYPHER, SdkSpacesClient, type SpacesQueryFn } from '../../spaces/sdk-client';

// ─── module primitives ───────────────────────────────────────────────────

describe('note-standard primitives', () => {
  it('generateNoteId produces note_<UUID> (uppercase, per OR-Mobile convention)', () => {
    const id = generateNoteId();
    expect(id).toMatch(/^note_[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/);
  });

  it('KV pointers follow notes:<account> / note:<id>', () => {
    expect(noteKvCollection('robb@onereach.com')).toBe('notes:robb@onereach.com');
    expect(noteKvRef('note_ABC')).toBe('note:note_ABC');
  });

  it('subtype label map covers the registry list', () => {
    expect(NOTE_SUBTYPE_LABELS['Basic']).toBe('BasicNote');
    expect(NOTE_SUBTYPE_LABELS['Checklist']).toBe('ChecklistNote');
    expect(NOTE_SUBTYPE_LABELS['Ticket']).toBe('TicketNote');
    expect(NOTE_SUBTYPE_LABELS['Post']).toBe('PostNote');
    expect(NOTE_SUBTYPE_LABELS['Calendar Event']).toBe('CalendarEventNote');
    expect(NOTE_SUBTYPE_LABELS['Space']).toBe('SpaceNote');
    expect(NOTE_SUBTYPE_LABELS['Transcript']).toBe('TranscriptNote');
  });
});

// ─── KV body handling ────────────────────────────────────────────────────

describe('mergeNoteKvBody', () => {
  it('preserves every field it does not own (basicNoteData, provenance, space pointers)', () => {
    const existing = {
      id: 'note_X',
      title: 'Old title',
      content: 'old content',
      type: 'Basic',
      basicNoteData: { summary: 'wiser-owned summary', extras: [1, 2] },
      createdBy: 'robb@onereach.com',
      sourceApp: 'OR Mobile',
      spaceId: 'sp-1',
      spaceName: 'WISER Playbooks',
      createdAt: '2026-08-11T01:32:28.152Z',
      updatedAt: '2026-08-11T01:33:18.294Z',
      futureField: 'must survive',
    };
    const merged = mergeNoteKvBody(existing, { content: 'new content' }, '2026-08-12T00:00:00.000Z');
    expect(merged['content']).toBe('new content');
    expect(merged['title']).toBe('Old title');
    expect(merged['basicNoteData']).toEqual({ summary: 'wiser-owned summary', extras: [1, 2] });
    expect(merged['sourceApp']).toBe('OR Mobile');
    expect(merged['createdBy']).toBe('robb@onereach.com');
    expect(merged['spaceId']).toBe('sp-1');
    expect(merged['futureField']).toBe('must survive');
    expect(merged['updatedAt']).toBe('2026-08-12T00:00:00.000Z');
    expect(merged['createdAt']).toBe('2026-08-11T01:32:28.152Z');
  });

  it('only introduces description when patched (never adds fields uninvited)', () => {
    const noDesc = mergeNoteKvBody({ title: 't' }, { title: 't2' }, 'iso');
    expect('description' in noDesc).toBe(false);
    const withDesc = mergeNoteKvBody({ title: 't' }, { description: 'd' }, 'iso');
    expect(withDesc['description']).toBe('d');
  });

  it('tolerates a missing/corrupt existing body (starts fresh, still applies the patch)', () => {
    const merged = mergeNoteKvBody(null, { title: 'T', content: 'C' }, 'iso');
    expect(merged['title']).toBe('T');
    expect(merged['content']).toBe('C');
    expect(merged['updatedAt']).toBe('iso');
    expect(mergeNoteKvBody('garbage-string', { title: 'T' }, 'iso')['title']).toBe('T');
  });
});

describe('buildNoteKvBody', () => {
  it('builds the OR-Mobile-compatible body shape', () => {
    const body = buildNoteKvBody({
      id: 'note_AAAA',
      title: 'T',
      content: 'C',
      type: 'Basic',
      createdBy: 'robb@onereach.com',
      spaceId: 'sp-1',
      spaceName: 'WISER Playbooks',
      nowIso: '2026-08-12T00:00:00.000Z',
    });
    expect(body).toMatchObject({
      id: 'note_AAAA',
      localId: 'AAAA',
      title: 'T',
      content: 'C',
      type: 'Basic',
      createdBy: 'robb@onereach.com',
      sourceApp: 'Onereach.ai Lite',
      spaceId: 'sp-1',
      spaceName: 'WISER Playbooks',
      createdAt: '2026-08-12T00:00:00.000Z',
      updatedAt: '2026-08-12T00:00:00.000Z',
    });
    expect('description' in body).toBe(false);
  });
});

// ─── Cypher contracts ────────────────────────────────────────────────────

describe('UPDATE_NOTE_GUARDED cypher', () => {
  it('enforces newer-wins on updated_at', () => {
    expect(UPDATE_NOTE_GUARDED).toContain('coalesce(n.updated_at, 0) <= $baseUpdatedAt');
  });

  it('stamps schema_version + full writer provenance in both timestamp conventions', () => {
    expect(UPDATE_NOTE_GUARDED).toContain(`n.schema_version = '${NOTE_SCHEMA_VERSION}'`);
    expect(UPDATE_NOTE_GUARDED).toContain('n.updated_at = $nowMs');
    expect(UPDATE_NOTE_GUARDED).toContain('n.updatedAt = $nowMs');
    expect(UPDATE_NOTE_GUARDED).toContain("n.updated_by_app_name = 'Onereach.ai Lite'");
    expect(UPDATE_NOTE_GUARDED).toContain("n.updated_by_app_id = 'onereach-lite'");
    expect(UPDATE_NOTE_GUARDED).toContain('n.updated_by_user = $viewerId');
    expect(UPDATE_NOTE_GUARDED).toContain("n.updated_by_actor_type = 'human'");
    expect(UPDATE_NOTE_GUARDED).toContain("n.updated_by_source = 'lite-spaces'");
  });

  it('content SETs are gated on $setContent (dual-label items defer to UPDATE_ITEM)', () => {
    expect(UPDATE_NOTE_GUARDED).toContain('CASE WHEN $setContent AND $title IS NOT NULL');
    expect(UPDATE_NOTE_GUARDED).toContain('CASE WHEN $setContent AND $content IS NOT NULL');
  });
});

describe('createNoteCypher', () => {
  const GUARD = "($viewerId <> '' AND coalesce(s.createdBy,'') = $viewerId)";
  const cypher = createNoteCypher('BasicNote', { spaceWritable: GUARD });

  it('gates the Space MATCH with the caller-supplied writable guard, BEFORE any MERGE (2026-09-01 audit)', () => {
    const matchIdx = cypher.indexOf('MATCH (s:Space {id: $spaceId})');
    const guardIdx = cypher.indexOf(GUARD);
    const mergeIdx = cypher.indexOf('MERGE (n:Note {id: $id})');
    expect(matchIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeGreaterThan(matchIdx);
    expect(guardIdx).toBeLessThan(mergeIdx);
  });

  it('refuses to build an unguarded note Cypher', () => {
    expect(() => createNoteCypher('BasicNote', { spaceWritable: '' })).toThrow(/spaceWritable/);
    expect(() => (createNoteCypher as unknown as (l: string) => string)('BasicNote')).toThrow(/spaceWritable/);
  });

  it('MERGEs on id and dual-labels :Asset + subtype', () => {
    expect(cypher).toContain('MERGE (n:Note {id: $id})');
    expect(cypher).toContain('SET n:Asset, n:BasicNote');
  });

  it('writes BELONGS_TO and CONTAINS in lockstep', () => {
    expect(cypher).toContain('MERGE (n)-[:BELONGS_TO]->(s)');
    expect(cypher).toContain('MERGE (s)-[:CONTAINS]->(n)');
  });

  it('stamps the registry provenance + KV pointer + item:added commit', () => {
    expect(cypher).toContain('n.kv_collection = $kvCollection');
    expect(cypher).toContain('n.kv_ref = $kvRef');
    expect(cypher).toContain(`n.schema_version = '${NOTE_SCHEMA_VERSION}'`);
    expect(cypher).toContain("c.message = 'item:added'");
  });
});

// ─── client behavior ─────────────────────────────────────────────────────

interface QueryCall {
  cypher: string;
  parameters: Record<string, unknown> | undefined;
}

function buildStub(): {
  fn: SpacesQueryFn;
  calls: QueryCall[];
  setResponse(needle: string, rows: Array<Record<string, unknown>>): void;
} {
  const calls: QueryCall[] = [];
  const responses = new Map<string, Array<Record<string, unknown>>>();
  const fn: SpacesQueryFn = async (cypher, parameters) => {
    const { nowMs: _n, ...rest } = (parameters ?? {}) as Record<string, unknown>;
    calls.push({ cypher, parameters: parameters === undefined ? undefined : rest });
    for (const [needle, rows] of responses) {
      if (cypher.includes(needle)) return rows;
    }
    return [];
  };
  return { fn, calls, setResponse: (needle, rows) => responses.set(needle, rows) };
}

function buildKvStub(initial: Record<string, unknown> | null): {
  store: NoteKvStore;
  gets: Array<[string, string]>;
  sets: Array<[string, string, unknown]>;
} {
  const gets: Array<[string, string]> = [];
  const sets: Array<[string, string, unknown]> = [];
  return {
    store: {
      get: async (c, k) => {
        gets.push([c, k]);
        return initial;
      },
      set: async (c, k, v) => {
        sets.push([c, k, v]);
      },
    },
    gets,
    sets,
  };
}

/** A GET_ITEM row for a pure WISER note (no :Asset label). */
function wiserNoteRow(): Record<string, unknown> {
  return {
    id: 'note_A8F4',
    title: 'Email Triage',
    kind: 'text',
    createdAt: '',
    updatedAt: '',
    otherSpaces: [],
    producedBy: null,
    tags: [],
    content: 'old body',
    isNote: true,
    isAsset: false,
    noteKvCollection: 'notes:robb@onereach.com',
    noteKvRef: 'note:note_A8F4',
    noteUpdatedAtMs: 1000,
    noteSubtype: 'Basic',
  };
}

describe('SdkSpacesClient note routing (ADR-059)', () => {
  it('GET_ITEM projects the note-detection fields', () => {
    expect(CYPHER.GET_ITEM).toContain('a:Note AS isNote');
    expect(CYPHER.GET_ITEM).toContain('a:Asset AS isAsset');
    expect(CYPHER.GET_ITEM).toContain('a.kv_collection AS noteKvCollection');
    expect(CYPHER.GET_ITEM).toContain('a.kv_ref AS noteKvRef');
    expect(CYPHER.GET_ITEM).toContain('coalesce(a.updated_at, 0) AS noteUpdatedAtMs');
  });

  it('getItem attaches NoteItemMeta when the label is present', async () => {
    const stub = buildStub();
    stub.setResponse("coalesce(a.content, '') AS content", [wiserNoteRow()]);
    const client = new SdkSpacesClient({ query: stub.fn });
    const item = await client.getItem('note_A8F4');
    expect(item?.note).toEqual({
      kvCollection: 'notes:robb@onereach.com',
      kvRef: 'note:note_A8F4',
      updatedAtMs: 1000,
      subtype: 'Basic',
      isAsset: false,
    });
  });

  it('editing a pure note runs the guarded update (setContent=true) and merges the KV body', async () => {
    const stub = buildStub();
    stub.setResponse("coalesce(a.content, '') AS content", [wiserNoteRow()]);
    stub.setResponse('MATCH (n:Note {id: $id})', [{ id: 'note_A8F4' }]);
    const kv = buildKvStub({
      title: 'Email Triage',
      content: 'old body',
      basicNoteData: { summary: 'wiser-owned' },
      sourceApp: 'OR Mobile',
    });
    const client = new SdkSpacesClient({ query: stub.fn, noteKv: kv.store });
    await client.updateItem('note_A8F4', { content: 'new body' });

    const guard = stub.calls.find((c) => c.cypher.includes('MATCH (n:Note {id: $id})'));
    expect(guard?.parameters).toMatchObject({
      id: 'note_A8F4',
      baseUpdatedAt: 1000,
      setContent: true,
      content: 'new body',
    });
    // No :Asset machinery for a pure note — no UPDATE_ITEM call.
    expect(stub.calls.some((c) => c.cypher.includes('$doSnapshot'))).toBe(false);
    // KV body merged: patched content, preserved foreign fields.
    expect(kv.sets).toHaveLength(1);
    const setCall = kv.sets[0];
    if (setCall === undefined) throw new Error('kv.set not called');
    const [coll, key, body] = setCall;
    expect(coll).toBe('notes:robb@onereach.com');
    expect(key).toBe('note:note_A8F4');
    expect(body).toMatchObject({
      content: 'new body',
      basicNoteData: { summary: 'wiser-owned' },
      sourceApp: 'OR Mobile',
    });
  });

  it('a conflict (0 guard rows) throws SPACES_NOTE_CONFLICT and skips the KV write', async () => {
    const stub = buildStub();
    stub.setResponse("coalesce(a.content, '') AS content", [wiserNoteRow()]);
    // No response registered for the guard → 0 rows → conflict.
    const kv = buildKvStub({});
    const client = new SdkSpacesClient({ query: stub.fn, noteKv: kv.store });
    await expect(client.updateItem('note_A8F4', { content: 'x' })).rejects.toMatchObject({
      code: 'SPACES_NOTE_CONFLICT',
    });
    expect(kv.sets).toHaveLength(0);
  });

  it('a kind change on a note is refused (SPACES_NOTE_TYPE_LOCKED)', async () => {
    const stub = buildStub();
    stub.setResponse("coalesce(a.content, '') AS content", [wiserNoteRow()]);
    const client = new SdkSpacesClient({ query: stub.fn });
    await expect(client.updateItem('note_A8F4', { type: 'url' })).rejects.toMatchObject({
      code: 'SPACES_NOTE_TYPE_LOCKED',
    });
  });

  it('editing a dual-label :Asset:Note runs guard (setContent=false) AND the ADR-057 machinery', async () => {
    const stub = buildStub();
    const row = { ...wiserNoteRow(), isAsset: true };
    stub.setResponse("coalesce(a.content, '') AS content", [row]);
    stub.setResponse('MATCH (n:Note {id: $id})', [{ id: 'note_A8F4' }]);
    const kv = buildKvStub({ title: 'Email Triage', content: 'old body' });
    const client = new SdkSpacesClient({ query: stub.fn, noteKv: kv.store });
    await client.updateItem('note_A8F4', { content: 'new body' });

    const guard = stub.calls.find((c) => c.cypher.includes('MATCH (n:Note {id: $id})'));
    expect(guard?.parameters).toMatchObject({ setContent: false });
    // The version machinery DID run for the dual-label item.
    expect(stub.calls.some((c) => c.cypher.includes('$doSnapshot'))).toBe(true);
    expect(kv.sets).toHaveLength(1);
  });

  it('a note without a KV pointer updates graph-only (no KV traffic, no throw)', async () => {
    const stub = buildStub();
    const row = { ...wiserNoteRow(), noteKvCollection: null, noteKvRef: null };
    stub.setResponse("coalesce(a.content, '') AS content", [row]);
    stub.setResponse('MATCH (n:Note {id: $id})', [{ id: 'note_A8F4' }]);
    const kv = buildKvStub({});
    const client = new SdkSpacesClient({ query: stub.fn, noteKv: kv.store });
    await client.updateItem('note_A8F4', { content: 'x' });
    expect(kv.gets).toHaveLength(0);
    expect(kv.sets).toHaveLength(0);
  });

  it('a KV failure after the graph write surfaces SPACES_NOTE_KV_WRITE_FAILED', async () => {
    const stub = buildStub();
    stub.setResponse("coalesce(a.content, '') AS content", [wiserNoteRow()]);
    stub.setResponse('MATCH (n:Note {id: $id})', [{ id: 'note_A8F4' }]);
    const failing: NoteKvStore = {
      get: async () => ({}),
      set: async () => {
        throw new Error('edison down');
      },
    };
    const client = new SdkSpacesClient({ query: stub.fn, noteKv: failing });
    await expect(client.updateItem('note_A8F4', { content: 'x' })).rejects.toMatchObject({
      code: 'SPACES_NOTE_KV_WRITE_FAILED',
    });
  });

  it('creating text in a Space births a dual-label note citizen with KV body', async () => {
    const stub = buildStub();
    stub.setResponse('MERGE (n:Note {id: $id})', [{ id: 'stub', spaceName: 'WISER Playbooks' }]);
    stub.setResponse("coalesce(a.content, '') AS content", [
      { ...wiserNoteRow(), isAsset: true, title: 'Fresh note' },
    ]);
    const kv = buildKvStub(null);
    const client = new SdkSpacesClient({
      query: stub.fn,
      noteKv: kv.store,
      noteAccount: () => 'robb@onereach.com',
    });
    const created = await client.createAsset({
      spaceId: 'sp-1',
      title: 'Fresh note',
      content: 'Hello',
    });
    expect(created.title).toBe('Fresh note');
    const create = stub.calls.find((c) => c.cypher.includes('MERGE (n:Note {id: $id})'));
    expect(create).toBeDefined();
    expect(create?.cypher).toContain('SET n:Asset, n:BasicNote');
    expect(create?.parameters).toMatchObject({
      spaceId: 'sp-1',
      title: 'Fresh note',
      content: 'Hello',
      subtype: 'Basic',
      kvCollection: 'notes:robb@onereach.com',
    });
    expect(String(create?.parameters?.['id'])).toMatch(/^note_/);
    // KV body written with the OR-Mobile-compatible shape.
    expect(kv.sets).toHaveLength(1);
    const setCall = kv.sets[0];
    if (setCall === undefined) throw new Error('kv.set not called');
    expect(setCall[2]).toMatchObject({
      title: 'Fresh note',
      content: 'Hello',
      type: 'Basic',
      sourceApp: 'Onereach.ai Lite',
      createdBy: 'robb@onereach.com',
      spaceId: 'sp-1',
      spaceName: 'WISER Playbooks',
    });
  });

  it('signed-out text create still works — graph-only note, no KV traffic', async () => {
    const stub = buildStub();
    stub.setResponse('MERGE (n:Note {id: $id})', [{ id: 'stub', spaceName: 'S' }]);
    stub.setResponse("coalesce(a.content, '') AS content", [{ ...wiserNoteRow(), isAsset: true }]);
    const kv = buildKvStub(null);
    const client = new SdkSpacesClient({ query: stub.fn, noteKv: kv.store });
    await client.createAsset({ spaceId: 'sp-1', title: 'T', content: 'C' });
    const create = stub.calls.find((c) => c.cypher.includes('MERGE (n:Note {id: $id})'));
    expect(create?.parameters).toMatchObject({ kvCollection: null, kvRef: null });
    expect(kv.sets).toHaveLength(0);
  });

  it('uncategorized text (no space) stays a plain :Asset draft', async () => {
    const stub = buildStub();
    stub.setResponse('CREATE (a:Asset', [{ id: 'asset-1' }]);
    stub.setResponse("coalesce(a.content, '') AS content", [
      {
        id: 'asset-1',
        title: 'Draft',
        kind: 'text',
        createdAt: '',
        updatedAt: '',
        otherSpaces: [],
        producedBy: null,
        tags: [],
      },
    ]);
    const client = new SdkSpacesClient({ query: stub.fn });
    await client.createAsset({ spaceId: '', title: 'Draft', content: 'C' });
    expect(stub.calls.some((c) => c.cypher.includes('MERGE (n:Note {id: $id})'))).toBe(false);
    expect(stub.calls.some((c) => c.cypher.includes('CREATE (a:Asset'))).toBe(true);
  });
});

describe('membership ops honor member labels + CONTAINS lockstep (ADR-059)', () => {
  it('MOVE / ADD / REMOVE / SOFT_DELETE match the member label set, not just :Asset', () => {
    for (const q of [
      CYPHER.MOVE_ASSET_TO_SPACE,
      CYPHER.ADD_ASSET_TO_SPACE,
      CYPHER.REMOVE_ASSET_FROM_SPACE,
      CYPHER.SOFT_DELETE_ASSET,
    ]) {
      expect(q).toContain('a:Asset OR a:Playbook OR a:Note');
    }
  });

  it('MOVE and ADD maintain the CONTAINS inverse edge for :Note members', () => {
    expect(CYPHER.MOVE_ASSET_TO_SPACE).toContain('MERGE (target)-[:CONTAINS]->(a)');
    expect(CYPHER.MOVE_ASSET_TO_SPACE).toContain('DELETE old, oldContains');
    expect(CYPHER.ADD_ASSET_TO_SPACE).toContain('MERGE (target)-[:CONTAINS]->(a)');
  });

  it('REMOVE drops the CONTAINS edge alongside BELONGS_TO', () => {
    expect(CYPHER.REMOVE_ASSET_FROM_SPACE).toContain('OPTIONAL MATCH (s)-[c:CONTAINS]->(a)');
    expect(CYPHER.REMOVE_ASSET_FROM_SPACE).toContain('DELETE r, c');
  });
});
