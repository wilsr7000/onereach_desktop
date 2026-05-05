/**
 * Health module -- shared types.
 *
 * The health snapshot answers "what is true right now?" -- the
 * counterpart to the central event log (which answers "what happened
 * over time?"). Per ADR for pull-based health snapshot, this module
 * does NOT maintain mutable state of its own; every read pulls fresh
 * from the relevant module's public API.
 *
 * Security posture (enforced by these types -- there are no fields
 * for secrets):
 *
 *   - no `multToken`, `accountToken`, raw cookies
 *   - no TOTP secret value or current code
 *   - no Neon password
 *   - no API keys
 *
 * See `lite/health/README.md` for the full security exclusions list.
 */

/** Schema version of the snapshot itself. Bumps on breaking shape changes. */
export const HEALTH_SCHEMA_VERSION = 1;

export interface HealthAppSnapshot {
  /** Lite version (from package.json -- NOT app.getVersion(), which returns Electron's version in dev). */
  version: string;
  /** Node platform string. */
  platform: NodeJS.Platform;
  /** Process arch (`x64`, `arm64`). */
  arch: string;
  /**
   * Wall-clock ms since the process started. Computed from
   * `Date.now() - startedAt` so it is consistent regardless of when
   * the snapshot is taken vs when uptime is observed.
   */
  uptimeMs: number;
  /**
   * Resolved `app.getPath('userData')`. Useful for triage so the
   * support agent knows which dir to look in.
   */
  userDataPath: string;
  /**
   * Wall-clock ms epoch the app process started. Provided here so
   * consumers can compute uptime themselves if they need a more
   * precise reading after capture.
   */
  startedAt: number;
}

/**
 * One BrowserWindow at snapshot time. Window classification is by URL
 * ending (`settings.html` -> `settings`, `api-docs.html` -> falls into
 * `unknown` because v1 lists only the documented kernel windows --
 * extend the discriminator when more windows ship).
 */
export interface HealthWindowSnapshot {
  /** Electron window id. */
  id: number;
  /** Document title (empty if not yet loaded). */
  title: string;
  /** Final URL (post-redirect; empty for blank windows). */
  url: string;
  /** Coarse role for triage. */
  type: 'main' | 'settings' | 'auth' | 'bug-report' | 'about' | 'api-docs' | 'unknown';
  focused: boolean;
  visible: boolean;
  destroyed: boolean;
}

export interface HealthAuthSnapshot {
  /** True if there is a captured session for any supported environment. */
  signedIn: boolean;
  /**
   * Environment scope. v1 only supports `edison`; this is here so the
   * shape doesn't have to change when other environments land.
   */
  environment: 'edison';
  /** Account id (UUID), present when signed in. */
  accountId?: string;
  /** Email lifted from the captured session, present when known. */
  email?: string;
  /**
   * True when `getAuthApi().getToken('edison')` returns a non-null
   * value. The actual token value is NEVER included.
   */
  hasMultToken: boolean;
  /**
   * True when the captured session knows which account scope it
   * belongs to (i.e. a non-empty `accountId`). The full app captures
   * a separate "account" token; in lite's single-cookie model this
   * tracks "we have account scope" rather than a distinct token. The
   * field is here for shape-compatibility with future per-token
   * tracking and for triage clarity.
   */
  hasAccountToken: boolean;
  /**
   * Wall-clock ms epoch the session expires, if known from the
   * cookie. Undefined when expiration was not present on the cookie.
   */
  expiresAt?: number;
}

export interface HealthTotpSnapshot {
  /** True if a TOTP secret is stored in the keychain. */
  configured: boolean;
  /**
   * Non-secret metadata about the configured authenticator. Excludes
   * the secret value; `secretLength` is the Base32 character count.
   */
  metadata?: {
    issuer?: string;
    account?: string;
    secretLength?: number;
  };
  /**
   * True when `getCurrentCode()` succeeded at snapshot time. The
   * actual 6-digit code is NEVER included.
   */
  hasCurrentCode: boolean;
  /**
   * Seconds until the current code expires (1..30). Undefined if the
   * snapshot couldn't read the live code (e.g. no secret saved or
   * keychain unavailable).
   */
  secondsRemaining?: number;
}

export interface HealthNeonSnapshot {
  /** True when both endpoint and URI are set. */
  configured: boolean;
  /**
   * True when a query can be attempted (endpoint + uri + password).
   * Pulled directly from `NeonStatus.ready`.
   */
  ready: boolean;
  /** Edison Neon flow URL (no auth -- safe to surface). */
  endpoint?: string;
  /** Neo4j Aura URI (`neo4j+s://...`). Safe; not a credential. */
  uri?: string;
  /** Neo4j username (default `neo4j`). */
  user?: string;
  /** Neo4j database name (default `neo4j`). */
  database?: string;
  /**
   * True when the credential provider holds a non-empty password.
   * The password value is NEVER included.
   */
  hasPassword: boolean;
}

export interface HealthUpdaterSnapshot {
  /** Number of consecutive failed install attempts. Reset on success. */
  failedAttempts: number;
  /** Version we last tried to install (set before quitAndInstall). */
  lastAttemptVersion: string | null;
  /** ISO timestamp of the last attempt. Null when never attempted. */
  lastAttemptTime: string | null;
}

export interface HealthDiagnosticsSnapshot {
  /**
   * Count of `level === 'error'` entries in the most recent N (200)
   * events from the central log.
   */
  recentErrorCount: number;
  /** Count of `level === 'warn'` entries in the same window. */
  recentWarnCount: number;
  /**
   * Most recent error message + dotted event name, redacted to a
   * short summary. Undefined when the recent window has no errors.
   */
  lastError?: string;
}

/**
 * One pull-based snapshot of "what is true right now" across the lite
 * app. Always best-effort: a section that fails to read produces a
 * safe fallback rather than throwing.
 */
export interface AppHealthSnapshot {
  /** Bumps on breaking shape changes. */
  schemaVersion: typeof HEALTH_SCHEMA_VERSION;
  /** ISO timestamp the snapshot was assembled. */
  capturedAt: string;
  app: HealthAppSnapshot;
  windows: HealthWindowSnapshot[];
  auth: HealthAuthSnapshot;
  totp: HealthTotpSnapshot;
  neon: HealthNeonSnapshot;
  updater: HealthUpdaterSnapshot;
  diagnostics: HealthDiagnosticsSnapshot;
}
