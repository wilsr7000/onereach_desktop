/**
 * In-memory log server -- boots a real `lib/log-server.js` instance
 * backed by a fresh `lib/log-event-queue.js` queue, listening on a
 * random localhost port.
 *
 * Used by integration tests that want to drive `LiteLogServerClient`
 * (or any HTTP consumer of the log queue) end-to-end without depending
 * on a running lite app.
 *
 * Mirrors the shape of `startInMemoryKVServer()` in `./in-memory-kv-server.ts`.
 */

import * as path from 'node:path';

interface LogQueue {
  debug(category: string, message: string, data?: unknown): unknown;
  info(category: string, message: string, data?: unknown): unknown;
  warn(category: string, message: string, data?: unknown): unknown;
  error(category: string, message: string, data?: unknown): unknown;
  enqueue?(event: { level: string; category: string; message: string; data?: unknown }): unknown;
  /**
   * Internal hook on the lib `LogEventQueue`. Used by `reset()` to
   * clear the buffer between tests when available.
   */
  _ringBuffer?: unknown[];
  _stats?: { total?: number; byLevel?: Record<string, number>; byCategory?: Record<string, number> };
}

interface LogServer {
  start(): Promise<void>;
  stop?(): void;
  /**
   * The lib `LogServer` keeps the originally-requested port in
   * `this.port`. With `port: 0`, that value stays 0 -- the actually-bound
   * port has to be read from `this.server.address()`.
   */
  port?: number;
  /** The HTTP server -- exposed so we can close it. */
  server?: {
    close(cb?: (err?: Error) => void): void;
    address(): { port: number } | string | null;
  };
}

export interface InMemoryLogServer {
  /** Full URL the server is listening on. */
  readonly url: string;
  /** The bound port. */
  readonly port: number;
  /** The underlying lib queue -- inspect for unit-style assertions. */
  readonly queue: LogQueue;
  /** Stop and free the port. */
  stop(): Promise<void>;
  /** Clear the queue's ring buffer + stats (best-effort, lib-internal). */
  reset(): void;
}

/**
 * Start an in-memory log server on `port` (default 0 -> OS picks).
 * Returns a handle with the bound URL/port + the queue + stop/reset.
 *
 * @example
 * ```typescript
 * const server = await startInMemoryLogServer();
 * const client = new LiteLogServerClient(server.url);
 * await client.pushEvent('test.preflight');
 * const events = await client.getEvents({ pattern: 'test.*' });
 * await server.stop();
 * ```
 */
export async function startInMemoryLogServer(port = 0): Promise<InMemoryLogServer> {
  // Resolve lib/ from the lite folder. Same path the rest of lite uses.
  const libDir = path.resolve(__dirname, '..', '..', '..', '..', 'lib');
  // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
  const { getLogQueue } = require(path.join(libDir, 'log-event-queue')) as {
    getLogQueue: () => LogQueue;
  };
  // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
  const { LogServer: LogServerCtor } = require(path.join(libDir, 'log-server')) as {
    LogServer: new (queue: LogQueue, options?: { port?: number }) => LogServer;
  };

  const queue = getLogQueue();

  // The lib queue is a process-wide singleton. Different tests calling
  // startInMemoryLogServer() get the SAME queue with whatever state
  // accumulated previously. Reset before booting so each call starts
  // fresh -- callers expect "boot a new server" to mean "blank slate."
  if (Array.isArray(queue._ringBuffer)) queue._ringBuffer.length = 0;
  if (queue._stats !== undefined) {
    queue._stats.total = 0;
    queue._stats.byLevel = { debug: 0, info: 0, warn: 0, error: 0 };
    queue._stats.byCategory = {};
  }

  const server = new LogServerCtor(queue, { port });
  await server.start();

  // The lib server logs "Log server started" on boot via queue.info('app', ...);
  // tests that snapshot stats immediately may see this entry. Document by example
  // rather than scrubbing -- keeps the harness honest about what's there.

  // Read the actually-bound port from the HTTP server's address(). Lib
  // LogServer keeps `this.port` set to whatever the caller passed
  // (which is 0 when we ask for OS-assigned), so we can't trust
  // `server.port` until the lib starts setting it post-listen.
  let boundPort = port;
  const addr = server.server?.address?.();
  if (typeof addr === 'object' && addr !== null && typeof addr.port === 'number') {
    boundPort = addr.port;
  } else if (typeof server.port === 'number' && server.port > 0) {
    boundPort = server.port;
  }
  const url = `http://127.0.0.1:${boundPort}`;

  return {
    url,
    port: boundPort,
    queue,
    async stop(): Promise<void> {
      const inner = server.server;
      if (inner === undefined) return;
      await new Promise<void>((resolve, reject) => {
        inner.close((err) => (err ? reject(err) : resolve()));
      });
    },
    reset(): void {
      // Best-effort: clear the lib queue's internal ring buffer and
      // stats so tests don't leak state. The fields are private but
      // documented in lib/log-event-queue.js.
      if (Array.isArray(queue._ringBuffer)) queue._ringBuffer.length = 0;
      if (queue._stats !== undefined) {
        queue._stats.total = 0;
        queue._stats.byLevel = { debug: 0, info: 0, warn: 0, error: 0 };
        queue._stats.byCategory = {};
      }
    },
  };
}
