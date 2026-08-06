/**
 * Files transport via `@or-sdk/files` -- the authenticated wrapper.
 *
 * Internal implementation. Other lite modules MUST consume
 * `getFilesApi()` from `./api.ts` -- never reach into this file.
 *
 * Mirrors the shape of `lite/kv/sdk-client.ts`:
 *   - Lazy SDK construction; rebuilt when the active accountId
 *     changes (the SDK's accountId is set at construction time).
 *   - Error normalization to `FilesError` with stable codes.
 *   - Span emission on every op when a `spanEmitter` is provided.
 *
 * @internal
 */

import type { Span, EventRecord } from '../logging/events.js';
import { getLoggingApi } from '../logging/api.js';
import { isFilesEvent, type FilesEvent } from './events.js';
import { FilesError, FILES_ERROR_CODES } from './errors.js';
import type {
  FilesContent,
  FilesItem,
  FilesUploadOptions,
  FilesDownloadOptions,
  FilesListOptions,
  FilesDeleteOptions,
  FilesRewriteMode,
} from './types.js';

/**
 * Structural interface for the subset of `@or-sdk/files`'s `Files` we
 * actually call. Lets test fakes satisfy `sdkCtor` without
 * implementing the SDK's full surface (`uploadSystemFileV3`,
 * `getUploadUrl`, the deprecated `uploadFile` legacy variant, etc.).
 */
export interface FilesSdkLike {
  uploadFileV2(
    props: {
      fileName: string;
      prefix?: string;
      fileContent: unknown;
      contentType?: string;
      isPublic?: boolean;
      rewriteMode?: FilesRewriteMode;
      maxFileSize?: number;
      cacheControl?: string;
      expiresAt?: Date | string;
      knownLength?: number;
      waitTillFileAddedInDb?: boolean;
      onUploadProgress?: (event: { loaded: number; total?: number }) => void;
    },
    options?: { signal?: AbortSignal }
  ): Promise<string>;

  getDownloadUrl(
    key: string,
    isPublic: boolean,
    expireMs?: number,
    checkFileExist?: boolean
  ): Promise<string>;

  getFile(prefix: string, isPublic: boolean, attributes?: string): Promise<unknown>;

  getItemsList(treePrefix: string, isPublic?: boolean, attributes?: string): Promise<unknown[]>;

  createFolder(folderName: string, options?: { signal?: AbortSignal }): Promise<void>;

  deleteFile(key: string, isPublic: boolean, abortSignal?: AbortSignal): Promise<void>;

  deleteFolder(key: string, options?: { signal?: AbortSignal }): Promise<void>;

  addTtl(key: string, isPublic: boolean, expiresAt: Date | string): Promise<void>;
  updateTtl(key: string, isPublic: boolean, newExpiresAt: Date | string): Promise<void>;
  deleteTtl(key: string, isPublic: boolean): Promise<void>;

  changePrivacy(
    key: string,
    newPrivacy: 'private' | 'public',
    isPublic: boolean
  ): Promise<void>;
}

export interface SdkFilesClientConfig {
  /** Token getter -- returns the user's mult cookie, or empty string. */
  token: () => string;
  /** Discovery service base URL. */
  discoveryUrl: string;
  /** OneReach accountId getter -- null when signed-out. */
  accountId: () => string | null;
  /** Optional SDK constructor override (for tests). */
  sdkCtor?: new (params: {
    token: () => string;
    discoveryUrl: string;
    accountId?: string;
  }) => FilesSdkLike;
  /** Optional logger -- defaults to silent. */
  logger?: (level: 'info' | 'warn' | 'error', message: string, data?: unknown) => void;
  /** Optional span emitter (ADR-030). */
  spanEmitter?: (name: string, data?: unknown) => Span;
  /**
   * Optional account-scoped token supplier, awaited before every op.
   * When it resolves a non-null token, that value is used as the SDK
   * bearer INSTEAD of `token()` -- the Files service rejects raw mult
   * cookies for account-scoped writes ("Cross account requests allowed
   * to SUPER_ADMIN only"), so production wires `FilesTokenMinter.ensure`
   * here. Null falls back to `token()` (signed-out flows keep their
   * canonical no-account error). See `token-minter.ts`.
   */
  ensureToken?: () => Promise<string | null>;
  /** Called when an op fails 401/403 so a cached mint can be dropped. */
  onAuthRejected?: () => void;
}

