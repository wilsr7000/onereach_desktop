/**
 * Agent gateway — malformed JSON must be ANSWERED, never hang (2026-09-01
 * API bug hunt). Before the fix, _router returned each handler's promise
 * un-awaited, so _readJsonBody's rejection escaped the try/catch as an
 * unhandled rejection and no response was ever written: a POST with a
 * bad JSON body hung the client until its own timeout. Now every handler
 * is awaited and body-parse failures carry statusCode 400.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
const http = require('http');
const path = require('path');

const HUDAPI_ABS = path.resolve(__dirname, '../../lib/hud-api.js');
const STATS_ABS = path.resolve(__dirname, '../../lib/agent-stats.js');
const GATEWAY_ABS = path.resolve(__dirname, '../../lib/agent-gateway.js');

function _fake(absPath, fake) {
  require.cache[absPath] = { id: absPath, filename: absPath, loaded: true, exports: fake };
}

let server;
let gatewayMod;

beforeEach(async () => {
  _fake(HUDAPI_ABS, {
    submitTask: async () => ({ taskId: 't1', queued: true }),
    respondToInput: async () => ({ success: true }),
    selectDisambiguation: async () => ({ success: true }),
    cancelTask: () => {},
  });
  _fake(STATS_ABS, { getAgentStats: () => ({ getTaskTimeline: () => [] }) });
  delete require.cache[GATEWAY_ABS];
  gatewayMod = require('../../lib/agent-gateway');
  server = http.createServer((req, res) => gatewayMod._router(req, res));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
});

afterEach(async () => {
  await new Promise((r) => server.close(() => r()));
  delete require.cache[HUDAPI_ABS];
  delete require.cache[STATS_ABS];
  delete require.cache[GATEWAY_ABS];
});

/** Send a RAW body (not JSON.stringify'd) and race it against a hang timeout. */
function postRaw(pathname, raw, timeoutMs = 2000) {
  const addr = server.address();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`HANG: no response within ${timeoutMs}ms`)), timeoutMs);
    const req = http.request(
      { host: addr.address, port: addr.port, method: 'POST', path: pathname,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(raw) } },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { body += c; });
        res.on('end', () => { clearTimeout(timer); resolve({ status: res.statusCode, body }); });
      }
    );
    req.on('error', (e) => { clearTimeout(timer); reject(e); });
    req.write(raw);
    req.end();
  });
}

describe('malformed JSON bodies are answered with 400, never hang', () => {
  for (const route of ['/submit-task', '/playbook-qa', '/respond-input', '/cancel-task', '/select-disambiguation']) {
    it(`POST ${route} with a non-JSON body → 400 promptly`, async () => {
      const r = await postRaw(route, 'not json at all');
      expect(r.status).toBe(400);
      expect(r.body).toMatch(/Invalid JSON body/);
    });
  }

  it('an oversized body → 400 (client error), not 500', async () => {
    // Just over the 256 KiB default cap.
    const r = await postRaw('/submit-task', '{"text":"' + 'x'.repeat(260 * 1024) + '"}', 4000).catch((e) => e);
    // Either a prompt 400 or a socket reset from req.destroy() — never a hang.
    if (r instanceof Error) expect(r.message).not.toMatch(/HANG/);
    else expect(r.status).toBe(400);
  });

  it('valid JSON still works end to end (regression guard for the await change)', async () => {
    const r = await postRaw('/submit-task', JSON.stringify({ text: 'hello' }));
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toMatchObject({ taskId: 't1' });
  });
});
