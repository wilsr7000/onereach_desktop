/**
 * NEON bridge — read-only, viewer-scoped HTTP surface. Per ADR-081.
 *
 * Lets the app's own web apps read the org Digital Twin (NEON) over
 * loopback instead of embedding the cloud endpoint. Every read forwards
 * to the SAME gated SpacesApi the app uses, so ADR-051 visibility and
 * ADR-065 belonging rules apply automatically — a web app sees exactly
 * what the signed-in user sees, nothing more.
 *
 * READ-ONLY by construction: only GET routes exist; any other method is
 * 405. There is no raw-Cypher route — arbitrary Cypher can't be
 * viewer-scoped, so the bridge exposes the gated read OPERATIONS
 * (spaces, items, item, search), the same surface as spaces-mcp.
 *
 * The request handler is separated from the listener so it's unit-tested
 * without opening a socket.
 */

import * as http from 'node:http';
import { isAllowedOrigin } from './origin.js';

/** The gated reads the bridge needs. Adapter over SpacesApi in main.ts. */
export interface NeonReads {
  listSpaces(): Promise<unknown>;
  listItems(spaceId: string): Promise<unknown>;
  getItem(id: string): Promise<unknown>;
  search(query: string, spaceId: string | undefined): Promise<unknown>;
}

export interface NeonBridgeDeps {
  reads: NeonReads;
  /** Origin policy (injected; defaults to the ADR-081 allowlist). */
  isAllowed?: (origin: string | undefined | null) => boolean;
  logger?: {
    info: (msg: string, data?: unknown) => void;
    warn: (msg: string, data?: unknown) => void;
  };
}

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

function sendJson(
  res: http.ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string>
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

/**
 * Build the request handler. Pure over its deps — no sockets, no
 * electron — so tests drive it with fake req/res.
 */
export function makeNeonBridgeHandler(deps: NeonBridgeDeps): Handler {
  const isAllowed = deps.isAllowed ?? ((o) => isAllowedOrigin(o));
  const log = deps.logger ?? { info: () => undefined, warn: () => undefined };

  return (req, res) => {
    void (async () => {
      const origin = req.headers.origin;
      const allowed = isAllowed(origin);

      // CORS headers are only ever emitted for an allowed origin. A
      // disallowed browser origin gets NO Access-Control-Allow-Origin
      // (so the browser blocks the read) AND a 403 (so it's explicit).
      const cors: Record<string, string> = {};
      if (allowed && typeof origin === 'string' && origin.length > 0) {
        cors['Access-Control-Allow-Origin'] = origin;
        cors['Vary'] = 'Origin';
        cors['Access-Control-Allow-Methods'] = 'GET, OPTIONS';
        cors['Access-Control-Allow-Headers'] = 'Content-Type';
      }

      if (!allowed) {
        log.warn('neon-bridge: refused disallowed origin', { origin });
        sendJson(res, 403, { error: 'Origin not allowed' }, {});
        return;
      }

      if (req.method === 'OPTIONS') {
        res.writeHead(204, cors);
        res.end();
        return;
      }

      // Read-only: nothing but GET is served.
      if (req.method !== 'GET') {
        sendJson(res, 405, { error: 'This bridge is read-only (GET only).' }, cors);
        return;
      }

      let url: URL;
      try {
        url = new URL(req.url ?? '/', 'http://localhost');
      } catch {
        sendJson(res, 400, { error: 'Bad request URL' }, cors);
        return;
      }
      const path = url.pathname;

      try {
        if (path === '/neon/health') {
          sendJson(res, 200, { ok: true, service: 'neon-bridge', readOnly: true }, cors);
          return;
        }
        if (path === '/neon/spaces') {
          sendJson(res, 200, { spaces: await deps.reads.listSpaces() }, cors);
          return;
        }
        if (path === '/neon/search') {
          const q = url.searchParams.get('q') ?? '';
          if (q.trim().length === 0) {
            sendJson(res, 400, { error: 'q (query) is required' }, cors);
            return;
          }
          const spaceId = url.searchParams.get('spaceId') ?? undefined;
          sendJson(res, 200, { results: await deps.reads.search(q, spaceId) }, cors);
          return;
        }
        const itemsMatch = path.match(/^\/neon\/spaces\/([^/]+)\/items$/);
        if (itemsMatch) {
          const spaceId = decodeURIComponent(itemsMatch[1] ?? '');
          sendJson(res, 200, { items: await deps.reads.listItems(spaceId) }, cors);
          return;
        }
        const itemMatch = path.match(/^\/neon\/items\/([^/]+)$/);
        if (itemMatch) {
          const id = decodeURIComponent(itemMatch[1] ?? '');
          const item = await deps.reads.getItem(id);
          if (item === null || item === undefined) {
            sendJson(res, 404, { error: 'Not found (or not visible to you)' }, cors);
            return;
          }
          sendJson(res, 200, { item }, cors);
          return;
        }
        sendJson(res, 404, { error: `Unknown route: ${path}` }, cors);
      } catch (err) {
        log.warn('neon-bridge: read failed', { path, error: (err as Error).message });
        sendJson(res, 500, { error: (err as Error).message }, cors);
      }
    })().catch(() => {
      if (!res.headersSent) {
        res.writeHead(500);
        res.end();
      }
    });
  };
}

export interface NeonBridgeServer {
  port: number;
  close(): Promise<void>;
}

/**
 * Start the bridge on 127.0.0.1. Tries `port`, then a couple of
 * fallbacks so a busy port never blocks boot. Returns the chosen port.
 */
export async function startNeonBridge(
  deps: NeonBridgeDeps,
  opts: { port?: number; host?: string } = {}
): Promise<NeonBridgeServer> {
  const host = opts.host ?? '127.0.0.1';
  const basePort = opts.port ?? 47294;
  const handler = makeNeonBridgeHandler(deps);
  const server = http.createServer(handler);

  const tryListen = (port: number): Promise<number> =>
    new Promise((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException): void => {
        server.removeListener('error', onError);
        reject(err);
      };
      server.once('error', onError);
      server.listen(port, host, () => {
        server.removeListener('error', onError);
        resolve(port);
      });
    });

  let chosen = -1;
  for (const port of [basePort, basePort + 1, basePort + 2]) {
    try {
      chosen = await tryListen(port);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;
    }
  }
  if (chosen < 0) {
    throw new Error(`neon-bridge: no free port near ${basePort}`);
  }
  deps.logger?.info('neon-bridge: listening', { host, port: chosen });
  return {
    port: chosen,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
