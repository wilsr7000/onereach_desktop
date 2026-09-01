/**
 * NEON bridge (ADR-081: "make sure any web app can access it from the
 * APIs or MCP" — read-only, viewer-scoped, allowlisted). Pins the two
 * load-bearing guarantees: the origin fence (only the app's own web apps
 * + localhost; everything else 403) and read-only-by-construction (only
 * GET routes; anything else 405), plus that every route forwards to the
 * gated reads.
 */
import { describe, it, expect, vi } from 'vitest';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { isAllowedOrigin, DEFAULT_ALLOWED_ORIGINS } from '../../neon-bridge/origin.js';
import { makeNeonBridgeHandler, type NeonReads } from '../../neon-bridge/server.js';

// ─── origin policy ───────────────────────────────────────────────────────────

describe('isAllowedOrigin', () => {
  it('allows the app’s own hosted origins', () => {
    for (const o of DEFAULT_ALLOWED_ORIGINS) {
      expect(isAllowedOrigin(o)).toBe(true);
    }
    expect(isAllowedOrigin('https://files.edison.api.onereach.ai/journey-map-builder/')).toBe(true);
  });

  it('allows localhost/127.0.0.1 on any port (dev servers)', () => {
    expect(isAllowedOrigin('http://localhost:5173')).toBe(true);
    expect(isAllowedOrigin('http://127.0.0.1:3000')).toBe(true);
  });

  it('allows a non-browser caller (no Origin) — loopback-only bind', () => {
    expect(isAllowedOrigin(undefined)).toBe(true);
    expect(isAllowedOrigin(null)).toBe(true);
    expect(isAllowedOrigin('')).toBe(true);
  });

  it('refuses every other website', () => {
    expect(isAllowedOrigin('https://evil.example.com')).toBe(false);
    expect(isAllowedOrigin('https://onereach.ai.evil.com')).toBe(false);
    expect(isAllowedOrigin('http://files.edison.api.onereach.ai')).toBe(false); // wrong scheme
    expect(isAllowedOrigin('not a url')).toBe(false);
  });
});

// ─── handler behavior ────────────────────────────────────────────────────────

function fakeReads(over: Partial<NeonReads> = {}): NeonReads {
  return {
    listSpaces: vi.fn(async () => [{ id: 'sp-1', name: 'Data Bricks' }]),
    listItems: vi.fn(async (spaceId: string) => [{ id: 'i-1', spaceId }]),
    getItem: vi.fn(async (id: string) => (id === 'missing' ? null : { id, title: 'Item' })),
    search: vi.fn(async (query: string) => [{ id: 'i-1', title: query }]),
    ...over,
  };
}

interface Captured {
  status: number;
  headers: Record<string, string | number | string[]>;
  body: unknown;
}

function call(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  method: string,
  url: string,
  origin?: string
): Promise<Captured> {
  const req = new IncomingMessage(new Socket());
  req.method = method;
  req.url = url;
  if (origin !== undefined) req.headers.origin = origin;
  const res = new ServerResponse(req);
  const cap: Captured = { status: 0, headers: {}, body: undefined };
  let chunk = '';
  const origWriteHead = res.writeHead.bind(res);
  res.writeHead = ((status: number, headers?: Record<string, string>) => {
    cap.status = status;
    if (headers) Object.assign(cap.headers, headers);
    return origWriteHead(status, headers as never);
  }) as typeof res.writeHead;
  return new Promise((resolve) => {
    res.end = ((data?: string) => {
      if (typeof data === 'string') chunk += data;
      try {
        cap.body = chunk.length > 0 ? JSON.parse(chunk) : undefined;
      } catch {
        cap.body = chunk;
      }
      resolve(cap);
      return res;
    }) as typeof res.end;
    handler(req, res);
  });
}

describe('read-only surface', () => {
  it('serves GET routes and forwards to the gated reads', async () => {
    const reads = fakeReads();
    const h = makeNeonBridgeHandler({ reads });

    const spaces = await call(h, 'GET', '/neon/spaces');
    expect(spaces.status).toBe(200);
    expect(spaces.body).toEqual({ spaces: [{ id: 'sp-1', name: 'Data Bricks' }] });

    const items = await call(h, 'GET', '/neon/spaces/sp%201/items');
    expect(items.status).toBe(200);
    expect(reads.listItems).toHaveBeenCalledWith('sp 1');

    const item = await call(h, 'GET', '/neon/items/abc');
    expect(item.status).toBe(200);
    expect(item.body).toEqual({ item: { id: 'abc', title: 'Item' } });

    const missing = await call(h, 'GET', '/neon/items/missing');
    expect(missing.status).toBe(404);

    const search = await call(h, 'GET', '/neon/search?q=gartner');
    expect(search.status).toBe(200);
    expect(reads.search).toHaveBeenCalledWith('gartner', undefined);

    const health = await call(h, 'GET', '/neon/health');
    expect(health.body).toMatchObject({ ok: true, readOnly: true });
  });

  it('requires q for search', async () => {
    const res = await call(makeNeonBridgeHandler({ reads: fakeReads() }), 'GET', '/neon/search');
    expect(res.status).toBe(400);
  });

  it('refuses every non-GET method (read-only by construction)', async () => {
    const reads = fakeReads();
    const h = makeNeonBridgeHandler({ reads });
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const res = await call(h, method, '/neon/spaces');
      expect(res.status, `${method} must be 405`).toBe(405);
    }
    // No read was invoked by any mutation attempt.
    expect(reads.listSpaces).not.toHaveBeenCalled();
  });
});

describe('origin fence at the handler', () => {
  it('403s a disallowed browser origin and never touches the reads', async () => {
    const reads = fakeReads();
    const h = makeNeonBridgeHandler({ reads });
    const res = await call(h, 'GET', '/neon/spaces', 'https://evil.example.com');
    expect(res.status).toBe(403);
    expect(res.headers['Access-Control-Allow-Origin']).toBeUndefined();
    expect(reads.listSpaces).not.toHaveBeenCalled();
  });

  it('echoes the Origin for an allowed web app', async () => {
    const h = makeNeonBridgeHandler({ reads: fakeReads() });
    const res = await call(h, 'GET', '/neon/spaces', 'https://files.edison.api.onereach.ai');
    expect(res.status).toBe(200);
    expect(res.headers['Access-Control-Allow-Origin']).toBe('https://files.edison.api.onereach.ai');
    expect(res.headers['Vary']).toBe('Origin');
  });

  it('answers OPTIONS preflight for an allowed origin', async () => {
    const h = makeNeonBridgeHandler({ reads: fakeReads() });
    const res = await call(h, 'OPTIONS', '/neon/spaces', 'http://localhost:5173');
    expect(res.status).toBe(204);
    expect(res.headers['Access-Control-Allow-Methods']).toContain('GET');
  });
});
