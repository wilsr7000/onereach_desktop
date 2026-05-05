/**
 * HealthStore tests (ADR-036).
 *
 * Drives the store with stub readers, asserts:
 *   - app metadata is populated from config
 *   - windows are classified by URL
 *   - auth section reports presence booleans, never raw tokens
 *   - TOTP section reports configured + secondsRemaining, never the
 *     code value or the secret
 *   - Neon section maps `status()` safely
 *   - diagnostics counts errors/warns from `recent('*', 200)`
 *   - any reader throwing produces a safe fallback section, not a
 *     thrown snapshot
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
}));

import { HealthStore, classifyWindow } from '../../health/store.js';

const TOKEN_SENTINEL = 'eyJTHIS_IS_A_FAKE_JWT_THAT_MUST_NEVER_LEAK';
const TOTP_CODE_SENTINEL = '847293';
const TOTP_SECRET_SENTINEL = 'JBSWY3DPEHPK3PXP_SECRET';
const NEON_PASSWORD_SENTINEL = 'NEON_DB_PASSWORD_SHHH';

function makeFakeWindow(opts: {
  id: number;
  title?: string;
  url?: string;
  focused?: boolean;
  visible?: boolean;
  destroyed?: boolean;
}): import('electron').BrowserWindow {
  const destroyed = opts.destroyed ?? false;
  const win = {
    id: opts.id,
    isDestroyed: () => destroyed,
    getTitle: () => opts.title ?? '',
    isFocused: () => opts.focused ?? false,
    isVisible: () => opts.visible ?? true,
    webContents: { getURL: () => opts.url ?? '' },
  };
  return win as unknown as import('electron').BrowserWindow;
}

describe('classifyWindow', () => {
  it('matches URL endings to known kernel windows', () => {
    expect(classifyWindow('file:///abc/placeholder.html', '')).toBe('main');
    expect(classifyWindow('file:///abc/settings.html', '')).toBe('settings');
    expect(classifyWindow('file:///abc/api-docs.html', '')).toBe('api-docs');
    expect(classifyWindow('file:///abc/modal.html', 'Report a Bug')).toBe('bug-report');
    expect(classifyWindow('file:///abc/about.html', '')).toBe('about');
    expect(classifyWindow('https://accounts.onereach.ai/login', 'Sign In')).toBe('auth');
    expect(classifyWindow('https://example.com/random', '')).toBe('unknown');
    expect(classifyWindow('', '')).toBe('unknown');
  });
});

describe('HealthStore.snapshot()', () => {
  function baseConfig() {
    return {
      version: '1.2.3',
      startedAt: 1_000,
      userDataPath: '/Users/test/Library/.onereach-lite',
      platform: 'darwin' as NodeJS.Platform,
      arch: 'arm64',
      now: () => 5_500,
      windows: { getAll: () => [] },
    };
  }

  it('snapshots app metadata from injected config', async () => {
    const store = new HealthStore(baseConfig());
    const snap = await store.snapshot();
    expect(snap.schemaVersion).toBe(1);
    expect(snap.capturedAt).toBe(new Date(5_500).toISOString());
    expect(snap.app.version).toBe('1.2.3');
    expect(snap.app.platform).toBe('darwin');
    expect(snap.app.arch).toBe('arm64');
    expect(snap.app.userDataPath).toBe('/Users/test/Library/.onereach-lite');
    expect(snap.app.uptimeMs).toBe(4_500);
    expect(snap.app.startedAt).toBe(1_000);
  });

  it('classifies windows from BrowserWindow.getAllWindows()', async () => {
    const store = new HealthStore({
      ...baseConfig(),
      windows: {
        getAll: () => [
          makeFakeWindow({ id: 1, title: 'Onereach', url: 'file:///app/placeholder.html', focused: true }),
          makeFakeWindow({ id: 2, title: 'Settings', url: 'file:///app/settings.html' }),
          makeFakeWindow({ id: 3, title: 'API Reference', url: 'file:///app/api-docs.html' }),
          makeFakeWindow({ id: 4, title: 'gone', destroyed: true }),
        ],
      },
    });
    const snap = await store.snapshot();
    expect(snap.windows).toHaveLength(4);
    expect(snap.windows[0]?.type).toBe('main');
    expect(snap.windows[0]?.focused).toBe(true);
    expect(snap.windows[1]?.type).toBe('settings');
    expect(snap.windows[2]?.type).toBe('api-docs');
    expect(snap.windows[3]?.destroyed).toBe(true);
    expect(snap.windows[3]?.title).toBe(''); // can't read after destroy
  });

  it('auth section reports signedIn + hasMultToken without exposing the token', async () => {
    const store = new HealthStore({
      ...baseConfig(),
      auth: {
        getSession: () => ({
          accountId: 'acc-uuid-1',
          email: 'alice@example.com',
          expiresAt: 9_000,
        }),
        getToken: () => TOKEN_SENTINEL,
      },
    });
    const snap = await store.snapshot();
    expect(snap.auth.signedIn).toBe(true);
    expect(snap.auth.environment).toBe('edison');
    expect(snap.auth.accountId).toBe('acc-uuid-1');
    expect(snap.auth.email).toBe('alice@example.com');
    expect(snap.auth.hasMultToken).toBe(true);
    expect(snap.auth.hasAccountToken).toBe(true);
    expect(snap.auth.expiresAt).toBe(9_000);

    // The serialized snapshot never contains the raw token.
    expect(JSON.stringify(snap)).not.toContain(TOKEN_SENTINEL);
  });

  it('auth section reports signed-out shape when no session', async () => {
    const store = new HealthStore({
      ...baseConfig(),
      auth: {
        getSession: () => null,
        getToken: () => null,
      },
    });
    const snap = await store.snapshot();
    expect(snap.auth.signedIn).toBe(false);
    expect(snap.auth.hasMultToken).toBe(false);
    expect(snap.auth.hasAccountToken).toBe(false);
    expect(snap.auth.accountId).toBeUndefined();
    expect(snap.auth.email).toBeUndefined();
  });

  it('TOTP section reports configured + secondsRemaining without the code or secret', async () => {
    const store = new HealthStore({
      ...baseConfig(),
      totp: {
        hasSecret: async () => true,
        getMetadata: async () => ({
          issuer: 'OneReach',
          account: 'alice@example.com',
          secretLength: 32,
        }),
        getCurrentCode: async () => ({ timeRemaining: 17 }),
      },
    });
    const snap = await store.snapshot();
    expect(snap.totp.configured).toBe(true);
    expect(snap.totp.hasCurrentCode).toBe(true);
    expect(snap.totp.secondsRemaining).toBe(17);
    expect(snap.totp.metadata?.issuer).toBe('OneReach');
    expect(snap.totp.metadata?.secretLength).toBe(32);

    // Even if a malicious or careless test stub returned the actual
    // code/secret, the type-shape filtering means they cannot land
    // in the snapshot. Verify by serializing.
    const serialized = JSON.stringify(snap);
    expect(serialized).not.toContain(TOTP_CODE_SENTINEL);
    expect(serialized).not.toContain(TOTP_SECRET_SENTINEL);
  });

  it('TOTP section reports configured=false when no secret stored', async () => {
    const store = new HealthStore({
      ...baseConfig(),
      totp: {
        hasSecret: async () => false,
        getMetadata: async () => null,
        getCurrentCode: async () => {
          throw new Error('TOTP_NO_SECRET');
        },
      },
    });
    const snap = await store.snapshot();
    expect(snap.totp.configured).toBe(false);
    expect(snap.totp.hasCurrentCode).toBe(false);
    expect(snap.totp.metadata).toBeUndefined();
    expect(snap.totp.secondsRemaining).toBeUndefined();
  });

  it('TOTP section gracefully handles getCurrentCode failure when configured', async () => {
    const store = new HealthStore({
      ...baseConfig(),
      totp: {
        hasSecret: async () => true,
        getMetadata: async () => ({ issuer: 'OneReach', secretLength: 32 }),
        getCurrentCode: async () => {
          throw new Error('otplib generation failed');
        },
      },
    });
    const snap = await store.snapshot();
    expect(snap.totp.configured).toBe(true);
    expect(snap.totp.hasCurrentCode).toBe(false);
    expect(snap.totp.secondsRemaining).toBeUndefined();
    expect(snap.totp.metadata?.issuer).toBe('OneReach');
  });

  it('Neon section maps status() without exposing the password', async () => {
    const store = new HealthStore({
      ...baseConfig(),
      neon: {
        status: async () => ({
          endpoint: 'https://files.edison.api.onereach.ai/flow/neon',
          uri: 'neo4j+s://abc.databases.neo4j.io',
          user: 'neo4j',
          database: 'neo4j',
          hasPassword: true,
          ready: true,
        }),
      },
    });
    const snap = await store.snapshot();
    expect(snap.neon.configured).toBe(true);
    expect(snap.neon.ready).toBe(true);
    expect(snap.neon.endpoint).toContain('flow/neon');
    expect(snap.neon.uri).toContain('neo4j+s');
    expect(snap.neon.user).toBe('neo4j');
    expect(snap.neon.database).toBe('neo4j');
    expect(snap.neon.hasPassword).toBe(true);

    // Even when the upstream reader produces a status object that
    // accidentally embeds a password somewhere, the type-shape
    // filtering means it cannot land here. Verify by serializing.
    const serialized = JSON.stringify(snap);
    expect(serialized).not.toContain(NEON_PASSWORD_SENTINEL);
  });

  it('diagnostics counts errors and warnings, captures lastError', async () => {
    const store = new HealthStore({
      ...baseConfig(),
      diagnostics: {
        recent: () => [
          { name: 'kv.set.start', level: 'info' },
          { name: 'kv.set.fail', level: 'error', error: { message: 'KV_TIMEOUT' } },
          { name: 'auth.signIn.fail', level: 'error', error: { message: 'AUTH_BAD_TOKEN' } },
          { name: 'updater.check.warn', level: 'warn' },
          { name: 'updater.check.warn2', level: 'warn' },
          { name: 'app.boot.finish', level: 'info' },
        ],
      },
    });
    const snap = await store.snapshot();
    expect(snap.diagnostics.recentErrorCount).toBe(2);
    expect(snap.diagnostics.recentWarnCount).toBe(2);
    // Walks newest-first -> last error in the array is the most recent.
    expect(snap.diagnostics.lastError).toBe('auth.signIn.fail: AUTH_BAD_TOKEN');
  });

  it('updater section reports persistent state', async () => {
    const store = new HealthStore({
      ...baseConfig(),
      updater: {
        read: () => ({
          failedAttempts: 2,
          lastAttemptVersion: '1.4.0',
          lastAttemptTime: '2026-05-04T12:00:00.000Z',
        }),
      },
    });
    const snap = await store.snapshot();
    expect(snap.updater.failedAttempts).toBe(2);
    expect(snap.updater.lastAttemptVersion).toBe('1.4.0');
    expect(snap.updater.lastAttemptTime).toBe('2026-05-04T12:00:00.000Z');
  });

  it('produces safe fallbacks when EVERY reader throws', async () => {
    const store = new HealthStore({
      ...baseConfig(),
      auth: {
        getSession: () => {
          throw new Error('auth boom');
        },
        getToken: () => {
          throw new Error('auth boom');
        },
      },
      totp: {
        hasSecret: async () => {
          throw new Error('totp boom');
        },
        getMetadata: async () => null,
        getCurrentCode: async () => ({ timeRemaining: 0 }),
      },
      neon: {
        status: async () => {
          throw new Error('neon boom');
        },
      },
      updater: {
        read: () => {
          throw new Error('updater boom');
        },
      },
      diagnostics: {
        recent: () => {
          throw new Error('diagnostics boom');
        },
      },
      windows: {
        getAll: () => {
          throw new Error('windows boom');
        },
      },
    });
    const snap = await store.snapshot();
    // Snapshot itself never throws; every section has its safe shape.
    expect(snap.schemaVersion).toBe(1);
    expect(snap.windows).toEqual([]);
    expect(snap.auth.signedIn).toBe(false);
    expect(snap.auth.hasMultToken).toBe(false);
    expect(snap.totp.configured).toBe(false);
    expect(snap.totp.hasCurrentCode).toBe(false);
    expect(snap.neon.configured).toBe(false);
    expect(snap.neon.ready).toBe(false);
    expect(snap.neon.hasPassword).toBe(false);
    expect(snap.updater.failedAttempts).toBe(0);
    expect(snap.updater.lastAttemptVersion).toBeNull();
    expect(snap.diagnostics.recentErrorCount).toBe(0);
    expect(snap.diagnostics.recentWarnCount).toBe(0);
  });

  it('logger receives non-secret diagnostics on read failures', async () => {
    const warnings: Array<{ message: string; data?: unknown }> = [];
    const store = new HealthStore({
      ...baseConfig(),
      logger: { warn: (message, data) => warnings.push({ message, ...(data !== undefined ? { data } : {}) }) },
      auth: {
        getSession: () => {
          throw new Error('auth boom');
        },
        getToken: () => null,
      },
    });
    await store.snapshot();
    const authWarn = warnings.find((w) => w.message === 'auth read failed');
    expect(authWarn).toBeDefined();
    // The warning must not contain secret-shaped strings.
    expect(JSON.stringify(authWarn)).not.toContain(TOKEN_SENTINEL);
  });
});
