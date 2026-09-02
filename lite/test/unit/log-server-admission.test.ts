/**
 * The log server admits loopback callers only (2026-09-02 security review).
 *
 * lib/log-server.js listens on 127.0.0.1, which never stopped a web
 * page: with `Access-Control-Allow-Origin: *` any page in any browser
 * tab could read every log line cross-origin (URLs with OAuth query
 * strings included), a no-cors POST could hit /app/restart, and DNS
 * rebinding sidestepped the bind address. The shared lib is loaded from
 * disk by the packaged app, so these pins read the source the app runs.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';

const root = resolve(__dirname, '../../..');
const source = readFileSync(resolve(root, 'lib/log-server.js'), 'utf-8');
const require = createRequire(import.meta.url);

function fakeReq(headers: Record<string, string | undefined>, method = 'GET', url = '/health'): unknown {
  const h: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) if (v !== undefined) h[k] = v;
  return { method, url, headers: h, on: () => undefined };
}

function fakeRes(): { status: number; headers: Record<string, string>; ended: boolean; setHeader: (k: string, v: string) => void; writeHead: (s: number, h?: Record<string, string>) => void; end: (b?: string) => void } {
  const res = {
    status: 0,
    headers: {} as Record<string, string>,
    ended: false,
    setHeader(k: string, v: string) {
      res.headers[k] = v;
    },
    writeHead(s: number, h?: Record<string, string>) {
      res.status = s;
      if (h) Object.assign(res.headers, h);
    },
    end() {
      res.ended = true;
    },
  };
  return res;
}

describe('log server — loopback admission', () => {
  it('never answers with a wildcard CORS origin any more', () => {
    expect(source).not.toContain("'Access-Control-Allow-Origin', '*'");
    expect(source).toContain('if (!isAdmitted(req)) {');
    expect(source).toContain("if (!key || !isAdmitted(req)) {"); // the WebSocket upgrade too
  });

  it('refuses a rebound Host and a foreign browser Origin; admits loopback and origin-less callers', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { LogServer } = require(resolve(root, 'lib/log-server.js')) as {
      LogServer: new (queue: unknown) => { _handleHTTP: (req: unknown, res: unknown) => void };
    };
    const queue = { subscribe: () => () => undefined, debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined, getStats: () => ({}), query: () => [] };
    const server = new LogServer(queue);

    const cases: Array<{ host?: string; origin?: string; admitted: boolean; why: string }> = [
      { host: '127.0.0.1:47392', admitted: true, why: 'curl / Node tools' },
      { host: 'localhost:47392', origin: 'http://localhost:5173', admitted: true, why: 'a loopback dev page' },
      { host: 'rebind.attacker.example:47392', admitted: false, why: 'DNS rebinding' },
      { host: '127.0.0.1:47392', origin: 'https://evil.example', admitted: false, why: 'cross-origin page' },
      { host: '127.0.0.1:47392', origin: 'null', admitted: false, why: 'sandboxed frame' },
      { admitted: false, why: 'no Host at all' },
    ];
    for (const c of cases) {
      const res = fakeRes();
      const headers: Record<string, string | undefined> = { host: c.host, origin: c.origin };
      server._handleHTTP(fakeReq(headers, 'OPTIONS'), res);
      if (c.admitted) {
        expect(res.status, c.why).toBe(204);
        if (c.origin !== undefined) expect(res.headers['Access-Control-Allow-Origin']).toBe(c.origin);
      } else {
        expect(res.status, c.why).toBe(403);
        expect(res.headers['Access-Control-Allow-Origin'], c.why).toBeUndefined();
      }
    }
  });
});
