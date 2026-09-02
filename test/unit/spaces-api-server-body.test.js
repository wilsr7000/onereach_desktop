/**
 * spaces-api-server readRequestBody — malformed-JSON guard (2026-09-01
 * API bug hunt). Every route did an unguarded JSON.parse(body) and
 * answered a client's bad JSON with a 500 SERVER_ERROR. The fix is one
 * central check in readRequestBody: when the request declares JSON and
 * the body doesn't parse, answer 400 and resolve null (the contract
 * routes already honor for the 413 path). These tests drive that seam
 * with a fake req/res — no socket, no electron.
 */
import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp', isPackaged: false } }));
vi.mock('../../lib/log-event-queue', () => ({
  getLogQueue: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

const { SpacesAPIServer } = require('../../spaces-api-server');

function fakeReq(body, contentType) {
  const req = new EventEmitter();
  req.headers = contentType ? { 'content-type': contentType } : {};
  // emit after the listeners attach
  setImmediate(() => {
    if (body.length) req.emit('data', body);
    req.emit('end');
  });
  return req;
}
function fakeRes() {
  const res = { headersSent: false, status: 0, body: '' };
  res.writeHead = (s) => { res.status = s; res.headersSent = true; };
  res.end = (b) => { res.body = b || ''; };
  return res;
}

describe('readRequestBody malformed-JSON guard', () => {
  it('answers 400 (not 500) and resolves null for bad JSON declared as JSON', async () => {
    const srv = new SpacesAPIServer();
    const res = fakeRes();
    const out = await srv.readRequestBody(fakeReq('not json', 'application/json'), res);
    expect(out).toBeNull();
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body)).toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('passes valid JSON through untouched', async () => {
    const srv = new SpacesAPIServer();
    const res = fakeRes();
    const out = await srv.readRequestBody(fakeReq('{"a":1}', 'application/json'), res);
    expect(out).toBe('{"a":1}');
    expect(res.status).toBe(0);
  });

  it('does not JSON-validate bodies that are not declared JSON', async () => {
    const srv = new SpacesAPIServer();
    const res = fakeRes();
    const out = await srv.readRequestBody(fakeReq('plain text body', 'text/plain'), res);
    expect(out).toBe('plain text body');
    expect(res.status).toBe(0);
  });

  it('an empty body resolves empty (routes decide), no 400', async () => {
    const srv = new SpacesAPIServer();
    const res = fakeRes();
    const out = await srv.readRequestBody(fakeReq('', 'application/json'), res);
    expect(out).toBe('');
    expect(res.status).toBe(0);
  });
});