/**
 * Authenticated, per-user Files transport. Same construction shape as
 * `SdkKVClient`. Consumers go through `getFilesApi()` in `./api.ts`.
 *
 * @internal
 */
export class SdkFilesClient {
  private readonly token: () => string;
  private readonly discoveryUrl: string;
  private readonly getAccountId: () => string | null;
  private readonly log: NonNullable<SdkFilesClientConfig['logger']>;
  private readonly spanEmitter: NonNullable<SdkFilesClientConfig['spanEmitter']> | null;
  private readonly sdkCtor: NonNullable<SdkFilesClientConfig['sdkCtor']> | null;
  private sdk: FilesSdkLike | null = null;
  private sdkForAccountId: string | null = null;
  private readonly ensureToken: (() => Promise<string | null>) | null;
  private readonly onAuthRejected: (() => void) | null;
  /** Last minted account-scoped token; wins over `token()` when set. */
  private mintedToken: string | null = null;

  constructor(config: SdkFilesClientConfig) {
    this.token = config.token;
    this.ensureToken = config.ensureToken ?? null;
    this.onAuthRejected = config.onAuthRejected ?? null;
    this.discoveryUrl = config.discoveryUrl;
    this.getAccountId = config.accountId;
    this.log =
      config.logger ??
      ((): void => {
        /* default: silent */
      });
    this.spanEmitter = config.spanEmitter ?? null;
    this.sdkCtor = config.sdkCtor ?? null;
  }

  /**
   * Upload a file. Returns the full download URL (the same shape the
   * SDK returns from `uploadFileV2`). Idempotent at the key level: a
   * second upload to the same prefix+name overwrites unless
   * `rewriteMode: 'prevent-rewrite'`.
   */
  async upload(
    prefix: string,
    fileName: string,
    content: FilesContent,
    options: FilesUploadOptions = {}
  ): Promise<string> {
    this.assertNonEmpty(fileName, 'fileName');
    // The SDK's uploadFileV2 joins `prefix + fileName` by PLAIN
    // CONCATENATION — a prefix without a trailing slash stores the
    // object at `lite-spaces/assets<name>` while composeKey (and every
    // reader) expects `lite-spaces/assets/<name>`, making the file
    // unreadable forever. Normalize here so the stored key and the
    // composed key always agree. (Driven-release-pass finding,
    // 2026-08-05: first-ever GSX read-back 404'd on exactly this.)
    const sdkPrefix = prefix !== '' && !prefix.endsWith('/') ? `${prefix}/` : prefix;
    return this.runRequest('upload', this.composeKey(prefix, fileName), async () => {
      const sdk = this.getSdk();
      const onProgress = options.onProgress;
      const props: Parameters<FilesSdkLike['uploadFileV2']>[0] = {
        fileName,
        ...(sdkPrefix !== '' ? { prefix: sdkPrefix } : {}),
        fileContent: content,
        contentType: options.contentType ?? 'application/octet-stream',
        isPublic: wantsPublicBucket(options),
        ...(options.rewriteMode !== undefined ? { rewriteMode: options.rewriteMode } : {}),
        ...(options.maxFileSize !== undefined ? { maxFileSize: options.maxFileSize } : {}),
        ...(options.cacheControl !== undefined ? { cacheControl: options.cacheControl } : {}),
        ...(options.expiresAt !== undefined ? { expiresAt: options.expiresAt } : {}),
        ...(options.waitTillFileAddedInDb !== undefined
          ? { waitTillFileAddedInDb: options.waitTillFileAddedInDb }
          : {}),
        ...(onProgress !== undefined
          ? {
              onUploadProgress: (e: { loaded: number; total?: number }) =>
                onProgress(e.loaded, e.total ?? 0),
            }
          : {}),
      };
      return await sdk.uploadFileV2(props);
    });
  }

  /**
   * Get a signed download URL. Public files: long-lived; private:
   * scoped to `expiresMs` (default ~15 min, set by the SDK).
   */
  async getDownloadUrl(key: string, options: FilesDownloadOptions = {}): Promise<string> {
    this.assertNonEmpty(key, 'key');
    return this.runRequest('download', key, async () => {
      const sdk = this.getSdk();
      const isPublic = wantsPublicBucket(options);
      return await sdk.getDownloadUrl(key, isPublic, options.expiresMs);
    });
  }

