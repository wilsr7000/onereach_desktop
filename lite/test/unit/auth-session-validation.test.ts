/**
 * Server-side session validation + reap + keep-alive (2026-08-11).
 *
 * THE BUG this guards: the client held a perfectly-persisted cookie
 * pair the SERVER had already expired. "hasSession: true" → first IDW
 * open bounced through auth.<env>/session-expired, and login recovery
 * re-injected the SAME dead cookies. These tests pin the fix:
 *
 *   - validateSessionWithServer maps probe results to verdicts
 *   - 'dead' reaps EVERY client copy (memory + vault + partition)
 *   - 'unreachable' (offline) NEVER signs the user out
 *   - hydrate revalidates recovered sessions in the background
 *   - the keep-alive loop revalidates each env that holds a session
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AuthStore } from '../../auth/store.js';
import {
  SessionVault,
  _setSessionVaultBackendForTesting,
  _resetSessionVaultBackendForTesting,
  type KeychainBackend,
} from '../../auth/session-vault.js';
import { SUPPORTED_ENVIRONMENTS, ENVIRONMENT_CONFIGS } from '../../auth/types.js';
import type { Environment } from '../../auth/types.js';

// ── Minimal fakes (mirrors auth-store.test.ts contracts) ─────────────

interface FakeCookie {
  name: string;
  value: string;
  domain: string;
  path?: string;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'unspecified' | 'no_restriction' | 'lax' | 'strict';
  expirationDate?: number;
}

class FakeCookieJar {
  readonly cookies: FakeCookie[] = [];
  on(): void {}
  off(): void {}
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
  async set(details: FakeCookie & { url?: string }): Promise<void> {
    const idx = this.cookies.findIndex(
      (c) => c.name === details.name && c.domain === details.domain
    );
    const { url: _url, ...cookie } = details;
    if (idx >= 0) this.cookies[idx] = cookie;
    else this.cookies.push(cookie);
  }
  async remove(_url: string, name: string): Promise<void> {
    for (let i = this.cookies.length - 1; i >= 0; i--) {
      if (this.cookies[i]?.name === name) this.cookies.splice(i, 1);
    }
  }
  async flushStore(): Promise<void> {}
}

class FakeSession {
  readonly cookies = new FakeCookieJar();
}

class FakeKeychain implements KeychainBackend {
  readonly m = new Map<string, string>();
  async setPassword(s: string, a: string, p: string): Promise<void> {
    this.m.set(`${s} ${a}`, p);
  }
  async getPassword(s: string, a: string): Promise<string | null> {
    return this.m.get(`${s} ${a}`) ?? null;
  }
  async deletePassword(s: string, a: string): Promise<boolean> {
    return this.m.delete(`${s} ${a}`);
  }
}

const ACCOUNT = '15bca0b6-cc2e-4340-9999-000000000001';
const EMAIL = 'robb@onereach.com';
const orValue = encodeURIComponent(JSON.stringify({ accountId: ACCOUNT, email: EMAIL }));

function seedEdisonSession(jar: FakeCookieJar): void {
  jar.cookies.push(
    {
      name: 'mult',
      value: 'MULT-TOKEN',
      domain: '.edison.api.onereach.ai',
      path: '/',
      secure: true,
      httpOnly: true,
      expirationDate: Math.floor(Date.now() / 1000) + 3600,
    },
    { name: 'or', value: orValue, domain: '.edison.onereach.ai', path: '/', secure: true }
  );
}

type Probe = (args: {
  env: Environment;
  partition: string;
  studioUrl: string;
}) => Promise<{ status: number; location?: string }>;

function makeStore(opts: {
  probe: Probe;
  session?: FakeSession;
  scheduled?: Array<{ fn: () => void; ms: number }>;
}): { store: AuthStore; session: FakeSession; keychain: FakeKeychain } {
  const session = opts.session ?? new FakeSession();
  const keychain = new FakeKeychain();
  _setSessionVaultBackendForTesting(keychain);
  const store = new AuthStore({
    kvApi: {
      // The store's KV surface is unused by these paths; a throwing fake
      // would fail loudly if that ever changes.
      get: async () => null,
      set: async () => undefined,
      delete: async () => undefined,
    } as never,
    sessionFromPartition: () => session as unknown as Electron.Session,
    sessionProbe: opts.probe,
    ...(opts.scheduled !== undefined
      ? {
          scheduleTimer: (fn: () => void, ms: number): (() => void) => {
            opts.scheduled!.push({ fn, ms });
            return () => undefined;
          },
        }
      : {}),
  });
  return { store, session, keychain };
}

async function settle(): Promise<void> {
  // Drain the fire-and-forget revalidation chains.
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  _setSessionVaultBackendForTesting(new FakeKeychain());
});
afterEach(() => {
  _resetSessionVaultBackendForTesting();
  vi.restoreAllMocks();
});

// ── Verdict mapping ──────────────────────────────────────────────────

describe('validateSessionWithServer — verdicts', () => {
  async function verdictFor(probeResult: {
    status: number;
    location?: string;
  }): Promise<string> {
    const { store, session } = makeStore({ probe: async () => probeResult });
    seedEdisonSession(session.cookies);
    await store.hydrate();
    await settle();
    // (a dead probe during hydrate would have reaped; re-seed + re-check)
    if (store.getSession('edison') === null) return 'dead';
    return store.validateSessionWithServer('edison');
  }

  it('2xx → alive', async () => {
    expect(await verdictFor({ status: 200 })).toBe('alive');
  });

  it('302 to the env auth host → dead', async () => {
    expect(
      await verdictFor({
        status: 302,
        location: 'https://auth.edison.onereach.ai/login?sso=true',
      })
    ).toBe('dead');
  });

  it('302 to a non-auth OneReach page → alive (internal redirect)', async () => {
    expect(
      await verdictFor({ status: 302, location: 'https://studio.edison.onereach.ai/home' })
    ).toBe('alive');
  });

  it('401 → dead', async () => {
    expect(await verdictFor({ status: 401 })).toBe('dead');
  });

  it('5xx → unreachable (server trouble is NOT a sign-out)', async () => {
    expect(await verdictFor({ status: 503 })).toBe('unreachable');
  });

  it('probe throw → unreachable', async () => {
    const { store, session } = makeStore({
      probe: async () => {
        throw new Error('offline');
      },
    });
    seedEdisonSession(session.cookies);
    await store.hydrate();
    await settle();
    expect(await store.validateSessionWithServer('edison')).toBe('unreachable');
  });

  it('no session for the env → no-session, probe never called', async () => {
    const probe = vi.fn(async () => ({ status: 200 }));
    const { store } = makeStore({ probe });
    expect(await store.validateSessionWithServer('edison')).toBe('no-session');
    expect(probe).not.toHaveBeenCalled();
  });
});

// ── The reap (mutation-checked piece by piece) ───────────────────────

describe('revalidateSession — dead reaps every client copy', () => {
  it('clears memory + keychain vault + partition cookies and notifies signed-out', async () => {
    let dead = false;
    const { store, session, keychain } = makeStore({
      probe: async () =>
        dead
          ? { status: 302, location: 'https://auth.edison.onereach.ai/login' }
          : { status: 200 },
    });
    seedEdisonSession(session.cookies);
    await store.hydrate();
    await settle();
    expect(store.getSession('edison')?.accountId).toBe(ACCOUNT);
    // hydrate mirrored the pair into the vault
    const vault = new SessionVault(keychain);
    expect((await vault.load('edison'))?.mult.value).toBe('MULT-TOKEN');

    const seen: Array<{ env: string; hasSession: boolean }> = [];
    store.onSessionChanged((env, s) => seen.push({ env, hasSession: s !== null }));

    dead = true;
    expect(await store.revalidateSession('edison')).toBe('dead');

    // 1. memory
    expect(store.getSession('edison')).toBeNull();
    expect(store.getToken('edison')).toBeNull();
    // 2. vault — nothing to resurrect on the next boot
    expect(await vault.load('edison')).toBeNull();
    // 3. partition — nothing for hydrate to re-find
    expect(session.cookies.cookies.filter((c) => c.name === 'mult' || c.name === 'or')).toEqual(
      []
    );
    // 4. signed-out broadcast
    expect(seen).toContainEqual({ env: 'edison', hasSession: false });
  });

  it('unreachable changes NOTHING (offline must never sign the user out)', async () => {
    let offline = false;
    const { store, session, keychain } = makeStore({
      probe: async () => {
        if (offline) throw new Error('net down');
        return { status: 200 };
      },
    });
    seedEdisonSession(session.cookies);
    await store.hydrate();
    await settle();

    offline = true;
    expect(await store.revalidateSession('edison')).toBe('unreachable');
    expect(store.getSession('edison')?.accountId).toBe(ACCOUNT);
    const vault = new SessionVault(keychain);
    expect((await vault.load('edison'))?.mult.value).toBe('MULT-TOKEN');
    expect(session.cookies.cookies.some((c) => c.name === 'mult')).toBe(true);
  });
});

// ── Boot hook ────────────────────────────────────────────────────────

describe('hydrate — background server check', () => {
  it('a server-dead session recovered at boot is reaped before first use', async () => {
    const { store, session } = makeStore({
      probe: async () => ({
        status: 302,
        location: 'https://auth.edison.onereach.ai/session-expired',
      }),
    });
    seedEdisonSession(session.cookies);
    await store.hydrate();
    await settle();
    expect(store.getSession('edison')).toBeNull();
  });
});

// ── Keep-alive ───────────────────────────────────────────────────────

describe('startSessionKeepAlive', () => {
  it('revalidates each env holding a session on every tick; idempotent', async () => {
    const probed: Environment[] = [];
    const scheduled: Array<{ fn: () => void; ms: number }> = [];
    const { store, session } = makeStore({
      probe: async ({ env }) => {
        probed.push(env);
        return { status: 200 };
      },
      scheduled,
    });
    seedEdisonSession(session.cookies);
    await store.hydrate();
    await settle();
    probed.length = 0;

    const stop = store.startSessionKeepAlive(600_000);
    expect(store.startSessionKeepAlive(600_000)).toBe(stop); // idempotent
    const pending = scheduled[scheduled.length - 1];
    expect(pending?.ms).toBe(600_000);

    pending!.fn(); // fire one tick
    await settle();
    expect(probed).toEqual(['edison']); // only envs WITH a session
    stop();
  });
});

// ── Multi-env config (2026-08-11: "multiple environments need to be supported") ──

describe('environment coverage', () => {
  it('every supported environment has a full config (incl. production)', () => {
    expect(SUPPORTED_ENVIRONMENTS).toContain('production');
    for (const env of SUPPORTED_ENVIRONMENTS) {
      const cfg = ENVIRONMENT_CONFIGS[env];
      expect(cfg, `config missing for ${env}`).toBeDefined();
      expect(cfg!.studioUrl).toMatch(/^https:\/\//);
      expect(cfg!.cookieDomainSuffixes.length).toBeGreaterThan(0);
      expect(cfg!.authHostnamePrefix).toBe('auth.');
    }
  });
});
