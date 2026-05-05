/**
 * In-memory HTTP server that mimics the OneReach Edison KV flow.
 *
 * Used by integration tests to drive `EdisonKVClient` against a real
 * fetch + real wire format, without the latency / flakiness of the
 * actual remote service.
 *
 * Contract reproduced (see `lite/kv/client.ts` header for the source):
 *
 *   PUT    /keyvalue?id={collection}&key={key}
 *     body: { id, key, itemValue: <JSON-stringified value> }
 *
 *   GET    /keyvalue?id={collection}&key={key}
 *     -> 200 { value: <JSON-stringified> }
 *     -> 200 { Status: "No data found." } when missing
 *
 *   POST   /keyvalue
 *     body: { id: collection }
 *     -> 200 [{ key: "..." }, ...]
 *     -> 200 { Status: "No data found." } when empty
 *
 *   DELETE /keyvalue?id={collection}&key={key}
 *     -> 204 / 200
 *
 * Test injection hooks:
 *
 *   server.failNextRequest({ status, body })
 *     Force the next incoming request to return a synthetic failure.
 *
 *   server.delayNextRequest(ms)
 *     Sleep before responding to the next request (for timeout tests).
 *
 *   server.getRequests() / server.reset()
 *     Inspect the recorded request log; clear state between tests.
 */

import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';

interface RecordedRequest {
  method: string;
  url: string;
  body: string;
  collection: string | null;
  key: string | null;
}

interface InjectedFailure {
  status: number;
  body: string;
}

export interface InMemoryKVServer {
  /** Full URL the server is listening on (e.g. http://127.0.0.1:51234). */
  readonly url: string;
  /** Port the server bound to. */
  readonly port: number;
  /** Stop the server. Returns a promise that resolves when closed. */
  stop(): Promise<void>;
  /** Clear the in-memory store and recorded request log. */
  reset(): void;
  /** Inspect every request the server has handled since last reset. */
  getRequests(): ReadonlyArray<RecordedRequest>;
  /** Force the next request to return a synthetic failure. */
  failNextRequest(failure: InjectedFailure): void;
  /** Sleep `ms` milliseconds before responding to the next request. */
  delayNextRequest(ms: number): void;
  /** Direct access to the in-memory store, keyed by `${collection}::${key}`. */
  readonly store: Map<string, unknown>;
}

/**
 * Spin up an in-memory HTTP server that speaks the OneReach KV
 * protocol. Listens on a random localhost port (or the one you pass).
 *
 * @param port Optional explicit port. Default: 0 (OS picks one).
 * @returns Handle to the running server.
 *
 * @example
 * ```typescript
 * const server = await startInMemoryKVServer();
 * const client = new EdisonKVClient({ url: `${server.url}/keyvalue` });
 * await client.set('coll', 'key', { foo: 'bar' });
 * await server.stop();
 * ```
 */
export async function startInMemoryKVServer(port = 0): Promise<InMemoryKVServer> {
  const store = new Map<string, unknown>();
  const requests: RecordedRequest[] = [];
  let injectedFailure: InjectedFailure | null = null;
  let injectedDelayMs = 0;

  const httpServer = createServer((req, res) => {
    void handleRequest(req, res);
  });

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readBody(req);
    const url = req.url ?? '/';
    const params = new URL(url, 'http://localhost').searchParams;
    const collection = params.get('id');
    const key = params.get('key');

    requests.push({
      method: req.method ?? 'GET',
      url,
      body,
      collection,
      key,
    });

    // Apply injected delay first (used for timeout tests).
    if (injectedDelayMs > 0) {
      const delay = injectedDelayMs;
      injectedDelayMs = 0;
      await new Promise((r) => setTimeout(r, delay));
    }

    // Apply injected failure -- consumed once.
    if (injectedFailure !== null) {
      const f = injectedFailure;
      injectedFailure = null;
      res.statusCode = f.status;
      res.setHeader('Content-Type', 'application/json');
      res.end(f.body);
      return;
    }

    try {
      switch (req.method) {
        case 'PUT':
          handlePut(res, body, store);
          return;
        case 'GET':
          handleGet(res, collection, key, store);
          return;
        case 'POST':
          handlePost(res, body, store);
          return;
        case 'DELETE':
          handleDelete(res, collection, key, store);
          return;
        default:
          res.statusCode = 405;
          res.end(`Method ${req.method} not allowed`);
      }
    } catch (err) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
  }

  await new Promise<void>((resolve) => {
    httpServer.listen(port, '127.0.0.1', () => resolve());
  });

  const address = httpServer.address() as AddressInfo;
  const boundPort = address.port;
  const url = `http://127.0.0.1:${boundPort}`;

  return {
    url,
    port: boundPort,
    store,
    async stop(): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
      });
    },
    reset(): void {
      store.clear();
      requests.length = 0;
      injectedFailure = null;
      injectedDelayMs = 0;
    },
    getRequests(): ReadonlyArray<RecordedRequest> {
      return [...requests];
    },
    failNextRequest(failure: InjectedFailure): void {
      injectedFailure = failure;
    },
    delayNextRequest(ms: number): void {
      injectedDelayMs = ms;
    },
  };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