  /**
   * Convenience: download the file's bytes. Implemented as
   * `getDownloadUrl + fetch` so the SDK doesn't have to grow a method
   * for it.
   */
  async download(key: string, options: FilesDownloadOptions = {}): Promise<ArrayBuffer> {
    const url = await this.getDownloadUrl(key, options);
    const res = await fetch(url);
    if (!res.ok) {
      throw new FilesError({
        code: res.status === 404 ? FILES_ERROR_CODES.NOT_FOUND : FILES_ERROR_CODES.HTTP,
        message: `Files download failed: HTTP ${res.status}`,
        status: res.status,
        context: { op: 'download', key },
        remediation: filesHttpRemediation(res.status),
      });
    }
    return await res.arrayBuffer();
  }

  /**
   * Read a single file's metadata, or null if the key doesn't exist.
   * Equivalent to the SDK's `getFile` but soft-fails 404 to null
   * (mirrors `kv.get`'s "missing key returns null" contract).
   */
  async get(key: string, options: FilesDownloadOptions = {}): Promise<FilesItem | null> {
    this.assertNonEmpty(key, 'key');
    return this.runRequest('get', key, async () => {
      const sdk = this.getSdk();
      const isPublic = wantsPublicBucket(options);
      try {
        const raw = await sdk.getFile(key, isPublic);
        return normalizeFileItem(raw);
      } catch (err) {
        if (isNotFoundError(err)) return null;
        throw err;
      }
    });
  }

  /**
   * List items under a prefix. Returns the items as `FilesItem[]`.
   * Empty prefix lists from the bucket root.
   */
  async list(prefix: string, options: FilesListOptions = {}): Promise<FilesItem[]> {
    return this.runRequest('list', prefix, async () => {
      const sdk = this.getSdk();
      const isPublic = wantsPublicBucket(options);
      const raw = await sdk.getItemsList(prefix, isPublic);
      const items: FilesItem[] = [];
      for (const item of Array.isArray(raw) ? raw : []) {
        const normalized = normalizeFileItem(item);
        if (normalized !== null) items.push(normalized);
      }
      return items;
    });
  }

  /**
   * Create a folder. Folder paths look like `foo/bar/`. The SDK
   * accepts a slash-suffixed name; we don't impose that here.
   */
  async createFolder(folderName: string): Promise<void> {
    this.assertNonEmpty(folderName, 'folderName');
    return this.runRequest('createFolder', folderName, async () => {
      const sdk = this.getSdk();
      await sdk.createFolder(folderName);
    });
  }

  /**
   * Delete a single file by key. Soft-fails 404 to a no-op (mirrors
   * `kv.delete`'s contract).
   */
  async delete(key: string, options: FilesDeleteOptions = {}): Promise<void> {
    this.assertNonEmpty(key, 'key');
    return this.runRequest('delete', key, async () => {
      const sdk = this.getSdk();
      const isPublic = wantsPublicBucket(options);
      try {
        await sdk.deleteFile(key, isPublic);
      } catch (err) {
        if (isNotFoundError(err)) return;
        throw err;
      }
    });
  }

  /** Delete a folder and everything underneath it. */
  async deleteFolder(folderKey: string): Promise<void> {
    this.assertNonEmpty(folderKey, 'folderKey');
    return this.runRequest('delete', folderKey, async () => {
      const sdk = this.getSdk();
      try {
        await sdk.deleteFolder(folderKey);
      } catch (err) {
        if (isNotFoundError(err)) return;
        throw err;
      }
    });
  }

  /**
   * Set / update / clear a TTL on a file. `expiresAt` null clears the
   * TTL; otherwise it's added or replaced.
   */
  async setTtl(key: string, expiresAt: string | null, options: FilesDeleteOptions = {}): Promise<void> {
    this.assertNonEmpty(key, 'key');
    return this.runRequest('ttl.set', key, async () => {
      const sdk = this.getSdk();
      const isPublic = wantsPublicBucket(options);
      if (expiresAt === null) {
        await sdk.deleteTtl(key, isPublic);
        return;
      }
      // The SDK has separate add / update calls. Try add first; if
      // the file already has a TTL it will reject and we re-issue
      // as updateTtl.
      try {
        await sdk.addTtl(key, isPublic, expiresAt);
      } catch {
        await sdk.updateTtl(key, isPublic, expiresAt);
      }
    });
  }

  /** Flip a file's privacy in place. */
  async setPrivacy(
    key: string,
    newPrivacy: 'private' | 'public',
    options: FilesDeleteOptions = {}
  ): Promise<void> {
    this.assertNonEmpty(key, 'key');
    return this.runRequest('privacy', key, async () => {
      const sdk = this.getSdk();
      const isPublic = wantsPublicBucket(options);
      await sdk.changePrivacy(key, newPrivacy, isPublic);
    });
  }

