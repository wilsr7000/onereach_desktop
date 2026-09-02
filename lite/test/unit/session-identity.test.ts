/**
 * MCP session identity resolution (2026-09-01 identity audit). The
 * authenticated app session wins; env is a loud fallback; nothing → fail
 * closed. fetch is injected so no socket is opened.
 */
import { describe, it, expect } from 'vitest';
import { resolveSessionViewer } from '../../mcp/session-identity.js';

const bridgeAnswering = (viewerId: string | null) =>
  (async () => ({ ok: true, json: async () => ({ viewerId }) })) as unknown as typeof fetch;
const bridgeDown = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;

describe('resolveSessionViewer', () => {
  it('prefers the signed-in app session over the env var', async () => {
    const r = await resolveSessionViewer({
      env: { SPACES_VIEWER_ID: 'someone-else@example.com' },
      fetchImpl: bridgeAnswering('robb@onereach.com'),
    });
    expect(r).toEqual({ viewerId: 'robb@onereach.com', source: 'app-session' });
  });

  it('falls back to env — loudly — when the app is signed out or not running', async () => {
    const logs: string[] = [];
    const signedOut = await resolveSessionViewer({
      env: { SPACES_VIEWER_ID: 'dev@example.com' },
      fetchImpl: bridgeAnswering(null),
      log: (m) => logs.push(m),
    });
    expect(signedOut).toEqual({ viewerId: 'dev@example.com', source: 'env' });
    expect(logs.some((m) => /WARNING/.test(m))).toBe(true);

    const down = await resolveSessionViewer({ env: { LOCAL_API_VIEWER_ID: 'x@y.z' }, fetchImpl: bridgeDown });
    expect(down.source).toBe('env');
  });

  it('fails closed with nothing to vouch for the caller', async () => {
    await expect(resolveSessionViewer({ env: {}, fetchImpl: bridgeDown })).rejects.toThrow(/No viewer identity/);
    await expect(resolveSessionViewer({ env: { SPACES_VIEWER_ID: '   ' }, fetchImpl: bridgeAnswering(null) })).rejects.toThrow(/No viewer identity/);
  });

  it('a hung bridge cannot stall startup (deadline)', async () => {
    const hung = ((_u: string, init?: { signal?: AbortSignal }) =>
      new Promise((_, rej) => init?.signal?.addEventListener('abort', () => rej(new Error('aborted'))))) as unknown as typeof fetch;
    const started = Date.now();
    const r = await resolveSessionViewer({ env: { SPACES_VIEWER_ID: 'dev@example.com' }, fetchImpl: hung, timeoutMs: 200 });
    expect(r.source).toBe('env');
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
