/**
 * Memory-ingest engine (ADR-079: "connect an mcp server for ingesting
 * items in the space... All items should be sent to MCP server for
 * ingestion unless it already is flagged"). Pins the load-bearing
 * behaviors: the flag is HASH-keyed per (item, server) — same hash
 * skips, changed hash re-sends, and a second server never inherits the
 * first one's flag; failures never write a flag; tool resolution never
 * implicitly picks a destructive tool.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  addServer,
  listServers,
  removeServer,
  type MemoryConfigKV,
} from '../../memory-ingest/store.js';
import {
  buildIngestArgs,
  resolveIngestTool,
  type MemorySession,
  type RemoteTool,
} from '../../memory-ingest/client.js';
import {
  composeDocument,
  ingestSpace,
  itemContentSha,
  parseIngestFlags,
  type EngineItem,
  type EngineSpacesApi,
} from '../../memory-ingest/engine.js';
import { INGEST_FLAG_KEY, type MemoryServerConfig } from '../../memory-ingest/types.js';

// ─── helpers ──────────────────────────────────────────────────────────────

function mapKV(): MemoryConfigKV & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    async get(c, k) {
      return data.get(`${c}/${k}`) ?? null;
    },
    async set(c, k, v) {
      data.set(`${c}/${k}`, v);
    },
  };
}

function server(over: Partial<MemoryServerConfig> = {}): MemoryServerConfig {
  return {
    id: 'srv-1',
    name: 'Team memory',
    url: 'https://memory.example.com/mcp',
    createdAt: '2026-08-28T00:00:00.000Z',
    ...over,
  };
}

interface FakeWorld {
  items: Map<string, EngineItem>;
  patched: Array<{ id: string; patch: Record<string, string> }>;
  spaces: EngineSpacesApi;
}

function fakeSpaces(items: EngineItem[]): FakeWorld {
  const map = new Map(items.map((i) => [i.id, i]));
  const patched: FakeWorld['patched'] = [];
  return {
    items: map,
    patched,
    spaces: {
      async listItemIds() {
        return [...map.keys()];
      },
      async getItem(id) {
        const item = map.get(id);
        if (item === undefined) throw new Error(`no item ${id}`);
        return item;
      },
      async patchMetadata(id, patch) {
        patched.push({ id, patch });
        const item = map.get(id);
        if (item !== undefined) {
          item.metadata = { ...(item.metadata ?? {}), ...patch };
        }
      },
      async getSpaceName() {
        return 'Data Bricks';
      },
    },
  };
}

function fakeSession(calls: Array<{ name: string; args: Record<string, unknown> }>): MemorySession {
  return {
    async listTools() {
      return [
        { name: 'ingest_document', inputSchema: { type: 'object', properties: { content: { type: 'string' }, title: { type: 'string' } }, required: ['content'] } },
      ];
    },
    async callTool(name, args) {
      calls.push({ name, args });
    },
    async close() {},
  };
}

// ─── config store ─────────────────────────────────────────────────────────

describe('server config store', () => {
  it('add → list → remove round-trips through KV', async () => {
    const kv = mapKV();
    const added = await addServer(kv, {
      name: ' Team memory ',
      url: 'https://memory.example.com/mcp',
      apiKey: 'sk-test',
    });
    expect(added.name).toBe('Team memory');
    expect((await listServers(kv)).map((s) => s.id)).toEqual([added.id]);
    await removeServer(kv, added.id);
    expect(await listServers(kv)).toEqual([]);
  });

  it('rejects blank fields, bad URLs, and duplicate URLs', async () => {
    const kv = mapKV();
    await expect(addServer(kv, { name: '', url: 'https://x.dev' })).rejects.toThrow('Name');
    await expect(addServer(kv, { name: 'X', url: 'not a url' })).rejects.toThrow('valid URL');
    await expect(addServer(kv, { name: 'X', url: 'ftp://x.dev' })).rejects.toThrow('http');
    await addServer(kv, { name: 'A', url: 'https://x.dev/mcp' });
    await expect(addServer(kv, { name: 'B', url: 'https://x.dev/mcp' })).rejects.toThrow('already connected');
  });

  it('malformed KV documents degrade to an empty list, never a throw', async () => {
    const kv = mapKV();
    kv.data.set('lite-memory-config/servers', { servers: 'garbage' });
    expect(await listServers(kv)).toEqual([]);
    kv.data.set('lite-memory-config/servers', { servers: [{ id: 1 }, server()] });
    expect((await listServers(kv)).map((s) => s.name)).toEqual(['Team memory']);
  });
});

// ─── tool resolution + arg mapping ────────────────────────────────────────

describe('remote tool resolution', () => {
  const tools: RemoteTool[] = [
    { name: 'delete_memory' },
    { name: 'search_memories' },
    { name: 'add_memory' },
  ];

  it('never implicitly picks destructive or read tools', () => {
    expect(resolveIngestTool(tools)?.name).toBe('add_memory');
    expect(resolveIngestTool([{ name: 'delete_memory' }, { name: 'query' }])).toBeUndefined();
  });

  it('an explicit toolName wins over every heuristic', () => {
    expect(resolveIngestTool(tools, 'delete_memory')?.name).toBe('delete_memory');
    expect(resolveIngestTool(tools, 'nope')).toBeUndefined();
  });

  it('prefers ingest-named tools over generic memory tools', () => {
    const t = resolveIngestTool([{ name: 'add_memory' }, { name: 'ingest' }]);
    expect(t?.name).toBe('ingest');
  });
});

describe('argument mapping', () => {
  const payload = {
    itemId: 'i-1',
    title: 'Plan A',
    kind: 'doc',
    spaceId: 'sp-1',
    spaceName: 'Data Bricks',
    document: '# Plan A\n\nbody',
    contentSha256: 'abc',
  };

  it('fills the body property and only schema-declared extras', () => {
    const args = buildIngestArgs(
      { name: 't', inputSchema: { type: 'object', properties: { information: { type: 'string' }, metadata: {} }, required: ['information'] } },
      payload
    );
    expect(args.information).toBe(payload.document);
    expect(args.metadata).toMatchObject({ itemId: 'i-1', spaceId: 'sp-1' });
    expect('title' in args).toBe(false);
  });

  it('falls back to the first required string property', () => {
    const args = buildIngestArgs(
      { name: 't', inputSchema: { type: 'object', properties: { blob: { type: 'string' } }, required: ['blob'] } },
      payload
    );
    expect(args.blob).toBe(payload.document);
  });

  it('schema-less tools get the conventional shape; unmappable schemas throw', () => {
    expect(buildIngestArgs({ name: 't' }, payload)).toMatchObject({ content: payload.document });
    expect(() =>
      buildIngestArgs(
        { name: 't', inputSchema: { type: 'object', properties: { count: { type: 'number' } }, required: [] } },
        payload
      )
    ).toThrow('no recognizable text property');
  });
});

// ─── flags + hashing ──────────────────────────────────────────────────────

describe('flag parsing and content identity', () => {
  it('malformed flag JSON degrades to empty (item just re-ingests)', () => {
    expect(parseIngestFlags('not json')).toEqual({});
    expect(parseIngestFlags('[1,2]')).toEqual({});
    expect(parseIngestFlags(JSON.stringify({ s1: { sha: 'x', at: 't', name: 'n' } }))).toMatchObject({ s1: { sha: 'x' } });
  });

  it('prefers the intake-stamped contentSha256; otherwise hashes visible fields', () => {
    const stamped: EngineItem = { id: 'a', title: 'T', kind: 'file', metadata: { contentSha256: 'deadbeef' } };
    expect(itemContentSha(stamped)).toBe('deadbeef');
    const a = itemContentSha({ id: 'a', title: 'T', kind: 'doc', content: 'one' });
    const b = itemContentSha({ id: 'a', title: 'T', kind: 'doc', content: 'two' });
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('composes a document with space context, description, and content', () => {
    const doc = composeDocument(
      { id: 'a', title: 'Plan A', kind: 'doc', description: 'the plan', content: 'body', sourceUrl: 'https://x.dev' },
      'Data Bricks'
    );
    expect(doc).toContain('# Plan A');
    expect(doc).toContain('Space: Data Bricks');
    expect(doc).toContain('Source: https://x.dev');
    expect(doc).toContain('the plan');
    expect(doc).toContain('body');
  });
});

// ─── the engine ───────────────────────────────────────────────────────────

describe('ingestSpace', () => {
  it('sends unflagged items, writes hash-keyed flags, then skips them next run', async () => {
    const world = fakeSpaces([
      { id: 'i-1', title: 'A', kind: 'doc', content: 'alpha' },
      { id: 'i-2', title: 'B', kind: 'doc', content: 'beta' },
    ]);
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const deps = {
      spaces: world.spaces,
      servers: [server()],
      connect: async () => fakeSession(calls),
      nowIso: () => '2026-08-28T01:00:00.000Z',
    };
    const first = await ingestSpace('sp-1', deps);
    expect(first.sent).toBe(2);
    expect(first.failed).toEqual([]);
    expect(calls.map((c) => c.name)).toEqual(['ingest_document', 'ingest_document']);
    const flag = JSON.parse(world.items.get('i-1')!.metadata![INGEST_FLAG_KEY] as string);
    expect(flag['srv-1'].sha).toBe(itemContentSha(world.items.get('i-1')!));

    const second = await ingestSpace('sp-1', deps);
    expect(second.sent).toBe(0);
    expect(second.skipped).toBe(2);
  });

  it('a changed content hash re-arms the pair', async () => {
    const world = fakeSpaces([{ id: 'i-1', title: 'A', kind: 'doc', content: 'v1' }]);
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const deps = { spaces: world.spaces, servers: [server()], connect: async () => fakeSession(calls) };
    await ingestSpace('sp-1', deps);
    world.items.get('i-1')!.content = 'v2 — edited';
    const rerun = await ingestSpace('sp-1', deps);
    expect(rerun.sent).toBe(1);
    expect(calls).toHaveLength(2);
  });

  it('flags are per-server: a second server starts cold and the first still skips', async () => {
    const world = fakeSpaces([{ id: 'i-1', title: 'A', kind: 'doc', content: 'x' }]);
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const connect = async (): Promise<MemorySession> => fakeSession(calls);
    await ingestSpace('sp-1', { spaces: world.spaces, servers: [server()], connect });
    const both = await ingestSpace('sp-1', {
      spaces: world.spaces,
      servers: [server(), server({ id: 'srv-2', name: 'Second brain' })],
      connect,
    });
    expect(both.perServer['srv-1']).toMatchObject({ sent: 0, skipped: 1 });
    expect(both.perServer['srv-2']).toMatchObject({ sent: 1, skipped: 0 });
  });

  it('a failed call records a failure and does NOT write a flag', async () => {
    const world = fakeSpaces([{ id: 'i-1', title: 'A', kind: 'doc', content: 'x' }]);
    const failing: MemorySession = {
      ...fakeSession([]),
      async callTool() {
        throw new Error('server said no');
      },
    };
    const run = await ingestSpace('sp-1', {
      spaces: world.spaces,
      servers: [server()],
      connect: async () => failing,
    });
    expect(run.failed).toHaveLength(1);
    expect(run.failed[0]!.message).toBe('server said no');
    expect(world.patched).toEqual([]);
  });

  it('one unreachable server never blocks the other', async () => {
    const world = fakeSpaces([{ id: 'i-1', title: 'A', kind: 'doc', content: 'x' }]);
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const run = await ingestSpace('sp-1', {
      spaces: world.spaces,
      servers: [server({ id: 'down', name: 'Down' }), server({ id: 'up', name: 'Up' })],
      connect: async (s) => {
        if (s.id === 'down') throw new Error('ECONNREFUSED');
        return fakeSession(calls);
      },
    });
    expect(run.perServer['down']!.failed).toBe(1);
    expect(run.perServer['up']!.sent).toBe(1);
    const flag = JSON.parse(world.items.get('i-1')!.metadata![INGEST_FLAG_KEY] as string);
    expect(Object.keys(flag)).toEqual(['up']);
  });

  it('a fully up-to-date run never opens a connection', async () => {
    const world = fakeSpaces([{ id: 'i-1', title: 'A', kind: 'doc', content: 'x' }]);
    const connectSpy = vi.fn(async () => fakeSession([]));
    await ingestSpace('sp-1', { spaces: world.spaces, servers: [server()], connect: connectSpy });
    expect(connectSpy).toHaveBeenCalledTimes(1);
    connectSpy.mockClear();
    const run = await ingestSpace('sp-1', { spaces: world.spaces, servers: [server()], connect: connectSpy });
    expect(run.skipped).toBe(1);
    expect(connectSpy).not.toHaveBeenCalled();
  });

  it('progress beats narrate every (item, server) pair', async () => {
    const world = fakeSpaces([{ id: 'i-1', title: 'A', kind: 'doc', content: 'x' }]);
    const beats: string[] = [];
    await ingestSpace('sp-1', {
      spaces: world.spaces,
      servers: [server()],
      connect: async () => fakeSession([]),
      onProgress: (b) => beats.push(`${b.itemTitle}/${b.serverName}:${b.outcome}`),
    });
    expect(beats).toEqual(['A/Team memory:sent']);
  });
});
