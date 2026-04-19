/**
 * Agent Gateway -- Phase 6 HTTP / SSE shell
 *
 * Tests the router + SSE subscription behavior without actually
 * binding a port (spin up a raw http.Server with an ephemeral port
 * per test so teardown is fast and parallel-safe).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
const http = require('http');
const path = require('path');

const FLAGS_ABS = path.resolve(__dirname, '../../lib/agent-system-flags.js');
const HUDAPI_ABS = path.resolve(__dirname, '../../lib/hud-api.js');
const STATS_ABS = path.resolve(__dirname, '../../src/voice-task-sdk/agent-stats.js');
const GATEWAY_ABS = path.resolve(__dirname, '../../lib/agent-gateway.js');

function _setFlag(enabled) {
  require.cache[FLAGS_ABS] = {
    id: FLAGS_ABS,
    filename: FLAGS_ABS,
    loaded: true,
    exports: {
      isAgentFlagEnabled: (name) => (name === 'httpGateway' ? enabled : false),
    },
  };
}

function _setHudApi(fake) {
  require.cache[HUDAPI_ABS] = {
    id: HUDAPI_ABS,
    filename: HUDAPI_ABS,
    loaded: true,
    exports: fake,
  };
}

function _setStats(fake) {
  require.cache[STATS_ABS] = {
    id: STATS_ABS,
    filename: STATS_ABS,
    loaded: true,
    exports: fake,
  };
}

function _reloadGateway() {
  delete require.cache[GATEWAY_ABS];
  return require('../../lib/agent-gateway');
}

async function _readJson(res) {
  return new Promise((resolve) => {
    let raw = '';
    res.setEncoding('utf8');
    res.on('data', (c) => { raw += c; });
    res.on('end', () => {
      try { resolve(JSON.parse(raw)); } catch { resolve(raw); }
    });
  });
}

function _post(server, pathname, body) {
  const addr = server.address();
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: addr.address,
      port: addr.port,
      method: 'POST',
      path: pathname,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, async (res) => resolve({ status: res.statusCode, body: await _readJson(res) }));
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function _get(server, pathname) {
  const addr = server.address();
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: addr.address,
      port: addr.port,
      method: 'GET',
      path: pathname,
    }, async (res) => resolve({ status: res.statusCode, body: await _readJson(res) }));
    req.on('error', reject);
    req.end();
  });
}

// ---- Test setup -------------------------------------------------------

let gatewayMod;
let server;

beforeEach(() => {
  _setFlag(true);
  _setHudApi({
    submitTask: async (text, opts) => ({ taskId: 't1', queued: true, text, opts }),
    respondToInput: async (taskId, response) => ({ success: true, taskId, response }),
    selectDisambiguation: async (stateId, opts) => ({ success: true, stateId, ...opts }),
    cancelTask: vi.fn(),
  });
  _setStats({
    getAgentStats: () => ({
      getTaskTimeline: (taskId) => (taskId === 't-has-history'
        ? [{ taskId, type: 'queued', at: 1 }, { taskId, type: 'completed', at: 2 }]
        : []),
    }),
  });
  gatewayMod = _reloadGateway();
});

afterEach(async () => {
  if (server) {
    await new Promise((r) => server.close(() => r()));
    server = null;
  }
  delete require.cache[FLAGS_ABS];
  delete require.cache[HUDAPI_ABS];
  delete require.cache[STATS_ABS];
  delete require.cache[GATEWAY_ABS];
});

async function _bindRouter() {
  server = http.createServer((req, res) => gatewayMod._router(req, res));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return server;
}

// ---- Flag gate --------------------------------------------------------

describe('feature flag gate', () => {
  it('returns 503 when httpGateway is off', async () => {
    _setFlag(false);
    gatewayMod = _reloadGateway();
    await _bindRouter();
    const r = await _post(server, '/submit-task', { text: 'x' });
    expect(r.status).toBe(503);
    expect(r.body.error).toMatch(/disabled/);
  });
});

// ---- POST /submit-task ------------------------------------------------

describe('POST /submit-task', () => {
  it('delegates to hud-api.submitTask and returns its result', async () => {
    await _bindRouter();
    const r = await _post(server, '/submit-task', {
      text: 'evaluate this plan',
      toolId: 'my-cli',
      spaceId: 'planning',
      variant: 'council',
      criteria: [{ id: 'clarity' }],
    });
    expect(r.status).toBe(200);
    expect(r.body.taskId).toBe('t1');
    expect(r.body.text).toBe('evaluate this plan');
    expect(r.body.opts.toolId).toBe('my-cli');
    expect(r.body.opts.spaceId).toBe('planning');
    expect(r.body.opts.variant).toBe('council');
    expect(r.body.opts.skipFilter).toBe(true);
  });

  it('rejects missing text with 400', async () => {
    await _bindRouter();
    const r = await _post(server, '/submit-task', {});
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/text is required/);
  });

  it('rejects empty/whitespace text with 400', async () => {
    await _bindRouter();
    const r = await _post(server, '/submit-task', { text: '   ' });
    expect(r.status).toBe(400);
  });

  it('defaults toolId to agent-gateway', async () => {
    await _bindRouter();
    const r = await _post(server, '/submit-task', { text: 'hello' });
    expect(r.body.opts.toolId).toBe('agent-gateway');
  });
});

// ---- POST /respond-input ----------------------------------------------

describe('POST /respond-input', () => {
  it('delegates to hud-api.respondToInput', async () => {
    await _bindRouter();
    const r = await _post(server, '/respond-input', { taskId: 't1', response: 'the answer' });
    expect(r.status).toBe(200);
    expect(r.body.taskId).toBe('t1');
    expect(r.body.response).toBe('the answer');
  });

  it('400 when taskId or response missing', async () => {
    await _bindRouter();
    const r = await _post(server, '/respond-input', { taskId: 't1' });
    expect(r.status).toBe(400);
  });

  it('501 when hud-api does not implement respondToInput', async () => {
    _setHudApi({ submitTask: async () => ({}), cancelTask: () => {} });
    gatewayMod = _reloadGateway();
    await _bindRouter();
    const r = await _post(server, '/respond-input', { taskId: 't1', response: 'x' });
    expect(r.status).toBe(501);
  });
});

// ---- POST /select-disambiguation --------------------------------------

describe('POST /select-disambiguation', () => {
  it('delegates with optionIndex', async () => {
    await _bindRouter();
    const r = await _post(server, '/select-disambiguation', { stateId: 's1', optionIndex: 2 });
    expect(r.status).toBe(200);
    expect(r.body.stateId).toBe('s1');
    expect(r.body.optionIndex).toBe(2);
  });

  it('delegates with customText', async () => {
    await _bindRouter();
    const r = await _post(server, '/select-disambiguation', { stateId: 's1', customText: 'the third option' });
    expect(r.status).toBe(200);
    expect(r.body.customText).toBe('the third option');
  });

  it('400 when stateId is missing', async () => {
    await _bindRouter();
    const r = await _post(server, '/select-disambiguation', { optionIndex: 0 });
    expect(r.status).toBe(400);
  });
});

// ---- POST /cancel-task ------------------------------------------------

describe('POST /cancel-task', () => {
  it('calls hud-api.cancelTask and returns success', async () => {
    const cancel = vi.fn();
    _setHudApi({ submitTask: async () => ({}), cancelTask: cancel });
    gatewayMod = _reloadGateway();
    await _bindRouter();
    const r = await _post(server, '/cancel-task', { taskId: 't1' });
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    expect(cancel).toHaveBeenCalledWith('t1');
  });

  it('400 when taskId missing', async () => {
    await _bindRouter();
    const r = await _post(server, '/cancel-task', {});
    expect(r.status).toBe(400);
  });
});

// ---- GET /health ------------------------------------------------------

describe('GET /health', () => {
  it('returns ok + subscriber counts', async () => {
    await _bindRouter();
    const r = await _get(server, '/health');
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(typeof r.body.pid).toBe('number');
    expect(typeof r.body.subscribers).toBe('number');
    expect(typeof r.body.tasks).toBe('number');
  });
});

// ---- GET /events/:taskId (SSE) ---------------------------------------

describe('GET /events/:taskId -- SSE replay + live', () => {
  it('replays persisted timeline then holds the stream open', async () => {
    await _bindRouter();
    const addr = server.address();
    await new Promise((resolve, reject) => {
      const req = http.request({
        host: addr.address,
        port: addr.port,
        method: 'GET',
        path: '/events/t-has-history',
      }, (res) => {
        expect(res.statusCode).toBe(200);
        expect(res.headers['content-type']).toMatch(/event-stream/);
        let buf = '';
        res.on('data', (c) => {
          buf += c.toString('utf8');
          // We expect two SSE events from the replay.
          const events = buf.split('\n\n').filter((s) => s.startsWith('data:'));
          if (events.length >= 2) {
            expect(events[0]).toContain('"queued"');
            expect(events[1]).toContain('"completed"');
            req.destroy();
            resolve();
          }
        });
        res.on('error', () => { /* client destroy */ });
      });
      req.on('error', (err) => {
        if (err.code === 'ECONNRESET') resolve();
        else reject(err);
      });
      req.end();
    });
  });

  it('broadcasts live lifecycle to subscribers', async () => {
    await _bindRouter();
    const addr = server.address();

    const received = [];
    const clientReq = http.request({
      host: addr.address,
      port: addr.port,
      method: 'GET',
      path: '/events/t-live',
    }, (res) => {
      res.on('data', (c) => {
        const s = c.toString('utf8');
        const match = s.match(/data:\s*(\{[^\n]*\})/);
        if (match) received.push(JSON.parse(match[1]));
      });
    });
    clientReq.on('error', () => { /* swallow -- we'll destroy below */ });
    clientReq.end();

    // Give the subscribe a beat to register
    await new Promise((r) => setTimeout(r, 50));

    gatewayMod.broadcastLifecycle('t-live', { type: 'queued', taskId: 't-live', at: 1 });
    gatewayMod.broadcastLifecycle('t-live', { type: 'completed', taskId: 't-live', at: 2 });
    gatewayMod.broadcastLifecycle('t-other', { type: 'noise' }); // should NOT arrive

    await new Promise((r) => setTimeout(r, 60));
    clientReq.destroy();

    expect(received.length).toBeGreaterThanOrEqual(2);
    const types = received.map((e) => e.type);
    expect(types).toContain('queued');
    expect(types).toContain('completed');
    expect(types).not.toContain('noise');
  });

  it('unsubscribes cleanly on client close', async () => {
    await _bindRouter();
    const addr = server.address();
    const clientReq = http.request({
      host: addr.address,
      port: addr.port,
      method: 'GET',
      path: '/events/t-close',
    }, () => { /* ignore */ });
    clientReq.on('error', () => { /* swallow */ });
    clientReq.end();
    await new Promise((r) => setTimeout(r, 30));
    expect(gatewayMod._subscribers.has('t-close')).toBe(true);
    clientReq.destroy();
    await new Promise((r) => setTimeout(r, 30));
    expect(gatewayMod._subscribers.has('t-close')).toBe(false);
  });
});

// ---- CORS preflight + unknown routes ---------------------------------

describe('misc', () => {
  it('CORS preflight returns 204 with allow headers', async () => {
    await _bindRouter();
    const addr = server.address();
    const r = await new Promise((resolve, reject) => {
      const req = http.request({
        host: addr.address,
        port: addr.port,
        method: 'OPTIONS',
        path: '/submit-task',
      }, (res) => { resolve({ status: res.statusCode, headers: res.headers }); res.resume(); });
      req.on('error', reject);
      req.end();
    });
    expect(r.status).toBe(204);
    expect(r.headers['access-control-allow-methods']).toMatch(/POST/);
  });

  it('unknown route returns 404', async () => {
    await _bindRouter();
    const r = await _get(server, '/nope');
    expect(r.status).toBe(404);
  });
});