  /**
   * Subscribe to typed Files events (ADR-032). Same shape as the
   * KV client's onEvent.
   */
  onEvent(handler: (event: FilesEvent) => void): () => void {
    return getLoggingApi().onEvent('files.*', (ev: EventRecord) => {
      if (isFilesEvent(ev)) {
        handler(ev as unknown as FilesEvent);
      }
    });
  }

  /** @internal -- exposed so tests can verify the SDK was rebuilt on account switch. */
  _resetSdkForTesting(): void {
    this.sdk = null;
    this.sdkForAccountId = null;
  }

  // ─── internals ───────────────────────────────────────────────────────────

  private getSdk(): FilesSdkLike {
    const accountId = this.getAccountId();
    if (typeof accountId !== 'string' || accountId.length === 0) {
      throw new FilesError({
        code: FILES_ERROR_CODES.NOT_AUTHENTICATED,
        message: 'Files requires a signed-in OneReach account.',
        context: { reason: 'no-account' },
        remediation: 'Sign in to OneReach (Settings -> Account) and try again.',
      });
    }
    if (this.sdk !== null && this.sdkForAccountId === accountId) return this.sdk;
    if (this.sdkCtor !== null) {
      this.sdk = new this.sdkCtor({
        token: () => this.mintedToken ?? this.token(),
        discoveryUrl: this.discoveryUrl,
        accountId,
      });
    } else {
      // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
      const { Files } = require('@or-sdk/files') as {
        Files: new (params: {
          token: () => string;
          discoveryUrl: string;
          accountId?: string;
        }) => FilesSdkLike;
      };
      this.sdk = new Files({
        token: () => this.mintedToken ?? this.token(),
        discoveryUrl: this.discoveryUrl,
        accountId,
      });
    }
    this.sdkForAccountId = accountId;
    return this.sdk;
  }

  private async runRequest<T>(op: string, key: string | undefined, fn: () => Promise<T>): Promise<T> {
    const span = this.spanEmitter?.(`files.${op}`, key !== undefined ? { key } : undefined);
    try {
      // Account-scoped bearer (see token-minter.ts). Resolved before
      // the op so the SDK's token getter reads a fresh value; a null
      // result falls back to the raw binding token. Minting is an
      // ENHANCEMENT — account-scoped writes need it, reads work on the
      // raw binding token — so a mint outage (unreachable mint host)
      // must not fail thumbnails/previews/downloads: swallow and let
      // the files service itself be the judge.
      if (this.ensureToken !== null) {
        try {
          this.mintedToken = await this.ensureToken();
        } catch {
          this.mintedToken = null;
        }
      }
      const result = await fn();
      this.log('info', `files-client: ${op} ok`, { key });
      span?.finish();
      return result;
    } catch (err) {
      const wrapped = this.normalizeError(err, op, key);
      if (wrapped.status === 401 || wrapped.status === 403) {
        // A stale/revoked minted token: drop it so the next op re-mints.
        this.mintedToken = null;
        this.onAuthRejected?.();
      }
      this.log('error', `files-client: ${op} failed`, {
        key,
        code: wrapped.code,
        status: wrapped.status,
      });
      span?.fail(wrapped);
      throw wrapped;
    }
  }

  private assertNonEmpty(value: unknown, field: string): void {
    if (typeof value !== 'string' || value.length === 0) {
      throw new FilesError({
        code: FILES_ERROR_CODES.INVALID_INPUT,
        message: `${field} must be a non-empty string`,
        context: { field, value: typeof value === 'string' ? value : String(value) },
        remediation: 'Provide a valid file key or folder name.',
      });
    }
  }

  private composeKey(prefix: string, fileName: string): string {
    if (prefix === '') return fileName;
    return prefix.endsWith('/') ? `${prefix}${fileName}` : `${prefix}/${fileName}`;
  }

