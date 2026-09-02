/**
 * NEON bridge — real loopback round trip (ADR-081).
 *
 * The unit tier drives the handler with fake req/res; this binds a real
 * socket and proves the wire behavior a web app sees: an allowed origin
 * gets data + the echoed CORS header, a disallowed origin gets 403 with
 * NO Access-Control-Allow-Origin (so the browser blocks it), and a
 * write method is refused.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startNeonBridge, type NeonBridgeServer, type NeonReads } from '../../neon-bridge/server.js';

let server: NeonBridgeServer;
let base: string;

const reads: NeonReads = {
  listSpaces: async () => [{ id: 'sp-1', name: 'Data Bricks' }],
  listItems: async (spaceId) => [{ id: 'i-1', spaceId }],
  getItem: async (id) => ({ id, title: 'Item' }),
  search: async (query) => [{ id: 'i-1', title: query }],
};

beforeAll(async () => {
  server = await startNeonBridge({ reads }, { port: 47600 });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server.close();
});

describe('real loopback bridge', () => {
  it('serves an allowed web-app origin with the echoed CORS header', async () => {
    const res = await fetch(`${base}/neon/spaces`, {
      headers: { Origin: 'https://files.edison.api.onereach.ai' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe(
      'https://files.edison.api.onereach.ai'
    );
    const body = (await res.json()) as { spaces: Array<{ name: string }> };
    expect(body.spaces[0]?.name).toBe('Data Bricks');
  });

  it('refuses a disallowed origin with 403 and no CORS header', async () => {
    const res = await fetch(`${base}/neon/spaces`, {
      headers: { Origin: 'https://evil.example.com' },
    });
    expect(res.status).toBe(403);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('is read-only over the wire — a POST is 405', async () => {
    const res = await fetch(`${base}/neon/spaces`, {
      method: 'POST',
      headers: { Origin: 'https://files.edison.api.onereach.ai' },
    });
    expect(res.status).toBe(405);
  });

  it('serves a non-browser caller (no Origin)', async () => {
    const res = await fetch(`${base}/neon/health`);
    expect(res.status).toBe(200);
    expect((await res.json()) as { ok: boolean }).toMatchObject({ ok: true });
  });
});

describe('malformed URL encoding over the wire', () => {
  it('answers 400 for a bad percent-sequence instead of 500', async () => {
    const res = await fetch(`${base}/neon/items/%E0%A4%A`);
    expect(res.status).toBe(400);
  });
});
