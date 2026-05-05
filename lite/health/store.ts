/**
 * Health snapshot store -- INTERNAL.
 *
 * Pulls a current-state view from every documented lite module and
 * assembles an `AppHealthSnapshot`. Best-effort by design: each
 * section is wrapped in its own try/catch and produces a safe
 * fallback on failure rather than throwing the whole snapshot away.
 *
 * The store does NOT cache. Every call to `snapshot()` re-reads from
 * the underlying modules. If you need a "last-known" cache, layer it
 * over the public `getHealthApi()` -- this store stays simple.
 *
 * @internal -- consumers go through `getHealthApi()`.
 */

import { BrowserWindow } from 'electron';
import {
  HEALTH_SCHEMA_VERSION,
  type AppHealthSnapshot,
  type HealthAppSnapshot,
  type HealthAuthSnapshot,
  type HealthDiagnosticsSnapshot,
  type HealthNeonSnapshot,
  type HealthTotpSnapshot,
  type HealthUpdaterSnapshot,
  type HealthWindowSnapshot,
} from './types.js';

// ─── Pluggable readers ──────────────────────────────────────────────────
//
// These are typed minimally rather than via the real api types so the
// store can be unit-tested without standing up every other module's
// singleton. The integration shape lives in `defaultConfig()` which
// the public api.ts wires up.

export interface AuthReader {
  getSession(env: 'edison'): {
    accountId: string;
    email?: string;
    expiresAt?: number;
  } | null;
  getToken(env: 'edison'): string | null;
}

export interface TotpReader {
  hasSecret(): Promise<boolean>;
  getMetadata(): Promise<{
    issuer?: string;
    account?: string;
    secretLength?: number;
  } | null>;
  getCurrentCode(): Promise<{ timeRemaining: number }>;
}

export interface NeonReader {
  status(): Promise<{
    endpoint: string | null;
    uri: string | null;
    user: string;
    database: string;
    hasPassword: boolean;
    ready: boolean;
  }>;
}

export interface UpdaterReader {
  read(): {
    failedAttempts: number;
    lastAttemptVersion: string | null;
    lastAttemptTime: string | null;
  };
}

export interface DiagnosticsReader {
  recent(pattern: string, limit: number): Array<{
    name: string;
    level: 'debug' | 'info' | 'warn' | 'error';
    data?: unknown;
    error?: { message?: string } | null;
  }>;
}

export interface WindowsReader {
  /** Defaults to `BrowserWindow.getAllWindows()`; injectable for tests. */
  getAll(): BrowserWindow[];
}

export interface HealthStoreConfig {
  /** Lite version (NOT app.getVersion(), which returns Electron's in dev). */
  version: string;
  /** Wall-clock ms epoch when the app process started. */
  startedAt: number;
  /** Resolved `app.getPath('userData')`. */
  userDataPath: string;
  /** Process platform. Defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  /** Process arch. Defaults to `process.arch`. */
  arch?: string;
  /** Now provider (testable). Defaults to `Date.now`. */
  now?: () => number;
  /** Logger for read failures. Defaults to silent. */
  logger?: {
    warn: (message: string, data?: unknown) => void;
  };
  /** All readers are optional -- a missing reader produces a safe fallback. */
  auth?: AuthReader;
  totp?: TotpReader;
  neon?: NeonReader;
  updater?: UpdaterReader;
  diagnostics?: DiagnosticsReader;
  windows?: WindowsReader;
}

/**
 * Best-effort current-state aggregator across documented lite
 * modules.
 *
 * @internal -- consumers go through `getHealthApi()`.
 */
export class HealthStore {
  private readonly config: HealthStoreConfig;

  constructor(config: HealthStoreConfig) {
    this.config = config;
  }

  /** Read every section in parallel and assemble. Never throws. */
  async snapshot(): Promise<AppHealthSnapshot> {
    const [auth, totp, neon, updater, diagnostics, windows] = await Promise.all([
      this.readAuth(),
      this.readTotp(),
      this.readNeon(),
      this.readUpdater(),
      this.readDiagnostics(),
      this.readWindows(),
    ]);

    const now = (this.config.now ?? Date.now)();
    return {
      schemaVersion: HEALTH_SCHEMA_VERSION,
      capturedAt: new Date(now).toISOString(),
      app: this.readApp(now),
      windows,
      auth,
      totp,
      neon,
      updater,
      diagnostics,
    };
  }

