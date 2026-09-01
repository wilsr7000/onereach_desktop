/**
 * Local-API MCP aggregator — real stdio round trip (2026-08-31).
 *
 * The unit tier proves catalog + request building in isolation; this
 * proves the built server end to end: a real MCP client spawns
 * dist-lite/build/local-api-mcp.js over stdio, discovers the tool
 * catalog (list_local_apis + the callable ops), and calls one tool that
 * forwards to a fake local HTTP API on a real loopback port — with the
 * excluded control mutations proven absent from tools/list.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as path from 'node:path';
import { existsSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const BUILT = path.resolve(__dirname, '..', '..', '..', 'dist-lite', 'build', 'local-api-mcp.js');

let http: Server;
let spacesPort: number;
const received: Array<{ method: string; url: string }> = [];

beforeAll(async () => {
  http = createServer((req, res) => {
    received.push({ method: req.method ?? '', url: req.url ?? '' });
    res.setHeader('Content-Type', 'application/json');
    if ((req.url ?? '').startsWith('/api/spaces')) {
      res.end(JSON.stringify({ spaces: [{ id: 'sp-1', name: 'Data Bricks' }] }));
      return;
    }
    res.end(JSON.stringify({ ok: true, url: req.url }));
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  spacesPort = (http.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => http.close(() => resolve()));
});

describe('built local-api-mcp over stdio', () => {
  it('discovers the catalog, excludes control mutations, and calls a forwarded tool', async () => {
    // Guard: the server bundle must be built (npm run lite:build).
    expect(existsSync(BUILT), `built server missing at ${BUILT} — run lite:build`).toBe(true);

    const transport = new StdioClientTransport({
      command: 'node',
      args: [BUILT],
      env: {
        ...process.env,
        LOCAL_API_SPACES_PORT: String(spacesPort),
        LOCAL_API_VIEWER_ID: 'robb@onereach.com',
      },
    });
    const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      const names = new Set(tools.map((t) => t.name));

      // Discovery meta-tools + a representative callable op are present.
      expect(names.has('list_local_apis')).toBe(true);
      expect(names.has('describe_api')).toBe(true);
      expect(names.has('spaces_list')).toBe(true);
      expect(names.has('gateway_submit_task')).toBe(true);

      // The chosen scope holds even at the wire: no mutation tools, and
      // the SSE stream isn't registered.
      expect(names.has('app_restart')).toBe(false);
      expect([...names].some((n) => /restart|pause|resume/i.test(n))).toBe(false);
      expect(names.has('gateway_task_events')).toBe(false);

      // list_local_apis returns the full catalog.
      const disco = await client.callTool({ name: 'list_local_apis', arguments: {} });
      const discoText = (disco.content as Array<{ text?: string }>)[0]?.text ?? '';
      expect(discoText).toContain('"id": "spaces"');
      expect(discoText).toContain('"id": "gateway"');
      expect(discoText).toMatch(/restart/i); // the "not exposed" note

      // A real tool call forwards to the fake HTTP API.
      const res = await client.callTool({ name: 'spaces_list', arguments: {} });
      const resText = (res.content as Array<{ text?: string }>)[0]?.text ?? '';
      expect(resText).toContain('Data Bricks');
      expect(received.some((r) => r.method === 'GET' && r.url === '/api/spaces')).toBe(true);
    } finally {
      await client.close();
    }
  }, 30000);
});