interface PutBody {
  id?: unknown;
  key?: unknown;
  itemValue?: unknown;
}

function handlePut(
  res: ServerResponse,
  body: string,
  store: Map<string, unknown>
): void {
  let parsed: PutBody;
  try {
    parsed = JSON.parse(body) as PutBody;
  } catch {
    res.statusCode = 400;
    res.end('invalid JSON body');
    return;
  }
  if (typeof parsed.id !== 'string' || typeof parsed.key !== 'string') {
    res.statusCode = 400;
    res.end('PUT body must include id and key');
    return;
  }
  // The contract says itemValue is a JSON string; parse it so the
  // store holds the deserialized value (matching the upstream
  // behavior).
  let value: unknown = parsed.itemValue;
  if (typeof parsed.itemValue === 'string') {
    try {
      value = JSON.parse(parsed.itemValue);
    } catch {
      // Plain string -- keep as-is.
      value = parsed.itemValue;
    }
  }
  store.set(`${parsed.id}::${parsed.key}`, value);
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ Status: 'OK' }));
}

function handleGet(
  res: ServerResponse,
  collection: string | null,
  key: string | null,
  store: Map<string, unknown>
): void {
  if (collection === null || key === null) {
    res.statusCode = 400;
    res.end('GET requires id and key query params');
    return;
  }
  const stored = store.get(`${collection}::${key}`);
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json');
  if (stored === undefined) {
    res.end(JSON.stringify({ Status: 'No data found.' }));
    return;
  }
  // Upstream wraps the value as a JSON-stringified inner string.
  res.end(JSON.stringify({ value: JSON.stringify(stored) }));
}

interface PostBody {
  id?: unknown;
}

function handlePost(
  res: ServerResponse,
  body: string,
  store: Map<string, unknown>
): void {
  let parsed: PostBody;
  try {
    parsed = JSON.parse(body) as PostBody;
  } catch {
    res.statusCode = 400;
    res.end('invalid JSON body');
    return;
  }
  if (typeof parsed.id !== 'string') {
    res.statusCode = 400;
    res.end('POST body must include id (collection)');
    return;
  }
  const collection = parsed.id;
  const keys: Array<{ key: string }> = [];
  for (const k of store.keys()) {
    const [coll, key] = k.split('::', 2) as [string, string];
    if (coll === collection) keys.push({ key });
  }
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json');
  if (keys.length === 0) {
    res.end(JSON.stringify({ Status: 'No data found.' }));
    return;
  }
  res.end(JSON.stringify(keys));
}

function handleDelete(
  res: ServerResponse,
  collection: string | null,
  key: string | null,
  store: Map<string, unknown>
): void {
  if (collection === null || key === null) {
    res.statusCode = 400;
    res.end('DELETE requires id and key query params');
    return;
  }
  store.delete(`${collection}::${key}`);
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ Status: 'OK' }));
}
