/**
 * Files module -- shared types.
 *
 * The files module wraps `@or-sdk/files` so other Lite modules can
 * upload, download, list, and delete files in OneReach storage
 * without importing the SDK. Per-user isolation is enforced
 * server-side: every request carries the user's `mult` token and
 * the active `accountId`.
 *
 * Public types live here so both `api.ts` and the internal store
 * reference one source of truth.
 */

/** A single file or folder entry returned by `list` / `get`. */
export interface FilesItem {
  /** Full key (path) inside the account's bucket. */
  key: string;
  /** True for files in the public bucket, false for the private one. */
  isPublic: boolean;
  /** Bytes; 0 for folders. */
  size: number;
  /** MIME type the file was uploaded with (best-effort). */
  contentType: string;
  /** The folder this item lives in. */
  parentFolder: string;
  /** ISO timestamp of last write, or null if unknown. */
  lastModified: string | null;
  /** ISO timestamp the entry expires at, or null when no TTL is set. */
  ttl: string | null;
  /**
   * Download URL. For a PRIVATE file this is a signed link the platform
   * documents as valid for 24 hours; public files are hot-linkable with
   * no stated expiry. Re-mint with `getDownloadUrl` rather than
   * persisting this anywhere.
   */
  downloadUrl: string;
}

/** Acceptable file content shapes for `upload`. */
export type FilesContent = ArrayBuffer | Uint8Array | Buffer | Blob | string;

/** Mode controlling what happens when a file at the same key already exists. */
export type FilesRewriteMode = 'rewrite' | 'prevent-rewrite';

/** Options for `upload`. */
export interface FilesUploadOptions {
  /** MIME type to advertise. Defaults to `application/octet-stream`. */
  contentType?: string;
  /**
   * True writes to the public bucket; anything else writes private.
   *
   * NOTE: this INVERTS the platform default. OneReach Files documents
   * "if no preference is specified by default, the file is set to
   * public" — this client resolves an omitted (or non-boolean) flag to
   * private instead, so forgetting it is safe rather than publishing.
   */
  isPublic?: boolean;
  /** What to do when a file at the same key already exists. */
  rewriteMode?: FilesRewriteMode;
  /** Reject uploads larger than this (bytes). */
  maxFileSize?: number;
  /** ISO timestamp at which the file should be auto-deleted. */
  expiresAt?: string;
  /** `Cache-Control` header for the resulting download URL. */
  cacheControl?: string;
  /** Block until the file is queryable via list/get (default false). */
  waitTillFileAddedInDb?: boolean;
  /** Progress callback (0..1). */
  onProgress?: (loaded: number, total: number) => void;
}

/** Options for `getDownloadUrl`. */
export interface FilesDownloadOptions {
  /** True for the public bucket, false (default) for the private one. */
  isPublic?: boolean;
  /** How long the signed URL should be valid (ms). Default ~15 min. */
  expiresMs?: number;
}

/** Options for `list`. */
export interface FilesListOptions {
  /** True lists from the public bucket; false (default) lists private. */
  isPublic?: boolean;
}

/** Options for `delete`. */
export interface FilesDeleteOptions {
  /** True to delete from the public bucket; false (default) for private. */
  isPublic?: boolean;
}
