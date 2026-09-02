/**
 * Named queries are tied to the signed-in user (2026-09-01 identity
 * audit). The graph proxy has no per-user auth, so the QUERY_NAMED IPC
 * must refuse a signed-out renderer outright — before this it would run
 * the org catalog for anyone.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

type Handler = (...args: unknown[]) => unknown;
const registered = new Map<string, Handler>();
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: Handler) => { registered.set(channel, fn); },
    on: (channel: string, fn: Handler) => { registered.set(channel, fn); },
    removeHandler: () => undefined,
  },
  app: { getPath: () => '/tmp', isPackaged: false },
  BrowserWindow: class { static getAllWindows(): unknown[] { return []; } },
}));

import { initNeon, NEON_IPC } from '../../neon/main.js';
import { registerNamedQuery } from '../../neon/named-queries.js';
import { _setNeonApiForTesting, _resetNeonApiForTesting } from '../../neon/api.js';
import { _setAuthApiForTesting, _resetAuthApiForTesting, type AuthApi } from '../../auth/api.js';

const querySpy = vi.fn(async () => [{ ok: 1 }]);
let session: object | null = null;

beforeAll(() => {
  _setNeonApiForTesting({ query: querySpy } as never);
  _setAuthApiForTesting({ getSession: () => session, onSessionChanged: () => () => undefined } as unknown as AuthApi);
  registerNamedQuery('audit.probe', 'RETURN 1 AS ok');
  initNeon();
});
afterAll(() => { _resetNeonApiForTesting(); _resetAuthApiForTesting(); });

async function invoke(): Promise<{ threw: string | null; value: unknown }> {
  const h = registered.get(NEON_IPC.QUERY_NAMED);
  if (!h) throw new Error('QUERY_NAMED not registered');
  try { return { threw: null, value: await h({}, { name: 'audit.probe', parameters: {} }) }; }
  catch (e) { return { threw: (e as Error).message, value: undefined }; }
}

describe('QUERY_NAMED identity gate', () => {
  it('refuses when signed out and never reaches the graph', async () => {
    session = null;
    querySpy.mockClear();
    const r = await invoke();
    const text = r.threw ?? JSON.stringify(r.value);
    expect(text).toMatch(/NEON_UNAUTHENTICATED|Sign in/);
    expect(querySpy).not.toHaveBeenCalled();
  });

  it('runs when a session exists', async () => {
    session = { accountId: 'acct', email: 'robb@onereach.com' };
    querySpy.mockClear();
    const r = await invoke();
    expect(r.threw).toBeNull();
    expect(querySpy).toHaveBeenCalledTimes(1);
  });
});
