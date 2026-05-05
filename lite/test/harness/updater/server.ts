/**
 * Onereach Lite Test Harness -- local update server.
 *
 * Serves latest-mac.yml + .zip + .blockmap from a fixture directory
 * over plain HTTP on a configurable port (default OS-assigned). Used by
 * E2E updater scenarios as a stand-in for GitHub releases.
 *
 * Borrowed pattern: test-update-server/server.js (full's local server).
 * Rewritten in TypeScript with promisified start/stop and OS-assigned
 * ports so multiple tests can run in parallel.
 */

import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { promises as fsp } from 'node:fs';
import type { AddressInfo } from 'node:net';

export interface UpdateServerOptions {
  /** Directory whose contents are served (must contain latest-mac.yml + zips). */
  servingDir: string;
  /** Port to listen on. 0 = OS-assigned (recommended for tests). */
  port?: number;
  /** Optional logger -- defaults to silent. */
  logger?: (msg: string, data?: unknown) => void;
  /** Optional override for the default YAML basename. */
  defaultYaml?: string;
}

export interface UpdateServerHandle {
  /** http.Server instance. */
  server: http.Server;
  /** Resolved port (the OS-assigned one if port: 0 was used). */
  port: number;
  /** Base URL for clients (e.g. http://127.0.0.1:NNNN). */
  baseUrl: string;
  /** Stop the server. Resolves once it's closed. */
  stop(): Promise<void>;
  /** Number of requests served so far. Useful for assertions. */
  requestCount(): number;
  /** List of paths served (in arrival order). Useful for assertions. */
  requestLog(): string[];
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.yml': 'text/yaml',
  '.yaml': 'text/yaml',
  '.zip': 'application/zip',
  '.dmg': 'application/x-apple-diskimage',
  '.blockmap': 'application/octet-stream',
};

/**
 * Boot the server. Resolves once it's listening.
 */
export async function startUpdateServer(opts: UpdateServerOptions): Promise<UpdateServerHandle> {
  const log = opts.logger;
  const defaultYaml = opts.defaultYaml ?? 'latest-mac.yml';
  const requests: string[] = [];

  await fsp.mkdir(opts.servingDir, { recursive: true });

  const server = http.createServer((req, res) => {
    const reqUrl = req.url ?? '/';
    requests.push(reqUrl);
    log?.(`request: ${req.method} ${reqUrl}`);

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    // Strip query string before mapping URL to file path.
    // electron-updater appends `?noCache=...` to defeat HTTP caching, and
    // path.join() would otherwise treat the whole `latest-mac.yml?noCache=...`
    // as a literal filename and 404. Caught by test-update-live.mjs.
    const pathOnly = reqUrl.split('?')[0] ?? '/';
    const requested = pathOnly === '/' ? `/${defaultYaml}` : pathOnly;
    const filePath = path.join(opts.servingDir, decodeURIComponent(requested));

    // Path traversal guard: stay inside servingDir.
    const resolvedServing = path.resolve(opts.servingDir);
    const resolvedTarget = path.resolve(filePath);
    if (
      resolvedTarget !== resolvedServing &&
      !resolvedTarget.startsWith(resolvedServing + path.sep)
    ) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden');
      return;
    }

    if (!fs.existsSync(resolvedTarget)) {
      log?.(`not found: ${resolvedTarget}`);
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('File not found');
      return;
    }

    const ext = path.extname(resolvedTarget);
    const contentType = CONTENT_TYPES[ext] ?? 'application/octet-stream';

    fs.readFile(resolvedTarget, (err, data) => {
      if (err) {
        log?.(`read error: ${err.message}`);
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Internal server error');
        return;
      }
      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': data.length,
      });
      res.end(data);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const addr = server.address() as AddressInfo;
  const port = addr.port;
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    server,
    port,
    baseUrl,
    requestCount: () => requests.length,
    requestLog: () => [...requests],
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