  // ─── Section readers ──────────────────────────────────────────────────

  private readApp(now: number): HealthAppSnapshot {
    return {
      version: this.config.version,
      platform: this.config.platform ?? process.platform,
      arch: this.config.arch ?? process.arch,
      uptimeMs: Math.max(0, now - this.config.startedAt),
      userDataPath: this.config.userDataPath,
      startedAt: this.config.startedAt,
    };
  }

  private async readWindows(): Promise<HealthWindowSnapshot[]> {
    if (this.config.windows === undefined) {
      // Default: real Electron BrowserWindow registry. Wrapped here
      // (not at construction time) so tests can use a stub without
      // pulling Electron in.
      return this.snapshotWindows(BrowserWindow.getAllWindows());
    }
    try {
      return this.snapshotWindows(this.config.windows.getAll());
    } catch (err) {
      this.warn('windows.getAll failed', { error: (err as Error).message });
      return [];
    }
  }

  private snapshotWindows(wins: BrowserWindow[]): HealthWindowSnapshot[] {
    return wins.map((w) => {
      let id = -1;
      let title = '';
      let url = '';
      let focused = false;
      let visible = false;
      let destroyed = false;
      try {
        destroyed = w.isDestroyed();
        id = w.id;
        if (!destroyed) {
          title = w.getTitle();
          url = w.webContents.getURL();
          focused = w.isFocused();
          visible = w.isVisible();
        }
      } catch (err) {
        this.warn('per-window read failed', { error: (err as Error).message });
      }
      return {
        id,
        title,
        url,
        type: classifyWindow(url, title),
        focused,
        visible,
        destroyed,
      };
    });
  }

  private async readAuth(): Promise<HealthAuthSnapshot> {
    const fallback: HealthAuthSnapshot = {
      signedIn: false,
      environment: 'edison',
      hasMultToken: false,
      hasAccountToken: false,
    };
    if (this.config.auth === undefined) return fallback;
    try {
      const session = this.config.auth.getSession('edison');
      const token = this.config.auth.getToken('edison');
      if (session === null) return { ...fallback, hasMultToken: token !== null };
      return {
        signedIn: true,
        environment: 'edison',
        accountId: session.accountId,
        ...(session.email !== undefined ? { email: session.email } : {}),
        hasMultToken: token !== null,
        hasAccountToken: session.accountId.length > 0,
        ...(session.expiresAt !== undefined ? { expiresAt: session.expiresAt } : {}),
      };
    } catch (err) {
      this.warn('auth read failed', { error: (err as Error).message });
      return fallback;
    }
  }

  private async readTotp(): Promise<HealthTotpSnapshot> {
    const fallback: HealthTotpSnapshot = { configured: false, hasCurrentCode: false };
    if (this.config.totp === undefined) return fallback;
    try {
      const configured = await this.config.totp.hasSecret();
      if (!configured) return fallback;

      // Metadata + current code are independent reads -- one failing
      // shouldn't poison the other. `getCurrentCode` is the most
      // likely to fail (e.g. otplib generation issue) so we treat it
      // as best-effort.
      const meta = await this.config.totp.getMetadata().catch(() => null);
      let secondsRemaining: number | undefined;
      let hasCurrentCode = false;
      try {
        const code = await this.config.totp.getCurrentCode();
        hasCurrentCode = true;
        secondsRemaining = code.timeRemaining;
      } catch (err) {
        this.warn('totp.getCurrentCode failed', { error: (err as Error).message });
      }

      const out: HealthTotpSnapshot = {
        configured: true,
        hasCurrentCode,
      };
      if (secondsRemaining !== undefined) out.secondsRemaining = secondsRemaining;
      if (meta !== null) {
        const m: HealthTotpSnapshot['metadata'] = {};
        if (meta.issuer !== undefined) m.issuer = meta.issuer;
        if (meta.account !== undefined) m.account = meta.account;
        if (meta.secretLength !== undefined) m.secretLength = meta.secretLength;
        // Only attach if at least one field is present.
        if (Object.keys(m).length > 0) out.metadata = m;
      }
      return out;
    } catch (err) {
      this.warn('totp read failed', { error: (err as Error).message });
      return fallback;
    }
  }