  private normalizeError(err: unknown, op: string, key?: string): FilesError {
    if (err instanceof FilesError) return err;
    const e = err as {
      message?: string;
      response?: { status?: number };
      code?: string;
    };
    const status = typeof e?.response?.status === 'number' ? e.response.status : undefined;
    const message = typeof e?.message === 'string' ? e.message : `files ${op} failed`;
    const baseContext: Record<string, unknown> = { op, ...(key !== undefined ? { key } : {}) };

    if (status === 404) {
      return new FilesError({
        code: FILES_ERROR_CODES.NOT_FOUND,
        message: `Files ${op}: not found`,
        status,
        context: baseContext,
        remediation: 'Check that the key exists and is in the bucket you queried (public vs private).',
        cause: err,
      });
    }
    if (status === 409) {
      return new FilesError({
        code: FILES_ERROR_CODES.ALREADY_EXISTS,
        message: `Files ${op}: a file already exists at this key`,
        status,
        context: baseContext,
        remediation: 'Use rewriteMode: "rewrite" or pick a different name.',
        cause: err,
      });
    }
    if (status === 413) {
      return new FilesError({
        code: FILES_ERROR_CODES.TOO_LARGE,
        message: `Files ${op}: payload exceeded the configured maxFileSize`,
        status,
        context: baseContext,
        remediation: 'Lower the file size or raise maxFileSize.',
        cause: err,
      });
    }
    if (typeof status === 'number') {
      return new FilesError({
        code: FILES_ERROR_CODES.HTTP,
        message: `Files ${op} HTTP ${status}: ${message}`,
        status,
        context: baseContext,
        remediation: filesHttpRemediation(status),
        cause: err,
      });
    }
    return new FilesError({
      code: FILES_ERROR_CODES.NETWORK,
      message: `Files ${op} network error: ${message}`,
      context: baseContext,
      remediation: 'Check your network connection (DNS, VPN, captive portal).',
      cause: err,
    });
  }
}

/**
 * Which bucket an operation targets. Private unless the caller passed a
 * literal `true`.
 *
 * This deliberately inverts the platform default. The OneReach Files
 * docs state: "If no preference is specified by default, the file is
 * set to public." So an omitted flag would publish — every call site in
 * this client therefore resolves the bucket through here.
 *
 * Strict `=== true`, not `?? false`: `??` only substitutes for
 * null/undefined, so a string `'true'` (or `'false'`, which is truthy!)
 * would sail through to the SDK and be read as public. Values reach
 * this client across IPC and JSON boundaries that erase types, so the
 * check has to survive a non-boolean arriving where a boolean was
 * declared. Publishing a user's file is the failure mode; refusing to
 * publish is the safe one.
 */
export function wantsPublicBucket(options: { isPublic?: boolean }): boolean {
  return options.isPublic === true;
}

function isNotFoundError(err: unknown): boolean {
  const e = err as { response?: { status?: number } };
  return e?.response?.status === 404;
}

function filesHttpRemediation(status: number): string {
  if (status === 401 || status === 403) {
    return 'OneReach rejected the request. Sign out and back in to refresh the token.';
  }
  if (status === 404) {
    return 'The file or folder was not found.';
  }
  if (status === 413) {
    return 'The file is too large for the configured limit.';
  }
  if (status === 429) {
    return 'OneReach is rate-limiting requests. Wait a few seconds and try again.';
  }
  if (status >= 500) {
    return 'OneReach Files returned a server error. Usually transient -- retry.';
  }
  return 'See OneReach Files docs for the request shape.';
}

/**
 * Coerce the SDK's `FileItem` (or a raw response object) into our
 * stable `FilesItem` shape. Tolerant of missing fields so we don't
 * crash on minor SDK schema drift.
 */
function normalizeFileItem(raw: unknown): FilesItem | null {
  if (raw === null || typeof raw !== 'object') return null;
  const v = raw as Record<string, unknown>;
  const key = typeof v['key'] === 'string' ? v['key'] : null;
  if (key === null) return null;
  const isPublic = v['isPublic'] === true;
  const size = typeof v['size'] === 'number' ? v['size'] : 0;
  const contentType = typeof v['contentType'] === 'string' ? v['contentType'] : 'application/octet-stream';
  const parentFolder = typeof v['parentFolder'] === 'string' ? v['parentFolder'] : '';
  const downloadUrl = typeof v['downloadUrl'] === 'string' ? v['downloadUrl'] : '';
  return {
    key,
    isPublic,
    size,
    contentType,
    parentFolder,
    lastModified: toIsoOrNull(v['lastModified'] ?? v['updatedAt']),
    ttl: toIsoOrNull(v['ttl']),
    downloadUrl,
  };
}

function toIsoOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') {
    const d = new Date(value);
    return Number.isFinite(d.getTime()) ? d.toISOString() : null;
  }
  if (typeof value === 'number') {
    const d = new Date(value);
    return Number.isFinite(d.getTime()) ? d.toISOString() : null;
  }
  return null;
}
