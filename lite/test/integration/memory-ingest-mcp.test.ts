/**
 * Memory-ingest ↔ real MCP server round trip (ADR-079).
 *
 * The unit tier fakes the MCP session; this test proves the production
 * `connectMemoryServer` path against an actual @modelcontextprotocol/sdk
 * server over streamable HTTP on loopback: transport negotiation, the
 * bearer credential reaching the wire, schema-driven argument mapping,
 * in-band tool errors surfacing as failures (no flag written), and the
 * hash-keyed skip working across two real runs.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { connectMemoryServer } from '../../memory-ingest/client.js';
import { ingestSpace, type EngineItem, type EngineSpacesApi } from '../../memory-ingest/engine.js';
import { INGEST_FLAG_KEY, type MemoryServerConfig } from '../../memory-ingest/types.js';

interface ReceivedCall {
  args: Record<string, unknown>;
  authorization: string | undefined;
}

let http: Server;
let baseUrl: string;
const received: ReceivedCall[] = [];
let failNextCall = false;

beforeAll(async () => {
  // A fresh MCP server + transport per request (stateless mode) keeps
  // the harness free of session bookkeeping.
  http = createServer((req, res) => {
    void (async () => {
      const mcp = new McpServer({ name: 'test-memory', version: '1.0.0' });
      mcp.tool(
        'ingest_memory',
        'Store a document in the test memory',
        {
          information: z.string(),
          title: z.string().optional(),
          metadata: z.record(z.unknown()).optional(),
        },
        async (args) => {
          if (failNextCall) {
            failNextCall = false;
            return {
              isError: true,
              content: [{ type: 'text', text: 'memory quota exceeded' }],
            };
          }
          received.push({
            args: args as Record<string, unknown>,
            authorization: req.headers.authorization,
          });
          return { content: [{ type: 'text', text: 'stored' }] };
        }
      );
      // exactOptionalPropertyTypes friction with the SDK's option and
      // Transport types (same as the client side). Runtime-compatible.
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      } as unknown as ConstructorParameters<typeof StreamableHTTPServerTransport>[0]);
      res.on('close', () => {
        void transport.close();
        void mcp.close();
      });
      await mcp.connect(transport as unknown as Parameters<typeof mcp.connect>[0]);
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString()));
      await new Promise<void>((resolve) => req.on('end', () => resolve()));
      await transport.handleRequest(req, res, body.length > 0 ? JSON.parse(body) : undefined);
    })().catch(() => {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end();
      }
    });
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => http.close(() => resolve()));
});

function serverConfig(): MemoryServerConfig {
  return {
    id: 'live-1',
    name: 'Loopback memory',
    url: baseUrl,
    apiKey: 'test-key-123',
    createdAt: '2026-08-28T00:00:00.000Z',
  };
}

function world(items: EngineItem[]): {
  items: Map<string, EngineItem>;
  spaces: EngineSpacesApi;
} {
  const map = new Map(items.map((i) => [i.id, i]));
  return {
    items: map,
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
        const item = map.get(id);
        if (item !== undefined) {
          item.metadata = { ...(item.metadata ?? {}), ...patch };
        }
      },
      async getSpaceName() {
        return 'Live Space';
      },
    },
  };
}

describe('real MCP round trip', () => {
  it('ingests over the wire with bearer auth and schema-mapped args, then skips on re-run', async () => {
    received.length = 0;
    const w = world([
      { id: 'i-1', title: 'Quarterly plan', kind: 'doc', content: 'ship ADR-079' },
    ]);
    const deps = { spaces: w.spaces, servers: [serverConfig()], connect: connectMemoryServer };

    const first = await ingestSpace('sp-live', deps);
    expect(first.failed).toEqual([]);
    expect(first.sent).toBe(1);
    expect(received).toHaveLength(1);
    // The credential reached the wire as a bearer header.
    expect(received[0]!.authorization).toBe('Bearer test-key-123');
    // The composed document landed in the schema's body property, and
    // the declared metadata property was filled opportunistically.
    expect(received[0]!.args.information).toContain('# Quarterly plan');
    expect(received[0]!.args.information).toContain('ship ADR-079');
    expect(received[0]!.args.metadata).toMatchObject({ spaceId: 'sp-live' });
    // Flag written on the item.
    const flag = w.items.get('i-1')!.metadata?.[INGEST_FLAG_KEY];
    expect(typeof flag).toBe('string');

    const second = await ingestSpace('sp-live', deps);
    expect(second.sent).toBe(0);
    expect(second.skipped).toBe(1);
    expect(received).toHaveLength(1);
  });

  it('an in-band tool error surfaces as a failure and leaves no flag', async () => {
    received.length = 0;
    failNextCall = true;
    const w = world([{ id: 'i-2', title: 'Doomed', kind: 'doc', content: 'x' }]);
    const run = await ingestSpace('sp-live', {
      spaces: w.spaces,
      servers: [serverConfig()],
      connect: connectMemoryServer,
    });
    expect(run.sent).toBe(0);
    expect(run.failed).toHaveLength(1);
    expect(run.failed[0]!.message).toContain('memory quota exceeded');
    expect(w.items.get('i-2')!.metadata?.[INGEST_FLAG_KEY]).toBeUndefined();
  });
});