  private async readNeon(): Promise<HealthNeonSnapshot> {
    const fallback: HealthNeonSnapshot = {
      configured: false,
      ready: false,
      hasPassword: false,
    };
    if (this.config.neon === undefined) return fallback;
    try {
      const status = await this.config.neon.status();
      const configured = status.endpoint !== null && status.uri !== null;
      const out: HealthNeonSnapshot = {
        configured,
        ready: status.ready,
        hasPassword: status.hasPassword,
        user: status.user,
        database: status.database,
      };
      if (status.endpoint !== null) out.endpoint = status.endpoint;
      if (status.uri !== null) out.uri = status.uri;
      return out;
    } catch (err) {
      this.warn('neon read failed', { error: (err as Error).message });
      return fallback;
    }
  }

  private async readUpdater(): Promise<HealthUpdaterSnapshot> {
    const fallback: HealthUpdaterSnapshot = {
      failedAttempts: 0,
      lastAttemptVersion: null,
      lastAttemptTime: null,
    };
    if (this.config.updater === undefined) return fallback;
    try {
      const state = this.config.updater.read();
      return {
        failedAttempts: state.failedAttempts,
        lastAttemptVersion: state.lastAttemptVersion,
        lastAttemptTime: state.lastAttemptTime,
      };
    } catch (err) {
      this.warn('updater read failed', { error: (err as Error).message });
      return fallback;
    }
  }

  private async readDiagnostics(): Promise<HealthDiagnosticsSnapshot> {
    const fallback: HealthDiagnosticsSnapshot = {
      recentErrorCount: 0,
      recentWarnCount: 0,
    };
    if (this.config.diagnostics === undefined) return fallback;
    try {
      const events = this.config.diagnostics.recent('*', 200);
      let recentErrorCount = 0;
      let recentWarnCount = 0;
      let lastError: string | undefined;
      // Walk newest-first (events come oldest-first from the queue).
      for (let i = events.length - 1; i >= 0; i--) {
        const ev = events[i];
        if (ev === undefined) continue;
        if (ev.level === 'error') {
          recentErrorCount++;
          if (lastError === undefined) {
            const err = ev.error;
            const msg = err !== null && err !== undefined && typeof err.message === 'string'
              ? err.message
              : '';
            lastError = msg.length > 0 ? `${ev.name}: ${msg}` : ev.name;
          }
        } else if (ev.level === 'warn') {
          recentWarnCount++;
        }
      }
      const out: HealthDiagnosticsSnapshot = {
        recentErrorCount,
        recentWarnCount,
      };
      if (lastError !== undefined) out.lastError = lastError;
      return out;
    } catch (err) {
      this.warn('diagnostics read failed', { error: (err as Error).message });
      return fallback;
    }
  }

  private warn(message: string, data?: unknown): void {
    if (this.config.logger !== undefined) {
      try {
        this.config.logger.warn(message, data);
      } catch {
        /* logger failures must not poison snapshots */
      }
    }
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────

/**
 * Classify a BrowserWindow by URL ending. Exported for tests.
 *
 * - `*placeholder.html` -> `main` (the kernel's main window)
 * - `*settings.html`    -> `settings`
 * - `*api-docs.html`    -> `api-docs`
 * - `*modal.html`       -> `bug-report`
 * - `*about.html`       -> `about`
 * - URLs containing `accounts.onereach.ai` or `gsx-`, plus the auth
 *   popup's Electron URL pattern -> `auth`
 * - everything else     -> `unknown`
 */
export function classifyWindow(
  url: string,
  title: string
): HealthWindowSnapshot['type'] {
  const lowerUrl = url.toLowerCase();
  const lowerTitle = title.toLowerCase();
  if (lowerUrl.endsWith('placeholder.html') || lowerUrl.endsWith('placeholder.html#')) return 'main';
  if (lowerUrl.endsWith('settings.html')) return 'settings';
  if (lowerUrl.endsWith('api-docs.html')) return 'api-docs';
  if (lowerUrl.endsWith('modal.html')) return 'bug-report';
  if (lowerUrl.endsWith('about.html')) return 'about';
  if (
    lowerUrl.includes('onereach.ai') ||
    lowerUrl.includes('gsx-') ||
    lowerTitle.includes('sign in')
  ) {
    return 'auth';
  }
  return 'unknown';
}
