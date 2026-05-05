/**
 * Integration test for lite/auth against the in-memory KV server.
 *
 * Uses the REAL EdisonKVClient driven against startInMemoryKVServer
 * to verify the auth-sessions collection wire format and that
 * sign-in / sign-out persist + delete the right shape end-to-end.
 *
 * Electron is mocked because the auth store imports `session` from
 * electron at module load. The store's actual cookie capture is
 * driven by an injected fake session, identical to the unit tests.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

vi.mock('electron', () => ({
  session: {
    fromPartition: () => ({
      cookies: {
        on: () => undefined,
        off: () => undefined,
        get: async () => [],
        remove: async () => undefined,
      },
    }),
  },
  BrowserWindow: class {},
  shell: { openExternal: () => Promise.resolve() },
}));

import { AuthStore } from '../../auth/store.js';
import type { AuthWindowFactory } from '../../auth/store.js';
import type { AuthWindowHandle } from '../../auth/window.js';
// Import the in-memory KV server directly -- the harness/index.js
// barrel re-exports launch.ts (which loads @playwright/test) and
// breaks vi.mock('electron').
import {
  startInMemoryKVServer,
  type InMemoryKVServer,
} from '../harness/mocks/in-memory-kv-server.js';
import { EdisonKVClient } from '../../kv/client.js';

const SAMPLE_ACCOUNT_ID = '05bd3c92-5d3c-4dc5-a95d-0c584695cea4';
const SAMPLE_EMAIL = 'alice@example.com';
const SAMPLE_TOKEN = 'eyJhbGciOiJIUzI1NiJ9.SAMPLE.signature';

interface FakeCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expirationDate?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'unspecified' | 'no_restriction' | 'lax' | 'strict';
}

class FakeCookieJar {
  readonly listeners: Array<(event: object, cookie: FakeCookie, cause: string, removed: boolean) => void> = [];
  /** Seeded cookies returned from get() -- mirrors the partition cookie jar. */
  readonly seeded: FakeCookie[] = [];
  on(_e: string, l: (event: object, cookie: FakeCookie, cause: string, removed: boolean) => void): void {
    this.listeners.push(l);
  }
  off(_e: string, l: (event: object, cookie: FakeCookie, cause: string, removed: boolean) => void): void {
    const i = this.listeners.indexOf(l);
    if (i >= 0) this.listeners.splice(i, 1);
  }
  async get(filter?: { domain?: string; name?: string }): Promise<FakeCookie[]> {
    return this.seeded.filter((c) => {
      if (filter?.domain !== undefined && c.domain.replace(/^\./, '') !== filter.domain) return false;
      if (filter?.name !== undefined && c.name !== filter.name) return false;
      return true;
    });
  }
  async remove(): Promise<void> {
    return undefined;
  }
  emit(c: FakeCookie): void {
    for (const l of [...this.listeners]) l({}, c, 'explicit', false);
  }
  seed(c: FakeCookie): void {
    this.seeded.push(c);
  }
}

class FakeSession {
  readonly cookies = new FakeCookieJar();
}

function multCookie(): FakeCookie {
  return {
    name: 'mult',
    value: SAMPLE_TOKEN,
    domain: '.edison.api.onereach.ai',
    path: '/',
    expirationDate: Math.floor(Date.now() / 1000) + 3600,
    httpOnly: true,
    secure: true,
  };
}

function orCookie(payload: { accountId: string; email?: string }): FakeCookie {
  return {
    name: 'or',
    value: encodeURIComponent(JSON.stringify(payload)),
    domain: '.edison.onereach.ai',
    path: '/',
    expirationDate: Math.floor(Date.now() / 1000) + 3600,
    httpOnly: false,
    secure: true,
  };
}

function makeHandle(url: string): AuthWindowHandle {
  return {
    partition: 'persist:lite-auth-edison',
    lastUrl: url,
    close: () => undefined,
    _firstLoadFired: false,
    _firstLoadCallback: null,
    _closedCallback: null,
  };
}

let server: InMemoryKVServer;

beforeAll(async () => {
  server = await startInMemoryKVServer();
});

afterAll(async () => {
  await server.stop();
});

beforeEach(() => {
  server.reset();
});

