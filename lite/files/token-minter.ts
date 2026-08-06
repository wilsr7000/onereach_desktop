/**
 * Files token minter — account-scoped bearer for the GSX Files service.
 *
 * The Files service rejects raw `mult` cookie tokens for account-scoped
 * writes ("Cross account requests allowed to SUPER_ADMIN only") — it
 * requires a token minted FOR the target account. The full app solves
 * this in `lib/edison-sdk-manager.js` by fetching
 * `https://em.edison.api.onereach.ai/http/<accountId>/refresh_token`
 * and feeding the returned `FLOW <token>` to every @or-sdk client, with
 * a 50-minute cache. This is the same pattern, made injectable.
 *
 * Discovered live (ADR-050 validation): the first real `files.upload`
 * in Lite failed with the cross-account rejection while KV — whose
 * service accepts mult tokens — worked, which is why the gap survived
 * every mocked test.
 *
 * SECURITY: the minted token is held in memory only, never logged, and
 * cleared whenever the account changes or `invalidate()` runs.
 */

import { FilesError, FILES_ERROR_CODES } from './errors.js';

/** Same host the auth bindings' edison sessions target (full-app parity). */
export const FILES_TOKEN_MINT_BASE_URL = 'https://em.edison.api.onereach.ai';

/** Full-app parity: tokens live ~1h server-side; refresh at 50 min. */
export const FILES_TOKEN_TTL_MS = 50 * 60 * 1000;

export interface FilesTokenMinterConfig {
  /** Active OneReach accountId — null when signed out. */
  getAccountId: () => string | null;
  /** Injectable fetch (tests). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Override the mint host (tests / other envs). */
  baseUrl?: string;
  /** Cache TTL override (tests). */
  ttlMs?: number;
  /** Clock override (tests). */
  now?: () => number;
}

interface MintCache {
  token: string;
  accountId: string;
  expiresAt: number;
}

export class FilesTokenMinter {
  private readonly getAccountId: () => string | null;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private cache: MintCache | null = null;
  /** In-flight mint so concurrent ops share one request. */
  private pending: Promise<string> | null = null;

  constructor(config: FilesTokenMinterConfig) {
    this.getAccountId = config.getAccountId;
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.baseUrl = (config.baseUrl ?? FILES_TOKEN_MINT_BASE_URL).replace(/\/+$/, '');
    this.ttlMs = config.ttlMs ?? FILES_TOKEN_TTL_MS;
    this.now = config.now ?? Date.now;
  }

  /** Currently-cached minted token, or null (sync; never mints). */
  get(): string | null {
    const accountId = this.getAccountId();
    if (accountId === null || accountId.length === 0) return null;
    if (
      this.cache !== null &&
      this.cache.accountId === accountId &&
      this.now() < this.cache.expiresAt
    ) {
      return this.cache.token;
    }
    return null;
  }

  /**
   * Return a fresh account-scoped token, minting when the cache is
   * cold, expired, or for a different account. Returns null when
   * signed out (callers fall through to the raw binding, and the
   * client's no-account guard produces the canonical error).
   *
   * @throws {FilesError} `FILES_NETWORK` when the mint endpoint is
   *   unreachable or returns a non-OK / malformed response.
   */
  async ensure(): Promise<string | null> {
    const accountId = this.getAccountId();
    if (accountId === null || accountId.length === 0) return null;
    const cached = this.get();
    if (cached !== null) return cached;
    if (this.pending !== null) return this.pending;

    this.pending = this.mint(accountId);
    try {
      return await this.pending;
    } finally {
      this.pending = null;
    }
  }

  /** Drop the cache so the next op re-mints (e.g. after a 401/403). */
  invalidate(): void {
    this.cache = null;
  }

  private async mint(accountId: string): Promise<string> {
    const url = `${this.baseUrl}/http/${encodeURIComponent(accountId)}/refresh_token`;
    let resp: Response;
    try {
      resp = await this.fetchImpl(url, { method: 'GET' });
    } catch (err) {
      throw new FilesError({
        code: FILES_ERROR_CODES.NETWORK,
        message: `Files token mint failed to send: ${(err as Error).message}`,
        context: { op: 'mint-token' },
        remediation: 'Check your network connection (DNS, VPN, captive portal).',
        cause: err,
      });
    }
    let text = '';
    try {
      text = await resp.text();
    } catch {
      /* fall through with empty body */
    }
    if (!resp.ok) {
      throw new FilesError({
        code: FILES_ERROR_CODES.NETWORK,
        message: `Files token mint returned HTTP ${resp.status}.`,
        context: { op: 'mint-token', status: resp.status },
        remediation: 'The account refresh_token flow must be reachable.',
      });
    }
    let data: { token?: unknown; access_token?: unknown };
    try {
      data = JSON.parse(text) as { token?: unknown; access_token?: unknown };
    } catch (err) {
      throw new FilesError({
        code: FILES_ERROR_CODES.NETWORK,
        message: 'Files token mint returned a non-JSON body.',
        context: { op: 'mint-token', status: resp.status },
        remediation: 'The refresh_token flow must return `{ token: "..." }`.',
        cause: err,
      });
    }
    const raw =
      (typeof data.token === 'string' && data.token) ||
      (typeof data.access_token === 'string' && data.access_token) ||
      '';
    if (raw === '') {
      throw new FilesError({
        code: FILES_ERROR_CODES.NETWORK,
        message: 'Files token mint returned an empty token.',
        context: { op: 'mint-token', status: resp.status },
        remediation: 'Make sure the refresh_token flow is deployed for this account.',
      });
    }
    const token = raw.startsWith('FLOW ') ? raw : `FLOW ${raw}`;
    this.cache = { token, accountId, expiresAt: this.now() + this.ttlMs };
    return token;
  }
}
