/**
 * Files module -- structured errors.
 *
 * Mirrors the shape of `KVError` (`lite/kv/client.ts`) and
 * `DiscoveryError` (`lite/discovery/store.ts`): every failure
 * surfaces as a `FilesError` with a stable code, a structured
 * context object, an optional remediation hint, and a chained
 * `cause`.
 *
 * @internal
 */

import { LiteError } from '../errors.js';
import type { LiteErrorOptions } from '../errors.js';

/**
 * Stable error codes thrown by the files module. See
 * `lite/files/README.md` "Error catalog" for full descriptions.
 */
export const FILES_ERROR_CODES = {
  /** No `mult` token / no active account -- caller is signed out. */
  NOT_AUTHENTICATED: 'FILES_NOT_AUTHENTICATED',
  /** The requested file or folder doesn't exist. */
  NOT_FOUND: 'FILES_NOT_FOUND',
  /** Server returned 401 / 403 (token rejected, scope insufficient). */
  HTTP: 'FILES_HTTP',
  /** Underlying network failure (DNS / TCP / TLS). */
  NETWORK: 'FILES_NETWORK',
  /** A `prevent-rewrite` upload found an existing file at the key. */
  ALREADY_EXISTS: 'FILES_ALREADY_EXISTS',
  /** `maxFileSize` exceeded by the upload payload. */
  TOO_LARGE: 'FILES_TOO_LARGE',
  /** Caller passed an invalid argument (empty key, bad TTL, etc.). */
  INVALID_INPUT: 'FILES_INVALID_INPUT',
} as const;

export type FilesErrorCode =
  (typeof FILES_ERROR_CODES)[keyof typeof FILES_ERROR_CODES];

export interface FilesErrorOptions extends Omit<LiteErrorOptions, 'code'> {
  code: FilesErrorCode;
  /** HTTP status when the failure originated from a server response. */
  status?: number;
}

/**
 * Structured error from the files module. Always extends `LiteError`,
 * so consumers can catch via `instanceof LiteError` (generic) or
 * `instanceof FilesError` (module-specific).
 */
export class FilesError extends LiteError {
  public readonly status: number | undefined;

  constructor(options: FilesErrorOptions) {
    const context: Record<string, unknown> = { ...(options.context ?? {}) };
    if (options.status !== undefined) context['status'] = options.status;
    const baseOptions: LiteErrorOptions = {
      code: options.code,
      message: options.message,
      context,
      ...(options.remediation !== undefined ? { remediation: options.remediation } : {}),
      ...(options.cause !== undefined ? { cause: options.cause } : {}),
    };
    super(baseOptions);
    this.name = 'FilesError';
    this.status = options.status;
  }
}