describe('auth integration -- KV wire format', () => {
  it('signIn persists a valid AuthSession to the lite-auth-sessions collection over real HTTP', async () => {
    const session = new FakeSession();
    const handle = makeHandle('https://studio.edison.onereach.ai/?accountId=' + SAMPLE_ACCOUNT_ID);
    const factory: AuthWindowFactory = { create: () => handle };

    const realKv = new EdisonKVClient({
      url: server.url + '/keyvalue',
    });

    const store = new AuthStore({
      kvApi: realKv,
      sessionFromPartition: () => session as unknown as Electron.Session,
      windowFactory: factory,
    });

    const promise = store.signIn('edison');

    // Emit cookies; wait for capture coordinator to flush.
    session.cookies.emit({
      name: 'mult',
      value: SAMPLE_TOKEN,
      domain: '.edison.api.onereach.ai',
      path: '/',
      expirationDate: Math.floor(Date.now() / 1000) + 3600,
      httpOnly: true,
      secure: true,
    });
    session.cookies.emit({
      name: 'or',
      value: encodeURIComponent(JSON.stringify({ accountId: SAMPLE_ACCOUNT_ID, email: SAMPLE_EMAIL })),
      domain: '.edison.onereach.ai',
      path: '/',
      httpOnly: false,
      secure: true,
    });

    const result = await promise;

    // The KV server received exactly one PUT to lite-auth-sessions.
    const requests = server.getRequests();
    const puts = requests.filter((r) => r.method === 'PUT');
    expect(puts.length).toBe(1);
    expect(puts[0]?.collection).toBe('lite-auth-sessions');
    expect(puts[0]?.key).toBe('edison:' + SAMPLE_ACCOUNT_ID);

    // The stored value matches the AuthSession shape.
    const stored = server.store.get('lite-auth-sessions::edison:' + SAMPLE_ACCOUNT_ID) as Record<string, unknown>;
    expect(stored).toMatchObject({
      environment: 'edison',
      accountId: SAMPLE_ACCOUNT_ID,
      email: SAMPLE_EMAIL,
    });
    expect(typeof stored['capturedAt']).toBe('number');
    expect(typeof stored['expiresAt']).toBe('number');

    // The raw token is in main-process memory, NEVER in KV.
    const storedJson = JSON.stringify(stored);
    expect(storedJson).not.toContain(SAMPLE_TOKEN);

    // The store's API returns the same shape.
    expect(result).toMatchObject({
      environment: 'edison',
      accountId: SAMPLE_ACCOUNT_ID,
      email: SAMPLE_EMAIL,
    });
  });

  it('signOut deletes the KV record over real HTTP', async () => {
    const session = new FakeSession();
    const handle = makeHandle('https://studio.edison.onereach.ai/?accountId=' + SAMPLE_ACCOUNT_ID);
    const factory: AuthWindowFactory = { create: () => handle };
    const realKv = new EdisonKVClient({ url: server.url + '/keyvalue' });
    const store = new AuthStore({
      kvApi: realKv,
      sessionFromPartition: () => session as unknown as Electron.Session,
      windowFactory: factory,
    });

    // Sign in first.
    const p = store.signIn('edison');
    session.cookies.emit({
      name: 'mult',
      value: SAMPLE_TOKEN,
      domain: '.edison.api.onereach.ai',
      path: '/',
      expirationDate: Math.floor(Date.now() / 1000) + 3600,
    });
    session.cookies.emit({
      name: 'or',
      value: encodeURIComponent(JSON.stringify({ accountId: SAMPLE_ACCOUNT_ID, email: SAMPLE_EMAIL })),
      domain: '.edison.onereach.ai',
      path: '/',
    });
    await p;

    expect(server.store.has('lite-auth-sessions::edison:' + SAMPLE_ACCOUNT_ID)).toBe(true);

    await store.signOut('edison');

    // Server received a DELETE for the right key.
    const deletes = server.getRequests().filter((r) => r.method === 'DELETE');
    expect(deletes.length).toBe(1);
    expect(deletes[0]?.collection).toBe('lite-auth-sessions');
    expect(deletes[0]?.key).toBe('edison:' + SAMPLE_ACCOUNT_ID);
    expect(server.store.has('lite-auth-sessions::edison:' + SAMPLE_ACCOUNT_ID)).toBe(false);
  });

  it('hydrate loads a previously-persisted session from THIS install\'s partition cookies', async () => {
    // Per the 2026-05-05 multi-user leak fix, hydrate now reads ONLY
    // from the persistent partition cookie jar -- not from KV. The KV
    // namespace is anonymous and globally shared, so trusting it on
    // boot loaded every other Lite user's session.
    const realKv = new EdisonKVClient({ url: server.url + '/keyvalue' });
    const session = new FakeSession();
    session.cookies.seed(multCookie());
    session.cookies.seed(orCookie({ accountId: SAMPLE_ACCOUNT_ID, email: SAMPLE_EMAIL }));

    const store = new AuthStore({
      kvApi: realKv,
      sessionFromPartition: () => session as unknown as Electron.Session,
      windowFactory: { create: () => makeHandle('https://studio.edison.onereach.ai/') },
    });

    expect(store.getSession('edison')).toBeNull(); // not hydrated yet

    await store.hydrate();

    const s = store.getSession('edison');
    expect(s).not.toBeNull();
    expect(s?.accountId).toBe(SAMPLE_ACCOUNT_ID);
    expect(s?.email).toBe(SAMPLE_EMAIL);
    expect(store.hasValidSession('edison')).toBe(true);
    // Token IS rehydrated now because the partition has cookies.
    expect(store.getToken('edison')).toBe(SAMPLE_TOKEN);
  });

  it('hydrate notifies session-changed subscribers for each rehydrated session', async () => {
    // Regression: the placeholder window subscribes to session-changed
    // AFTER initAuth has already started hydrating. Without this notify,
    // the placeholder shows the "Sign in" button even when partition
    // cookies hold a valid session, until the user clicks something.
    const realKv = new EdisonKVClient({ url: server.url + '/keyvalue' });
    const session = new FakeSession();
    session.cookies.seed(multCookie());
    session.cookies.seed(orCookie({ accountId: SAMPLE_ACCOUNT_ID, email: SAMPLE_EMAIL }));

    const store = new AuthStore({
      kvApi: realKv,
      sessionFromPartition: () => session as unknown as Electron.Session,
      windowFactory: { create: () => makeHandle('https://studio.edison.onereach.ai/') },
    });

    const events: Array<{ env: string; session: { accountId?: string } | null }> = [];
    store.onSessionChanged((env, session) => {
      events.push({ env, session: session === null ? null : { accountId: session.accountId } });
    });

    await store.hydrate();

    expect(events).toEqual([
      { env: 'edison', session: { accountId: SAMPLE_ACCOUNT_ID } },
    ]);

    // A second hydrate must not re-notify -- the session is already
    // in memory, so the rehydrated count is zero.
    await store.hydrate();
    expect(events).toEqual([
      { env: 'edison', session: { accountId: SAMPLE_ACCOUNT_ID } },
    ]);
  });

  it('hydrate does NOT touch KV (post-2026-05-05 multi-user leak fix)', async () => {
    // Hydrate must never read from the global KV namespace -- doing so
    // historically loaded other users' sessions into this install. We
    // verify by counting POSTs to the KV server before/after multiple
    // concurrent hydrates: it should stay at zero.
    const realKv = new EdisonKVClient({ url: server.url + '/keyvalue' });

    const store = new AuthStore({
      kvApi: realKv,
      sessionFromPartition: () => new FakeSession() as unknown as Electron.Session,
      windowFactory: { create: () => makeHandle('https://studio.edison.onereach.ai/') },
    });

    const beforePosts = server.getRequests().filter((r) => r.method === 'POST').length;
    const beforeGets = server.getRequests().filter((r) => r.method === 'GET').length;
    await Promise.all([store.hydrate(), store.hydrate(), store.hydrate()]);
    const afterPosts = server.getRequests().filter((r) => r.method === 'POST').length;
    const afterGets = server.getRequests().filter((r) => r.method === 'GET').length;

    expect(afterPosts - beforePosts).toBe(0);
    expect(afterGets - beforeGets).toBe(0);
  });
});
