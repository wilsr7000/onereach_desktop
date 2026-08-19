/**
 * POST /playbook-qa — the API seam.
 *
 * Tested over REAL HTTP on an ephemeral port, because this is the layer
 * that ships broken: the checklist button (2026-08-18) died from a
 * handler registered in the wrong scope, and playbook-search's own IPC
 * handlers have no coverage at all. An agent calling this route is the
 * only consumer that will notice, and it will notice as silence.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
const http = require('http');
const path = require('path');

const GATEWAY_ABS = path.resolve(__dirname, '../../lib/agent-gateway.js');
const QA_ABS = path.resolve(__dirname, '../../lib/playbook-qa.js');

vi.mock('../../lib/log-event-queue', () => ({
  getLogQueue: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

function _setQa(fake) {
  require.cache[QA_ABS] = { id: QA_ABS, filename: QA_ABS, loaded: true, exports: fake };
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
    const req = http.request(
      {
        host: addr.address,
        port: addr.port,
        method: 'POST',
        path: pathname,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      },
      async (res) => resolve({ status: res.statusCode, body: await _readJson(res) })
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

let server = null;

function _serve(gateway) {
  server = http.createServer((req, res) => gateway._router(req, res));
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

afterEach(async () => {
  if (server) await new Promise((r) => server.close(r));
  server = null;
  delete require.cache[QA_ABS];
});

beforeEach(() => {
  delete require.cache[QA_ABS];
});

describe('POST /playbook-qa', () => {
  it('answers a question and returns the agent shape', async () => {
    const answer = vi.fn(async (q, opts) => ({
      question: q,
      mode: 'quality',
      answer: 'Assessed 3 playbooks.',
      results: [{ id: 'pb-good', title: 'Deploy Runbook', score: 0.9 }],
      evaluated: 3,
      totalCandidates: 3,
      _opts: opts,
    }));
    _setQa({ answerPlaybookQuestion: answer });
    await _serve(_reloadGateway());

    const res = await _post(server, '/playbook-qa', { question: 'which are well written?' });
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe('quality');
    expect(res.body.answer).toContain('Assessed 3 playbooks');
    expect(res.body.results[0].id).toBe('pb-good');
    expect(answer).toHaveBeenCalledWith('which are well written?', { mode: 'auto' });
  });

  it('passes scope, limit, refresh and profile through to the agent', async () => {
    const answer = vi.fn(async () => ({ mode: 'quality', answer: '', results: [] }));
    _setQa({ answerPlaybookQuestion: answer });
    await _serve(_reloadGateway());

    await _post(server, '/playbook-qa', {
      question: 'rate these',
      mode: 'quality',
      spaceId: 'ops',
      limit: 5,
      refresh: true,
      profile: 'powerful',
    });
    expect(answer.mock.calls[0][1]).toEqual({
      mode: 'quality',
      spaceId: 'ops',
      limit: 5,
      refresh: true,
      profile: 'powerful',
    });
  });

  it('rejects an empty question instead of sweeping the corpus', async () => {
    const answer = vi.fn();
    _setQa({ answerPlaybookQuestion: answer });
    await _serve(_reloadGateway());

    const res = await _post(server, '/playbook-qa', { question: '   ' });
    expect(res.status).toBe(400);
    expect(answer).not.toHaveBeenCalled();
  });

  it('rejects an unknown mode rather than silently guessing', async () => {
    _setQa({ answerPlaybookQuestion: vi.fn() });
    await _serve(_reloadGateway());
    const res = await _post(server, '/playbook-qa', { question: 'x', mode: 'vibes' });
    expect(res.status).toBe(400);
    expect(String(res.body.error || res.body)).toContain('vibes');
  });

  it('a mid-sweep failure is a 500, never an empty-but-successful answer', async () => {
    // "no playbooks are well written" and "I could not check" are
    // different claims; only one of them is honest here.
    _setQa({
      answerPlaybookQuestion: vi.fn(async () => {
        throw new Error('LLM unavailable');
      }),
    });
    await _serve(_reloadGateway());
    const res = await _post(server, '/playbook-qa', { question: 'which are well written?' });
    expect(res.status).toBe(500);
    expect(String(res.body.error || res.body)).toContain('LLM unavailable');
  });

  it('is reachable as a route at all (the dead-handler regression)', async () => {
    _setQa({ answerPlaybookQuestion: vi.fn(async () => ({ mode: 'retrieval', results: [] })) });
    await _serve(_reloadGateway());
    const res = await _post(server, '/playbook-qa', { question: 'deploy' });
    expect(res.status).not.toBe(404);
  });
});
