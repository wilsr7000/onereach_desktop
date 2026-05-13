/**
 * lib/mcp-client -- HTTP/JSON-RPC MCP client
 *
 * Exercises tools/list, tools/call, error paths, and the 1-hour cache
 * against a real in-process HTTP fixture (node http module). No external
 * deps. The fixture lets us assert request shape (JSON-RPC envelope,
 * headers) AND response handling without mocking fetch.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
const http = require('http');

vi.mock('../../lib/log-event-queue', () => ({
  getLogQueue: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
}));

const { createClient, PROTOCOL_VERSION } = require('../../lib/mcp-client');

// --------------------------------------------------------------------------
// HTTP fixture: a tiny MCP server that responds to JSON-RPC requests.
// Behavior is per-test-configurable via the `handler` ref so we can simulate
// success, errors, timeouts, and changing tool lists.
// --------------------------------------------------------------------------

let server;
let port;
let handler = (req, body) => null;
const seenRequests = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      seenRequests.push({
        method: body.method,
        params: body.params,
        headers: req.headers,
      });
      const result = handler(req, body);
      if (result === null) {
        res.statusCode = 500;
        res.end('handler not set');
        return;
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, ...result }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

afterAll(() => {
  if (server) server.close();
});

beforeEach(() => {
  seenRequests.length = 0;
  handler = (req, body) => null;
});

function url() {
  return `http://127.0.0.1:${port}/mcp`;
}

// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------

describe('McpClient -- construction', () => {
  it('requires a url', () => {
    expect(() => createClient({})).toThrow(/url/);
    expect(() => createClient({ url: '' })).toThrow(/url/);
  });

  it('falls back to url as label when label is omitted', () => {
    const c = createClient({ url: 'http://example.com' });
    expect(c.label).toBe('http://example.com');
  });
});

describe('McpClient -- initialize handshake', () => {
  it('sends initialize with the protocol version and clientInfo', async () => {
    handler = () => ({ result: { protocolVersion: PROTOCOL_VERSION, capabilities: {} } });
    const c = createClient({ url: url(), label: 'fixture' });
    await c.initialize();
    expect(seenRequests).toHaveLength(1);
    expect(seenRequests[0].method).toBe('initialize');
    expect(seenRequests[0].params.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(seenRequests[0].params.clientInfo.name).toBe('onereach-mcp-bridge');
  });

  it('is idempotent (second call is a no-op)', async () => {
    handler = () => ({ result: {} });
    const c = createClient({ url: url() });
    await c.initialize();
    await c.initialize();
    expect(seenRequests).toHaveLength(1);
  });

  it('continues silently when the server rejects initialize', async () => {
    handler = () => ({ error: { code: -32601, message: 'Method not found' } });
    const c = createClient({ url: url() });
    // Should not throw.
    await c.initialize();
    expect(c._initialized).toBe(true);
  });
});

describe('McpClient -- listTools', () => {
  it('returns the tool list and caches it for subsequent calls', async () => {
    handler = (req, body) => {
      if (body.method === 'initialize') return { result: {} };
      if (body.method === 'tools/list') {
        return {
          result: {
            tools: [
              { name: 'echo', description: 'Echo back input' },
              { name: 'time', description: 'Get current time', inputSchema: { type: 'object' } },
            ],
          },
        };
      }
      return { error: { code: -32601, message: 'Method not found' } };
    };
    const c = createClient({ url: url() });
    const tools = await c.listTools();
    expect(tools).toHaveLength(2);
    expect(tools[0].name).toBe('echo');
    expect(tools[1].inputSchema).toEqual({ type: 'object' });

    // Second call should hit the cache, not the server.
    const beforeCount = seenRequests.filter((r) => r.method === 'tools/list').length;
    await c.listTools();
    const afterCount = seenRequests.filter((r) => r.method === 'tools/list').length;
    expect(afterCount).toBe(beforeCount);
  });

  it('refreshes the cache on { refresh: true }', async () => {
    handler = (req, body) => {
      if (body.method === 'initialize') return { result: {} };
      return { result: { tools: [{ name: 't1', description: '' }] } };
    };
    const c = createClient({ url: url() });
    await c.listTools();
    await c.listTools({ refresh: true });
    expect(seenRequests.filter((r) => r.method === 'tools/list')).toHaveLength(2);
  });

  it('returns [] when the server reports no tools field', async () => {
    handler = (req, body) => {
      if (body.method === 'initialize') return { result: {} };
      return { result: {} };
    };
    const c = createClient({ url: url() });
    const tools = await c.listTools();
    expect(tools).toEqual([]);
  });

  it('surfaces server-side errors', async () => {
    handler = (req, body) => {
      if (body.method === 'initialize') return { result: {} };
      return { error: { code: -32603, message: 'Internal error' } };
    };
    const c = createClient({ url: url() });
    await expect(c.listTools()).rejects.toThrow(/Internal error/);
  });
});

describe('McpClient -- callTool', () => {
  it('extracts text content from MCP-shaped responses', async () => {
    handler = (req, body) => {
      if (body.method === 'initialize') return { result: {} };
      if (body.method === 'tools/call') {
        expect(body.params.name).toBe('echo');
        expect(body.params.arguments).toEqual({ text: 'hi' });
        return {
          result: {
            content: [
              { type: 'text', text: 'You said hi' },
            ],
          },
        };
      }
      return { error: { code: -32601, message: 'unknown' } };
    };
    const c = createClient({ url: url() });
    const out = await c.callTool('echo', { text: 'hi' });
    expect(out).toBe('You said hi');
  });

  it('joins multiple text blocks with newlines', async () => {
    handler = (req, body) => {
      if (body.method === 'initialize') return { result: {} };
      return {
        result: {
          content: [
            { type: 'text', text: 'line one' },
            { type: 'image', data: 'ignored' },
            { type: 'text', text: 'line two' },
          ],
        },
      };
    };
    const c = createClient({ url: url() });
    const out = await c.callTool('multi', {});
    expect(out).toBe('line one\nline two');
  });

  it('stringifies non-content results as JSON', async () => {
    handler = (req, body) => {
      if (body.method === 'initialize') return { result: {} };
      return { result: { value: 42 } };
    };
    const c = createClient({ url: url() });
    const out = await c.callTool('numeric', {});
    expect(out).toBe(JSON.stringify({ value: 42 }));
  });

  it('throws on tool errors', async () => {
    handler = (req, body) => {
      if (body.method === 'initialize') return { result: {} };
      return { error: { code: -32000, message: 'Tool refused' } };
    };
    const c = createClient({ url: url() });
    await expect(c.callTool('refused', {})).rejects.toThrow(/Tool refused/);
  });

  it('rejects an empty tool name', async () => {
    const c = createClient({ url: url() });
    await expect(c.callTool('', {})).rejects.toThrow(/tool name/);
  });
});

describe('McpClient -- headers + auth', () => {
  it('forwards custom headers on every request', async () => {
    handler = (req, body) => {
      if (body.method === 'initialize') return { result: {} };
      return { result: { tools: [] } };
    };
    const c = createClient({
      url: url(),
      headers: { 'X-Test-Auth': 'secret' },
    });
    await c.listTools();
    expect(seenRequests[0].headers['x-test-auth']).toBe('secret');
    expect(seenRequests[0].headers['content-type']).toBe('application/json');
    expect(seenRequests[0].headers['accept']).toContain('application/json');
    expect(seenRequests[0].headers['accept']).toContain('text/event-stream');
  });
});

describe('McpClient -- health probe', () => {
  it('returns ok: true with latency when listTools succeeds', async () => {
    handler = (req, body) => {
      if (body.method === 'initialize') return { result: {} };
      return { result: { tools: [{ name: 't', description: 'd' }] } };
    };
    const c = createClient({ url: url() });
    const h = await c.health();
    expect(h.ok).toBe(true);
    expect(typeof h.latencyMs).toBe('number');
  });

  it('returns ok: false with the error when the server is down', async () => {
    handler = () => null; // 500
    const c = createClient({ url: url() });
    const h = await c.health();
    expect(h.ok).toBe(false);
    expect(h.error).toBeDefined();
  });
});

describe('McpClient -- invalidateToolsCache', () => {
  it('forces the next listTools to hit the server', async () => {
    handler = (req, body) => {
      if (body.method === 'initialize') return { result: {} };
      return { result: { tools: [{ name: 't', description: 'd' }] } };
    };
    const c = createClient({ url: url() });
    await c.listTools();
    c.invalidateToolsCache();
    await c.listTools();
    expect(seenRequests.filter((r) => r.method === 'tools/list')).toHaveLength(2);
  });
});
