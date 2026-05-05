/**
 * AuthStore behavior tests.
 *
 * Drives the store directly with:
 *   - FakeKV (in-memory KVApi)
 *   - A fake Electron Session that emits cookie events on demand
 *   - A fake AuthWindowFactory that records create / close calls
 *
 * Coverage:
 *   - Happy path: cookies arrive -> KV write -> resolve
 *   - User cancel: window closed -> AUTH_CANCELLED
 *   - Timeout: partial cookies -> AUTH_TIMEOUT, window closed
 *   - KV failure: cookies arrive -> KV rejects -> window closed -> AUTH_KV_FAILED
 *   - Invalid `or` cookie: AUTH_INVALID_COOKIE
 *   - Existing-session probe: cookies already present -> immediate capture
 *   - In-flight coalescing: concurrent signIn returns the same promise
 *   - Unsupported env: AUTH_UNSUPPORTED_ENV
 *   - signOut: clears in-memory state + removes cookies + deletes KV record
 *   - Token redaction: captured token never appears in any log call
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock electron BEFORE importing the store. The store has a static
// `import { session } from 'electron'`; we never use that path because
// the test injects `sessionFromPartition` and `windowFactory` via
// AuthStoreConfig, but the import has to resolve.
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

import { AuthStore, AUTH_ERROR_CODES, AuthError, decodeOrCookie } from '../../auth/store.js';
import type { AuthWindowFactory } from '../../auth/store.js';
import type { AuthWindowHandle } from '../../auth/window.js';
// Import FakeKV directly -- the harness/index.js barrel re-exports
// launch.ts (which loads @playwright/test) and breaks vi.mock('electron').
import { FakeKV } from '../harness/mocks/fake-kv.js';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface FakeCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'unspecified' | 'no_restriction' | 'lax' | 'strict';
  expirationDate?: number;
}

class FakeCookieJar {
  readonly cookies: FakeCookie[] = [];
  readonly listeners: Array<(event: object, cookie: FakeCookie, cause: string, removed: boolean) => void> = [];
  readonly removeCalls: Array<{ url: string; name: string }> = [];
  readonly setCalls: Array<{
    url: string;
    name: string;
    value: string;
    domain: string;
    httpOnly?: boolean;
    secure?: boolean;
    sameSite?: 'unspecified' | 'no_restriction' | 'lax' | 'strict';
  }> = [];
  flushCallCount = 0;

  on(event: string, listener: (event: object, cookie: FakeCookie, cause: string, removed: boolean) => void): void {
    if (event === 'changed') this.listeners.push(listener);
  }
  off(event: string, listener: (event: object, cookie: FakeCookie, cause: string, removed: boolean) => void): void {
    if (event !== 'changed') return;
    const i = this.listeners.indexOf(listener);
    if (i >= 0) this.listeners.splice(i, 1);
  }
  // Used by the existing-session probe.
  async get(filter: { domain?: string; name?: string }): Promise<FakeCookie[]> {
    return this.cookies.filter((c) => {
      if (filter.name !== undefined && c.name !== filter.name) return false;
      if (filter.domain !== undefined) {
        const d = filter.domain.replace(/^\./, '');
        const cd = c.domain.replace(/^\./, '');
        if (cd !== d && !cd.endsWith('.' + d)) return false;
      }
      return true;
    });
  }
  async remove(url: string, name: string): Promise<void> {
    this.removeCalls.push({ url, name });
    for (let i = this.cookies.length - 1; i >= 0; i--) {
      const c = this.cookies[i];
      if (c !== undefined && c.name === name) this.cookies.splice(i, 1);
    }
  }
  async set(details: {
    url: string;
    name: string;
    value: string;
    domain?: string;
    path?: string;
    secure?: boolean;
    httpOnly?: boolean;
    sameSite?: 'unspecified' | 'no_restriction' | 'lax' | 'strict';
    expirationDate?: number;
  }): Promise<void> {
    this.setCalls.push({
      url: details.url,
      name: details.name,
      value: details.value,
      domain: details.domain ?? '',
      ...(details.httpOnly !== undefined ? { httpOnly: details.httpOnly } : {}),
      ...(details.secure !== undefined ? { secure: details.secure } : {}),
      ...(details.sameSite !== undefined ? { sameSite: details.sameSite } : {}),
    });
    // Mirror real behavior: replace any existing cookie with the same
    // name+domain so subsequent get() reflects the write.
    const idx = this.cookies.findIndex(
      (c) => c.name === details.name && c.domain === (details.domain ?? c.domain)
    );
    const cookie: FakeCookie = {
      name: details.name,
      value: details.value,
      domain: details.domain ?? '',
      path: details.path ?? '/',
      ...(details.httpOnly !== undefined ? { httpOnly: details.httpOnly } : {}),
      ...(details.secure !== undefined ? { secure: details.secure } : {}),
      ...(details.sameSite !== undefined ? { sameSite: details.sameSite } : {}),
      ...(details.expirationDate !== undefined ? { expirationDate: details.expirationDate } : {}),
    };
    if (idx >= 0) this.cookies[idx] = cookie;
    else this.cookies.push(cookie);
  }
  async flushStore(): Promise<void> {
    this.flushCallCount += 1;
  }

  // Test helper: emit a cookie change event.
  emit(cookie: FakeCookie, removed = false): void {
    if (!removed) this.cookies.push(cookie);
    for (const l of [...this.listeners]) {
      l({}, cookie, 'explicit', removed);
    }
  }
  // Test helper: seed an already-present cookie (does NOT emit).
  seed(cookie: FakeCookie): void {
    this.cookies.push(cookie);
  }
}

class FakeSession {
  readonly cookies = new FakeCookieJar();
}

class FakeWindowFactoryRecorder implements AuthWindowFactory {
  readonly created: AuthWindowHandle[] = [];
  readonly factory: () => AuthWindowHandle;

  constructor(factory: () => AuthWindowHandle) {
    this.factory = factory;
  }
  create(): AuthWindowHandle {
    const handle = this.factory();
    this.created.push(handle);
    return handle;
  }
}

function makeFakeWindow(opts: { initialUrl?: string } = {}): AuthWindowHandle & {
  fireFirstLoad: () => void;
  fireClosed: () => void;
  closed: boolean;
} {
  let closed = false;
  const handle: AuthWindowHandle & {
    fireFirstLoad: () => void;
    fireClosed: () => void;
    closed: boolean;
  } = {
    partition: 'persist:lite-auth-edison',
    ...(opts.initialUrl !== undefined ? { lastUrl: opts.initialUrl } : {}),
    close: (): void => {
      closed = true;
      handle.closed = true;
      // Mimic the real window: closing fires the closed callback once.
      const cb = handle._closedCallback;
      if (cb !== null) {
        handle._closedCallback = null;
        try {
          cb();
        } catch {
          // ignore
        }
      }
    },
    closed,
    _firstLoadFired: false,
    _firstLoadCallback: null,
    _closedCallback: null,
    fireFirstLoad: (): void => {
      handle._firstLoadFired = true;
      const cb = handle._firstLoadCallback;
      if (cb !== null) {
        handle._firstLoadCallback = null;
        cb();
      }
    },
    fireClosed: (): void => {
      const cb = handle._closedCallback;
      if (cb !== null) {
        handle._closedCallback = null;
        cb();
      }
    },
  };
  return handle;
}

const SAMPLE_TOKEN = 'eyJhbGciOiJIUzI1NiJ9.SAMPLE_MULT_TOKEN_VALUE.signature';
const SAMPLE_ACCOUNT_ID = '05bd3c92-5d3c-4dc5-a95d-0c584695cea4';
const SAMPLE_EMAIL = 'alice@example.com';

function buildOrCookieValue(payload: Record<string, unknown>): string {
  return encodeURIComponent(JSON.stringify(payload));
}

function multCookie(overrides: Partial<FakeCookie> = {}): FakeCookie {
  return {
    name: 'mult',
    value: SAMPLE_TOKEN,
    domain: '.edison.api.onereach.ai',
    path: '/',
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    expirationDate: Math.floor(Date.now() / 1000) + 3600,
    ...overrides,
  };
}

function orCookie(payload?: Record<string, unknown>, overrides: Partial<FakeCookie> = {}): FakeCookie {
  const data = payload ?? { accountId: SAMPLE_ACCOUNT_ID, email: SAMPLE_EMAIL };
  return {
    name: 'or',
    value: buildOrCookieValue(data),
    domain: '.edison.onereach.ai',
    path: '/',
    httpOnly: false,
    secure: true,
    sameSite: 'lax',
    ...overrides,
  };
}

interface LoggedCall {
  level: 'info' | 'warn' | 'error';
  message: string;
  data?: unknown;
}

function makeRecordingLogger(): { calls: LoggedCall[]; logger: (level: 'info' | 'warn' | 'error', m: string, d?: unknown) => void } {
  const calls: LoggedCall[] = [];
  return {
    calls,
    logger: (level, message, data) => {
      calls.push({ level, message, data });
    },
  };
}

function buildStore(opts: {
  kv?: FakeKV;
  session?: FakeSession;
  windowHandle: ReturnType<typeof makeFakeWindow>;
  logger?: ReturnType<typeof makeRecordingLogger>['logger'];
}): { store: AuthStore; kv: FakeKV; session: FakeSession; windowHandle: ReturnType<typeof makeFakeWindow> } {
  const kv = opts.kv ?? new FakeKV();
  const session = opts.session ?? new FakeSession();
  const factory = new FakeWindowFactoryRecorder(() => opts.windowHandle);
  const store = new AuthStore({
    kvApi: kv,
    sessionFromPartition: () => session as unknown as Electron.Session,
    windowFactory: factory,
    ...(opts.logger !== undefined ? { logger: opts.logger } : {}),
  });
  return { store, kv, session, windowHandle: opts.windowHandle };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AuthStore.signIn -- happy path', () => {
  it('captures mult + or, persists to KV, resolves with session, captures token', async () => {
    const handle = makeFakeWindow({ initialUrl: 'https://studio.edison.onereach.ai/?accountId=' + SAMPLE_ACCOUNT_ID });
    const { store, kv, session, windowHandle } = buildStore({ windowHandle: handle });

    const promise = store.signIn('edison');

    // Listener attached during signIn -- emit cookies now.
    session.cookies.emit(multCookie());
    session.cookies.emit(orCookie());

    const result = await promise;
    expect(result.environment).toBe('edison');
    expect(result.accountId).toBe(SAMPLE_ACCOUNT_ID);
    expect(result.email).toBe(SAMPLE_EMAIL);
    expect(typeof result.capturedAt).toBe('number');
    expect(typeof result.expiresAt).toBe('number');

    // KV got the right shape under the right key.
    expect(kv.sets).toHaveLength(1);
    expect(kv.sets[0]?.collection).toBe('lite-auth-sessions');
    expect(kv.sets[0]?.key).toBe('edison:' + SAMPLE_ACCOUNT_ID);

    // Token is captured in main-process map; getToken returns it.
    expect(store.getToken('edison')).toBe(SAMPLE_TOKEN);
    // getSession matches the resolved session.
    expect(store.getSession('edison')).toEqual(result);
    expect(store.hasValidSession('edison')).toBe(true);

    // getTokenBundle exposes both raw cookie values + capturedAt.
    const bundle = store.getTokenBundle('edison');
    expect(bundle).not.toBeNull();
    expect(bundle?.multToken).toBe(SAMPLE_TOKEN);
    expect(typeof bundle?.accountToken).toBe('string');
    expect(bundle?.accountToken.length).toBeGreaterThan(0);
    expect(bundle?.capturedAt).toBe(result.capturedAt);

    // Window closed.
    expect(windowHandle.closed).toBe(true);
  });

  it('getTokenBundle returns null before sign-in and after sign-out', async () => {
    const handle = makeFakeWindow({
      initialUrl: 'https://studio.edison.onereach.ai/?accountId=' + SAMPLE_ACCOUNT_ID,
    });
    const { store, session } = buildStore({ windowHandle: handle });

    // No sign-in yet -> null.
    expect(store.getTokenBundle('edison')).toBeNull();

    const p = store.signIn('edison');
    session.cookies.emit(multCookie());
    session.cookies.emit(orCookie());
    await p;
    expect(store.getTokenBundle('edison')).not.toBeNull();

    // Sign-out clears the bundle along with the session.
    await store.signOut('edison');
    expect(store.getTokenBundle('edison')).toBeNull();
  });

  it('falls back to URL accountId if or cookie payload omits it', async () => {
    const handle = makeFakeWindow({
      initialUrl: 'https://studio.edison.onereach.ai/?accountId=' + SAMPLE_ACCOUNT_ID + '&foo=bar',
    });
    const { store, session } = buildStore({ windowHandle: handle });

    const promise = store.signIn('edison');
    session.cookies.emit(multCookie());
    session.cookies.emit(orCookie({ email: SAMPLE_EMAIL })); // no accountId in payload

    const result = await promise;
    expect(result.accountId).toBe(SAMPLE_ACCOUNT_ID);
    expect(result.email).toBe(SAMPLE_EMAIL);
  });

  it('notifies onSessionChanged subscribers', async () => {
    const handle = makeFakeWindow({ initialUrl: 'https://studio.edison.onereach.ai/?accountId=' + SAMPLE_ACCOUNT_ID });
    const { store, session } = buildStore({ windowHandle: handle });

    const events: Array<{ env: string; signedIn: boolean }> = [];
    store.onSessionChanged((env, s) => {
      events.push({ env, signedIn: s !== null });
    });

    const promise = store.signIn('edison');
    session.cookies.emit(multCookie());
    session.cookies.emit(orCookie());
    await promise;

    expect(events).toEqual([{ env: 'edison', signedIn: true }]);
  });
});

describe('AuthStore.signIn -- failure modes', () => {
  it('rejects AUTH_CANCELLED when the user closes the window before cookies arrive', async () => {
    const handle = makeFakeWindow();
    const { store, windowHandle } = buildStore({ windowHandle: handle });

    const promise = store.signIn('edison');
    windowHandle.fireClosed();

    await expect(promise).rejects.toBeInstanceOf(AuthError);
    await expect(promise).rejects.toMatchObject({ code: AUTH_ERROR_CODES.CANCELLED });
  });

  it('rejects AUTH_TIMEOUT when only one cookie arrives before the timeout', async () => {
    const handle = makeFakeWindow();
    const { store, session, windowHandle } = buildStore({ windowHandle: handle });

    const promise = store.signIn('edison', { timeoutMs: 50 });
    session.cookies.emit(multCookie()); // only mult, no or
    await expect(promise).rejects.toMatchObject({ code: AUTH_ERROR_CODES.TIMEOUT });
    expect(windowHandle.closed).toBe(true);
  });

  it('rejects AUTH_KV_FAILED, closes window, when KV write fails', async () => {
    const handle = makeFakeWindow({ initialUrl: 'https://studio.edison.onereach.ai/?accountId=' + SAMPLE_ACCOUNT_ID });
    const kv = new FakeKV();
    kv.failSet = true;
    const { store, session, windowHandle } = buildStore({ kv, windowHandle: handle });

    const promise = store.signIn('edison');
    session.cookies.emit(multCookie());
    session.cookies.emit(orCookie());

    await expect(promise).rejects.toMatchObject({ code: AUTH_ERROR_CODES.KV_FAILED });
    expect(windowHandle.closed).toBe(true);
    // No session was persisted in memory.
    expect(store.getSession('edison')).toBeNull();
    expect(store.getToken('edison')).toBeNull();
  });

  it('rejects AUTH_INVALID_COOKIE when the or cookie value is not URL-encoded JSON', async () => {
    const handle = makeFakeWindow({ initialUrl: 'https://studio.edison.onereach.ai/?accountId=' + SAMPLE_ACCOUNT_ID });
    const { store, session, windowHandle } = buildStore({ windowHandle: handle });

    const promise = store.signIn('edison');
    session.cookies.emit(multCookie());
    session.cookies.emit(orCookie(undefined, { value: '%E0%A4%A' })); // malformed URL-encoding

    await expect(promise).rejects.toMatchObject({ code: AUTH_ERROR_CODES.INVALID_COOKIE });
    expect(windowHandle.closed).toBe(true);
  });

  it('rejects AUTH_INVALID_COOKIE when there is no accountId anywhere', async () => {
    const handle = makeFakeWindow({ initialUrl: 'https://studio.edison.onereach.ai/' }); // no accountId in URL
    const { store, session } = buildStore({ windowHandle: handle });

    const promise = store.signIn('edison');
    session.cookies.emit(multCookie());
    session.cookies.emit(orCookie({ email: SAMPLE_EMAIL })); // no accountId in payload either

    await expect(promise).rejects.toMatchObject({ code: AUTH_ERROR_CODES.INVALID_COOKIE });
  });

  it('rejects AUTH_UNSUPPORTED_ENV for environments not in SUPPORTED_ENVIRONMENTS', async () => {
    const handle = makeFakeWindow();
    const { store } = buildStore({ windowHandle: handle });

    await expect(store.signIn('staging')).rejects.toMatchObject({ code: AUTH_ERROR_CODES.UNSUPPORTED_ENV });
    await expect(store.signIn('production')).rejects.toMatchObject({ code: AUTH_ERROR_CODES.UNSUPPORTED_ENV });
    await expect(store.signIn('dev')).rejects.toMatchObject({ code: AUTH_ERROR_CODES.UNSUPPORTED_ENV });
  });

  it('ignores cookies on non-OneReach domains (subdomain attack defense)', async () => {
    const handle = makeFakeWindow({ initialUrl: 'https://studio.edison.onereach.ai/?accountId=' + SAMPLE_ACCOUNT_ID });
    const { store, session, windowHandle } = buildStore({ windowHandle: handle });

    const promise = store.signIn('edison', { timeoutMs: 50 });
    // Attacker sets a 'mult' cookie on a non-OneReach domain.
    session.cookies.emit(multCookie({ domain: '.attacker.com' }));
    session.cookies.emit(orCookie(undefined, { domain: '.attacker.com' }));

    // Should still time out because the legit OneReach cookies never arrived.
    await expect(promise).rejects.toMatchObject({ code: AUTH_ERROR_CODES.TIMEOUT });
    expect(windowHandle.closed).toBe(true);
  });
});

describe('AuthStore.signIn -- in-flight coalescing', () => {
  it('returns the same promise for concurrent signIn calls on the same env', async () => {
    const handle = makeFakeWindow({ initialUrl: 'https://studio.edison.onereach.ai/?accountId=' + SAMPLE_ACCOUNT_ID });
    let createCount = 0;
    const factory = new FakeWindowFactoryRecorder(() => {
      createCount++;
      return handle;
    });
    const session = new FakeSession();
    const store = new AuthStore({
      kvApi: new FakeKV(),
      sessionFromPartition: () => session as unknown as Electron.Session,
      windowFactory: factory,
    });

    const p1 = store.signIn('edison');
    const p2 = store.signIn('edison');
    expect(p1).toBe(p2);
    expect(createCount).toBe(1); // factory called only once

    session.cookies.emit(multCookie());
    session.cookies.emit(orCookie());
    const r1 = await p1;
    const r2 = await p2;
    expect(r1).toBe(r2);
  });

  it('after a signIn settles, a fresh signIn opens a new window', async () => {
    const session = new FakeSession();
    const kv = new FakeKV();
    let createCount = 0;
    const handles: ReturnType<typeof makeFakeWindow>[] = [];
    const factory: AuthWindowFactory = {
      create: () => {
        createCount++;
        const h = makeFakeWindow({ initialUrl: 'https://studio.edison.onereach.ai/?accountId=' + SAMPLE_ACCOUNT_ID });
        handles.push(h);
        return h;
      },
    };
    const store = new AuthStore({
      kvApi: kv,
      sessionFromPartition: () => session as unknown as Electron.Session,
      windowFactory: factory,
    });

    const p1 = store.signIn('edison');
    session.cookies.emit(multCookie());
    session.cookies.emit(orCookie());
    await p1;

    const p2 = store.signIn('edison');
    session.cookies.emit(multCookie());
    session.cookies.emit(orCookie());
    await p2;
    expect(createCount).toBe(2);
  });
});

describe('AuthStore.signIn -- existing-session probe', () => {
  it('captures cookies that were already set in the partition', async () => {
    const handle = makeFakeWindow({ initialUrl: 'https://studio.edison.onereach.ai/?accountId=' + SAMPLE_ACCOUNT_ID });
    const session = new FakeSession();

    // Seed cookies BEFORE the user sees the window (simulates "already signed in").
    session.cookies.seed(multCookie());
    session.cookies.seed(orCookie());

    const store = new AuthStore({
      kvApi: new FakeKV(),
      sessionFromPartition: () => session as unknown as Electron.Session,
      windowFactory: { create: () => handle },
    });

    const promise = store.signIn('edison');
    // Trigger first-load: store probes for existing cookies.
    handle.fireFirstLoad();

    const result = await promise;
    expect(result.accountId).toBe(SAMPLE_ACCOUNT_ID);
    expect(result.email).toBe(SAMPLE_EMAIL);
  });
});

describe('AuthStore.signOut', () => {
  it('clears in-memory session, removes mult/or cookies, deletes the KV record', async () => {
    const handle = makeFakeWindow({ initialUrl: 'https://studio.edison.onereach.ai/?accountId=' + SAMPLE_ACCOUNT_ID });
    const { store, kv, session } = buildStore({ windowHandle: handle });

    // Sign in first.
    const promise = store.signIn('edison');
    session.cookies.emit(multCookie());
    session.cookies.emit(orCookie());
    await promise;
    expect(store.getSession('edison')).not.toBeNull();
    expect(store.getToken('edison')).toBe(SAMPLE_TOKEN);

    // Sign out.
    await store.signOut('edison');

    expect(store.getSession('edison')).toBeNull();
    expect(store.getToken('edison')).toBeNull();
    expect(store.hasValidSession('edison')).toBe(false);

    // Cookies removed for both domain suffixes, both names.
    const removed = session.cookies.removeCalls;
    const names = removed.map((r) => r.name);
    expect(names.filter((n) => n === 'mult').length).toBeGreaterThanOrEqual(2);
    expect(names.filter((n) => n === 'or').length).toBeGreaterThanOrEqual(2);

    // KV record deleted.
    expect(kv.deletes).toEqual([
      { collection: 'lite-auth-sessions', key: 'edison:' + SAMPLE_ACCOUNT_ID },
    ]);
  });

  it('signOut on an env with no session is a safe no-op', async () => {
    const handle = makeFakeWindow();
    const { store } = buildStore({ windowHandle: handle });
    await expect(store.signOut('edison')).resolves.toBeUndefined();
    expect(store.getSession('edison')).toBeNull();
  });

  it('notifies onSessionChanged subscribers with null on signOut', async () => {
    const handle = makeFakeWindow({ initialUrl: 'https://studio.edison.onereach.ai/?accountId=' + SAMPLE_ACCOUNT_ID });
    const { store, session } = buildStore({ windowHandle: handle });

    const events: Array<{ env: string; signedIn: boolean }> = [];
    store.onSessionChanged((env, s) => {
      events.push({ env, signedIn: s !== null });
    });

    const p = store.signIn('edison');
    session.cookies.emit(multCookie());
    session.cookies.emit(orCookie());
    await p;
    await store.signOut('edison');

    expect(events).toEqual([
      { env: 'edison', signedIn: true },
      { env: 'edison', signedIn: false },
    ]);
  });
});

describe('AuthStore.hasValidSession', () => {
  it('returns false when expiresAt is in the past', async () => {
    const handle = makeFakeWindow({ initialUrl: 'https://studio.edison.onereach.ai/?accountId=' + SAMPLE_ACCOUNT_ID });
    const { store, session } = buildStore({ windowHandle: handle });

    const promise = store.signIn('edison');
    // Expired 1 second ago.
    session.cookies.emit(multCookie({ expirationDate: Math.floor(Date.now() / 1000) - 1 }));
    session.cookies.emit(orCookie());
    await promise;

    expect(store.getSession('edison')).not.toBeNull();
    expect(store.hasValidSession('edison')).toBe(false);
  });

  it('returns true when expiresAt is in the future', async () => {
    const handle = makeFakeWindow({ initialUrl: 'https://studio.edison.onereach.ai/?accountId=' + SAMPLE_ACCOUNT_ID });
    const { store, session } = buildStore({ windowHandle: handle });

    const promise = store.signIn('edison');
    session.cookies.emit(multCookie());
    session.cookies.emit(orCookie());
    await promise;

    expect(store.hasValidSession('edison')).toBe(true);
  });
});

describe('AuthStore -- token redaction (CRITICAL)', () => {
  it('never logs the captured token value as a substring of any log call', async () => {
    const handle = makeFakeWindow({ initialUrl: 'https://studio.edison.onereach.ai/?accountId=' + SAMPLE_ACCOUNT_ID });
    const recorder = makeRecordingLogger();
    const { store, session } = buildStore({ windowHandle: handle, logger: recorder.logger });

    const promise = store.signIn('edison');
    session.cookies.emit(multCookie());
    session.cookies.emit(orCookie());
    await promise;
    await store.signOut('edison');

    // Walk every captured log call (message + serialized data) and
    // assert the token never appears.
    const violations: LoggedCall[] = [];
    for (const call of recorder.calls) {
      if (call.message.includes(SAMPLE_TOKEN)) {
        violations.push(call);
        continue;
      }
      const dataStr = call.data === undefined ? '' : JSON.stringify(call.data);
      if (dataStr.includes(SAMPLE_TOKEN)) {
        violations.push(call);
      }
    }
    expect(
      violations,
      'token value leaked into log output: ' +
        violations.map((v) => `${v.level}: ${v.message}`).join(' | ')
    ).toEqual([]);
  });

  it('never logs the or cookie URL-encoded JSON value as a substring', async () => {
    const handle = makeFakeWindow({ initialUrl: 'https://studio.edison.onereach.ai/?accountId=' + SAMPLE_ACCOUNT_ID });
    const recorder = makeRecordingLogger();
    const { store, session } = buildStore({ windowHandle: handle, logger: recorder.logger });

    const sensitiveOr = orCookie({ accountId: SAMPLE_ACCOUNT_ID, email: SAMPLE_EMAIL, secret: 'should-never-leak' });

    const promise = store.signIn('edison');
    session.cookies.emit(multCookie());
    session.cookies.emit(sensitiveOr);
    await promise;

    const violations: LoggedCall[] = [];
    for (const call of recorder.calls) {
      if (call.message.includes(sensitiveOr.value)) {
        violations.push(call);
        continue;
      }
      const dataStr = call.data === undefined ? '' : JSON.stringify(call.data);
      if (dataStr.includes('should-never-leak') || dataStr.includes(sensitiveOr.value)) {
        violations.push(call);
      }
    }
    expect(violations, 'or cookie raw value leaked into log output').toEqual([]);
  });

  it('logs cookie metadata (name, domain, valueLength, expirationDate) without the value', async () => {
    const handle = makeFakeWindow({ initialUrl: 'https://studio.edison.onereach.ai/?accountId=' + SAMPLE_ACCOUNT_ID });
    const recorder = makeRecordingLogger();
    const { store, session } = buildStore({ windowHandle: handle, logger: recorder.logger });

    const p = store.signIn('edison');
    session.cookies.emit(multCookie());
    session.cookies.emit(orCookie());
    await p;

    // Find at least one log call that recorded cookie metadata.
    const captured = recorder.calls.filter((c) => c.message.includes('cookie captured'));
    expect(captured.length).toBeGreaterThan(0);
    for (const c of captured) {
      const data = c.data as Record<string, unknown>;
      expect(typeof data['valueLength']).toBe('number');
      expect(typeof data['domain']).toBe('string');
      expect((data as { value?: unknown }).value).toBeUndefined();
    }
  });
});

describe('decodeOrCookie helper', () => {
  it('round-trips URL-encoded JSON', () => {
    const payload = { accountId: SAMPLE_ACCOUNT_ID, email: SAMPLE_EMAIL };
    const encoded = encodeURIComponent(JSON.stringify(payload));
    expect(decodeOrCookie(encoded)).toEqual(payload);
  });

  it('returns null for malformed URL-encoding', () => {
    expect(decodeOrCookie('%E0%A4%A')).toBeNull();
  });

  it('returns null when the decoded value is not JSON', () => {
    expect(decodeOrCookie(encodeURIComponent('not json'))).toBeNull();
  });

  it('returns null when the decoded value is a JSON array', () => {
    expect(decodeOrCookie(encodeURIComponent('[1,2,3]'))).toBeNull();
  });

  it('returns null when the decoded value is a JSON primitive', () => {
    expect(decodeOrCookie(encodeURIComponent('42'))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ADR-042: token rehydration + per-tab injection
// ---------------------------------------------------------------------------

describe('AuthStore.hydrate -- token rehydration from auth partition', () => {
  it('rehydrates the in-memory tokenBundle from a pre-existing mult cookie', async () => {
    const kv = new FakeKV();
    // Seed KV with the persisted AuthSession from a prior run.
    await kv.set('lite-auth-sessions', `edison:${SAMPLE_ACCOUNT_ID}`, {
      environment: 'edison',
      accountId: SAMPLE_ACCOUNT_ID,
      email: SAMPLE_EMAIL,
      capturedAt: Date.parse('2026-05-04T12:00:00.000Z'),
      expiresAt: Date.now() + 3600_000,
    });
    // Simulate Electron's persistent partition cookie jar -- the
    // mult/or cookies are still on disk from the prior session.
    const session = new FakeSession();
    session.cookies.seed(multCookie());
    session.cookies.seed(orCookie());
    const store = new AuthStore({
      kvApi: kv,
      sessionFromPartition: () => session as unknown as Electron.Session,
    });
    expect(store.getTokenBundle('edison')).toBeNull();

    await store.hydrate();

    const bundle = store.getTokenBundle('edison');
    expect(bundle).not.toBeNull();
    expect(bundle?.multToken).toBe(SAMPLE_TOKEN);
    expect(store.getToken('edison')).toBe(SAMPLE_TOKEN);
    // Session should also rehydrate.
    expect(store.getSession('edison')?.accountId).toBe(SAMPLE_ACCOUNT_ID);
  });

  it('leaves tokenBundle null when the auth partition has no mult cookie', async () => {
    const kv = new FakeKV();
    await kv.set('lite-auth-sessions', `edison:${SAMPLE_ACCOUNT_ID}`, {
      environment: 'edison',
      accountId: SAMPLE_ACCOUNT_ID,
      capturedAt: Date.now(),
    });
    const session = new FakeSession(); // empty cookie jar
    const store = new AuthStore({
      kvApi: kv,
      sessionFromPartition: () => session as unknown as Electron.Session,
    });

    await store.hydrate();

    expect(store.getSession('edison')?.accountId).toBe(SAMPLE_ACCOUNT_ID);
    expect(store.getTokenBundle('edison')).toBeNull();
  });
});

describe('AuthStore.injectTokenIntoPartition', () => {
  it('writes the captured mult AND or cookies to both UI and API domains', async () => {
    const kv = new FakeKV();
    const authSession = new FakeSession();
    authSession.cookies.seed(multCookie());
    authSession.cookies.seed(orCookie());
    const tabSession = new FakeSession();
    const store = new AuthStore({
      kvApi: kv,
      sessionFromPartition: (partition: string) =>
        (partition === 'persist:lite-auth-edison' ? authSession : tabSession) as unknown as Electron.Session,
    });
    // Seed an AuthSession + run hydrate so the bundle populates.
    await kv.set('lite-auth-sessions', `edison:${SAMPLE_ACCOUNT_ID}`, {
      environment: 'edison',
      accountId: SAMPLE_ACCOUNT_ID,
      capturedAt: Date.now(),
    });
    await store.hydrate();

    const result = await store.injectTokenIntoPartition('edison', 'persist:tab-test-1');

    expect(result.injected).toBe(true);
    // Both UI and API domains receive both cookies.
    const setNames = tabSession.cookies.setCalls.map((c) => `${c.name}@${c.domain}`);
    expect(setNames).toContain('mult@.edison.api.onereach.ai');
    expect(setNames).toContain('mult@.edison.onereach.ai');
    expect(setNames).toContain('or@.edison.api.onereach.ai');
    expect(setNames).toContain('or@.edison.onereach.ai');
    // Each cookie value matches its captured value.
    for (const call of tabSession.cookies.setCalls) {
      if (call.name === 'mult') {
        expect(call.value).toBe(SAMPLE_TOKEN);
        // mult should be httpOnly to match the OneReach Set-Cookie posture.
        expect(call.httpOnly).toBe(true);
      }
      if (call.name === 'or') {
        // The `or` cookie is a URL-encoded JSON payload, not a bearer.
        expect(call.value.length).toBeGreaterThan(0);
        expect(call.value).not.toBe(SAMPLE_TOKEN);
        // Must NOT be httpOnly -- the OneReach SPA reads it from JS.
        expect(call.httpOnly).toBe(false);
      }
    }
    // Flush was called so the next loadURL sees the cookie.
    expect(tabSession.cookies.flushCallCount).toBeGreaterThan(0);
  });

  it('returns no-token when no captured token exists', async () => {
    const store = new AuthStore({
      kvApi: new FakeKV(),
      sessionFromPartition: () => new FakeSession() as unknown as Electron.Session,
    });
    const result = await store.injectTokenIntoPartition('edison', 'persist:tab-x');
    expect(result.injected).toBe(false);
    expect(result.reason).toBe('no-token');
  });

  it('refuses to inject an expired cookie', async () => {
    const kv = new FakeKV();
    const authSession = new FakeSession();
    // Expired one hour ago.
    authSession.cookies.seed(
      multCookie({ expirationDate: Math.floor(Date.now() / 1000) - 3600 })
    );
    const tabSession = new FakeSession();
    const store = new AuthStore({
      kvApi: kv,
      sessionFromPartition: (partition: string) =>
        (partition === 'persist:lite-auth-edison' ? authSession : tabSession) as unknown as Electron.Session,
    });
    await kv.set('lite-auth-sessions', `edison:${SAMPLE_ACCOUNT_ID}`, {
      environment: 'edison',
      accountId: SAMPLE_ACCOUNT_ID,
      capturedAt: Date.now(),
    });
    await store.hydrate();

    const result = await store.injectTokenIntoPartition('edison', 'persist:tab-y');

    expect(result.injected).toBe(false);
    expect(result.reason).toBe('expired');
    expect(tabSession.cookies.setCalls).toHaveLength(0);
  });

  it('soft-fails when cookie writes throw', async () => {
    const kv = new FakeKV();
    const authSession = new FakeSession();
    authSession.cookies.seed(multCookie());
    const tabSession = new FakeSession();
    // Make set() throw on every call.
    tabSession.cookies.set = async (): Promise<void> => {
      throw new Error('disk full');
    };
    const store = new AuthStore({
      kvApi: kv,
      sessionFromPartition: (partition: string) =>
        (partition === 'persist:lite-auth-edison' ? authSession : tabSession) as unknown as Electron.Session,
    });
    await kv.set('lite-auth-sessions', `edison:${SAMPLE_ACCOUNT_ID}`, {
      environment: 'edison',
      accountId: SAMPLE_ACCOUNT_ID,
      capturedAt: Date.now(),
    });
    await store.hydrate();

    const result = await store.injectTokenIntoPartition('edison', 'persist:tab-z');

    expect(result.injected).toBe(false);
    expect(result.reason).toBe('cookie-write-failed');
  });
});

beforeEach(() => {
  // No global setup needed -- each test owns its own store + fakes.
});
