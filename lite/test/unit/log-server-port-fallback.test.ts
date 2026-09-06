/**
 * The log server's port fallback is bounded and never re-enters itself
 * (2026-09-05).
 *
 * Before: on EADDRINUSE the 'error' handler called listen() on
 * `this.port + 1` — and stayed attached. With the preferred port AND
 * the fallback both taken (the installed app on 47392, a dev instance
 * on 47393), the fallback's own EADDRINUSE re-fired the same handler,
 * which listened on the same port again, forever: one more 'listening'
 * listener per attempt, 100% CPU, and V8 out of heap after ~6 minutes.
 * Every third Lite instance died that way.
 *
 * These tests occupy real loopback ports and drive the real class.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:net';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';

const root = resolve(__dirname, '../../..');
const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { LogServer } = require(resolve(root, 'lib/log-server.js')) as {
  LogServer: new (queue: unknown, options?: { port?: number }) => {
    port: number;
    server: { listenerCount: (e: string) => number } | null;
    start: () => Promise<void>;
    stop: () => void;
  };
};

const queue = {
  subscribe: () => () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  getStats: () => ({}),
  query: () => [],
};

/** Hold a loopback port open, the way another app instance would. */
function occupy(port: number): Promise<Server> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once('error', rej);
    s.listen(port, '127.0.0.1', () => res(s));
  });
}

/** A base port nobody else on this machine is likely to hold right now. */
async function freeBase(): Promise<number> {
  for (let tries = 0; tries < 20; tries += 1) {
    const base = 48000 + Math.floor(Math.random() * 10000);
    try {
      const held: Server[] = [];
      for (let p = base; p <= base + 12; p += 1) held.push(await occupy(p));
      for (const s of held) s.close();
      await new Promise((r) => setTimeout(r, 20));
      return base;
    } catch {
      /* one of the ports is busy — pick another base */
    }
  }
  throw new Error('no free port range found');
}

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

describe('log server — port fallback', () => {
  it('walks up past taken ports and reports the port it actually got', async () => {
    const base = await freeBase();
    const a = await occupy(base);
    const b = await occupy(base + 1);
    cleanup.push(() => a.close(), () => b.close());

    const server = new LogServer(queue, { port: base });
    cleanup.push(() => server.stop());
    await server.start();
    expect(server.port).toBe(base + 2);
    // One listener each, however many attempts it took.
    expect(server.server?.listenerCount('listening')).toBeLessThanOrEqual(1);
    expect(server.server?.listenerCount('error')).toBe(1);
  });

  it('gives up with EADDRINUSE after the bounded scan instead of spinning', async () => {
    const base = await freeBase();
    const held: Server[] = [];
    for (let p = base; p <= base + 10; p += 1) held.push(await occupy(p));
    cleanup.push(() => held.forEach((s) => s.close()));

    const server = new LogServer(queue, { port: base });
    cleanup.push(() => server.stop());
    const started = Date.now();
    await expect(server.start()).rejects.toMatchObject({ code: 'EADDRINUSE' });
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('the source keeps the scan bounded and the handlers registered once', () => {
    const source = readFileSync(resolve(root, 'lib/log-server.js'), 'utf-8');
    expect(source).toContain('const MAX_PORT_FALLBACKS = 10;');
    expect(source).toContain("this.server.once('listening'");
    expect(source).not.toContain('already in use, retrying...');
  });
});
