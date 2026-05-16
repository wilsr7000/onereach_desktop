/**
 * Spaces module -- structured errors.
 *
 * Mirrors the shape of `FilesError` (`lite/files/errors.ts`) and
 * `KVError`: every failure surfaces as a `SpacesError` with a stable
 * code, a structured context object, an optional remediation hint, and
 * a chained `cause`.
 *
 * @internal
 */

import { LiteError } from '../errors.js';
import type { LiteErrorOptions } from '../errors.js';

/**
 * Stable error codes thrown by the spaces module. See
 * `lite/spaces/README.md` "Error catalog" for full descriptions.
 */
export const SPACES_ERROR_CODES = {
  /** No `mult` token / no active account -- caller is signed out. */
  NOT_AUTHENTICATED: 'SPACES_NOT_AUTHENTICATED',
  /** The requested space or item doesn't exist (or is filtered out by ACL). */
  NOT_FOUND: 'SPACES_NOT_FOUND',
  /** Caller lacks permission to read or mutate the target resource. */
  FORBIDDEN: 'SPACES_FORBIDDEN',
  /** Underlying Neon/Cypher call failed (transient or syntax). */
  CYPHER: 'SPACES_CYPHER',
  /** Underlying network failure (DNS / TCP / TLS / fetch reject). */
  NETWORK: 'SPACES_NETWORK',
  /** Caller passed an invalid argument (empty id, bad limit, etc.). */
  INVALID_INPUT: 'SPACES_INVALID_INPUT',
  /** Spaces SDK called before `initSpaces()` ran. */
  NOT_INITIALIZED: 'SPACES_NOT_INITIALIZED',
  /**
   * `create()` or `rename()` collided with an existing Space name in the
   * same account. Names are unique per account; renderers surface this
   * as "A space called 'X' already exists -- try a different name."
   */
  DUPLICATE_NAME: 'SPACES_DUPLICATE_NAME',
  /**
   * Hard `delete({ soft: false })` was attempted on a Space that still
   * contains items. Soft-delete (the default) keeps the items reachable
   * via Uncategorized; hard-delete refuses so data can't be orphaned
   * accidentally. Caller should soft-delete or move items out first.
   */
  DELETE_NON_EMPTY: 'SPACES_DELETE_NON_EMPTY',
} as const;

export type SpacesErrorCode =
  (typeof SPACES_ERROR_CODES)[keyof typeof SPACES_ERROR_CODES];

export interface SpacesErrorOptions extends Omit<LiteErrorOptions, 'code'> {
  code: SpacesErrorCode;
  /** HTTP status when the failure originated from a server response. */
  status?: number;
}

/**
 * Structured error from the spaces module. Always extends `LiteError`,
 * so consumers can catch via `instanceof LiteError` (generic) or
 * `instanceof SpacesError` (module-specific).
 */
export class SpacesError extends LiteError {
  public readonly status: number | undefined;

  constructor(options: SpacesErrorOptions) {
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
    this.name = 'SpacesError';
    this.status = options.status;
  }
}
