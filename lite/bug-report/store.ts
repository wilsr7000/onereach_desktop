/**
 * Bug-report store -- KV-only.
 *
 * Per the kernel direction (no local files), all reads and writes go to
 * the Edison KV flow. There is no file fallback. If KV is unreachable,
 * operations surface the error to the caller (modal shows "Save failed"
 * etc.) and the user retries.
 *
 * This intentionally drops the dual-store complexity that used to live
 * here. The trade-off is that operations require network. Acceptable for
 * the kernel because internal users are typically on a stable network
 * and a simpler store is easier to reason about.
 */

import type { BugReportPayload, BugReportStatus } from './capture.js';
import { migrateLegacyPayload } from './capture.js';
import { redact } from '../bug-report-redaction-patterns.js';
import type { RedactionBucket } from '../bug-report-redaction-patterns.js';
import { getKVApi, KVError } from '../kv/api.js';
import type { KVApi } from '../kv/api.js';
import { LiteError } from '../errors.js';
import type { LiteErrorOptions } from '../errors.js';
import type { Span } from '../logging/events.js';
import { getLoggingApi } from '../logging/api.js';
import { isBugReportEvent, type BugReportEvent } from './events.js';

export const KV_COLLECTION = 'lite-bugs';

/**
 * Stable error codes thrown by the bug-report module. See
 * `lite/bug-report/README.md` "Error catalog" for full descriptions.
 */
export const BUG_REPORT_ERROR_CODES = {
  /** `save()` could not write to KV. */
  SAVE_FAILED: 'BR_SAVE_FAILED',
  /** `read()` was given an id that doesn't resolve to a stored report. */
  NOT_FOUND: 'BR_NOT_FOUND',
  /** KV returned a value that doesn't deserialize as a BugReportPayload. */
  BAD_PAYLOAD: 'BR_BAD_PAYLOAD',
} as const;

export type BugReportErrorCode =
  (typeof BUG_REPORT_ERROR_CODES)[keyof typeof BUG_REPORT_ERROR_CODES];

export interface BugReportErrorOptions extends Omit<LiteErrorOptions, 'code'> {
  code: BugReportErrorCode;
}

/**
 * Structured error from the bug-report module. Always extends
 * `LiteError`, so consumers can catch via `instanceof LiteError`
 * (generic) or `instanceof BugReportError` (module-specific).
 *
 * See `lite/bug-report/README.md` for the full error catalog.
 */
export class BugReportError extends LiteError {
  constructor(options: BugReportErrorOptions) {
    const baseOptions: LiteErrorOptions = {
      code: options.code,
      message: options.message,
      ...(options.context !== undefined ? { context: options.context } : {}),
      ...(options.remediation !== undefined ? { remediation: options.remediation } : {}),
      ...(options.cause !== undefined ? { cause: options.cause } : {}),
    };
    super(baseOptions);
    this.name = 'BugReportError';
  }
}

export interface BugReportSummary {
  /** Synthetic identifier `kv:<timestamp>` -- decoded by `read()`. */
  filePath: string;
  filename: string;
  timestamp: string;
  version: string;
  descriptionPreview: string;
  redactionBucket: RedactionBucket;
  redactionTotalCount: number;
  bytes: number;
  status: BugReportStatus;
  hasNotes: boolean;
}

export interface SaveResult {
  /** Whether the KV write succeeded. */
  kvWritten: boolean;
  /** Error message if the KV write failed. */
  kvError: string | null;
}

export interface UpdateResult {
  payload: BugReportPayload;
  kvUpdated: boolean;
  kvError: string | null;
}

export interface DeleteResult {
  kvDeleted: boolean;
  kvError: string | null;
}

export interface StoreConfig {
  /** Optional KV API override (for tests). */
  kvApi?: KVApi;
  /** Optional logger. */
  logger?: (level: 'info' | 'warn' | 'error', message: string, data?: unknown) => void;
  /**
   * Optional span emitter -- when provided, each store op
   * (`save/list/read/update/delete`) wraps its work in a
   * `bug-report.<op>.start` / `.finish` / `.fail` span. ADR-026.
   * The default config in `bug-report/api.ts` wires this to
   * `getLoggingApi().start()`. Tests can pass a stub or omit.
   */
  spanEmitter?: (name: string, data?: unknown) => Span;
}

/**
 * Module-internal class. Other lite modules MUST NOT import this directly --
 * use `getBugReportApi()` from `./api.ts` instead (rule 11 in
 * lite/LITE-RULES.md, ADR-019 in lite/DECISIONS.md). The class is exported
 * only because TypeScript without a barrel layer cannot truly hide it; the
 * discipline is enforced by the rule + dep-cruiser (Phase 0b).
 *
 * If the choice of backing implementation ever changes (caching layer,
 * in-memory variant, alternate cloud sink), only `api.ts` updates --
 * external callers are unaffected.
 *
 * @internal
 */
export class BugReportStore {
  private readonly kv: KVApi;
  private readonly log: NonNullable<StoreConfig['logger']>;
  private readonly spanEmitter: NonNullable<StoreConfig['spanEmitter']> | null;

  constructor(config: StoreConfig = {}) {
    this.kv = config.kvApi ?? getKVApi();
    this.log =
      config.logger ??
      ((): void => {
        /* default: silent */
      });
    this.spanEmitter = config.spanEmitter ?? null;
  }

  /**
   * Save a new bug report to KV. Throws if the KV write fails.
   */
  async save(payload: BugReportPayload): Promise<SaveResult> {
    const span = this.spanEmitter?.('bug-report.save', { timestamp: payload.timestamp });
    try {
      await this.kv.set(KV_COLLECTION, payload.timestamp, payload);
      this.log('info', 'store: kv save ok', { key: payload.timestamp });
      span?.finish({ kvWritten: true });
      return { kvWritten: true, kvError: null };
    } catch (err) {
      const message = (err as Error).message;
      this.log('error', 'store: kv save failed', { error: message });
      const wrapped = new BugReportError({
        code: BUG_REPORT_ERROR_CODES.SAVE_FAILED,
        message: `Bug report save failed: ${message}`,
        context: {
          op: 'save',
          timestamp: payload.timestamp,
          collection: KV_COLLECTION,
          ...(err instanceof KVError ? { kvCode: err.code, kvStatus: err.status } : {}),
        },
        remediation:
          err instanceof KVError
            ? err.remediation
            : 'Check your network connection and try again. The report was not stored.',
        cause: err,
      });
      span?.fail(wrapped);
      throw wrapped;
    }
  }

  /**
   * List all bug reports from KV. Returns empty list (rather than
   * throwing) on KV failure, so the modal can render an empty state
   * rather than an error.
   */
  async list(): Promise<BugReportSummary[]> {
    const span = this.spanEmitter?.('bug-report.list');
    try {
      const records = await this.kv.list(KV_COLLECTION);
      const summaries = records
        .map((r) => this.summaryFromRecord(r.value))
        .filter((s): s is BugReportSummary => s !== null);
      summaries.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
      this.log('info', 'store: kv list ok', { count: summaries.length });
      span?.finish({ count: summaries.length });
      return summaries;
    } catch (err) {
      if (err instanceof KVError) {
        this.log('warn', 'store: kv list failed', { error: err.message });
      } else {
        this.log('error', 'store: unexpected list error', {
          error: (err as Error).message,
        });
      }
      // Soft-fail: emit fail event but don't propagate -- the modal
      // expects [] on KV failure so it can render an empty state.
      span?.fail(err);
      return [];
    }
  }

  /**
   * Read a single report by its identifier. Accepts either:
   *   - A bare timestamp (the KV key)
   *   - A synthetic `kv:<timestamp>` identifier (as produced by list())
   */
  async read(idOrPath: string): Promise<BugReportPayload> {
    const key = idOrPath.startsWith('kv:') ? idOrPath.slice(3) : idOrPath;
    const span = this.spanEmitter?.('bug-report.read', { key });
    try {
      const value = await this.kv.get(KV_COLLECTION, key);
      if (value === null) {
        const notFoundErr = new BugReportError({
          code: BUG_REPORT_ERROR_CODES.NOT_FOUND,
          message: `Bug report not found: ${key}`,
          context: { op: 'read', idOrPath, key, collection: KV_COLLECTION },
          remediation:
            'The report may have been deleted, or the identifier is wrong. Refresh the list and try again.',
        });
        span?.fail(notFoundErr);
        throw notFoundErr;
      }
      if (typeof value !== 'object') {
        const badPayloadErr = new BugReportError({
          code: BUG_REPORT_ERROR_CODES.BAD_PAYLOAD,
          message: `Bug report ${key} returned non-object payload (got ${typeof value})`,
          context: {
            op: 'read',
            key,
            collection: KV_COLLECTION,
            actualType: typeof value,
          },
          remediation:
            'The stored value is corrupt or written by an incompatible client. Delete the record and re-file the report.',
        });
        span?.fail(badPayloadErr);
        throw badPayloadErr;
      }
      // Migrate in case KV holds a legacy payload (older client wrote it).
      const migrated = migrateLegacyPayload(value as Record<string, unknown>);
      span?.finish();
      return migrated;
    } catch (err) {
      // Catch path covers errors thrown by `this.kv.get` (KVError) too.
      if (!(err instanceof BugReportError)) {
        span?.fail(err);
      }
      throw err;
    }
  }

  /**
   * Update mutable fields on an existing report. Notes are redacted on
   * save. Throws if the report cannot be read or written.
   */
  async update(timestamp: string, updates: { status?: BugReportStatus; notes?: string }): Promise<UpdateResult> {
    const span = this.spanEmitter?.('bug-report.update', {
      timestamp,
      hasStatusChange: updates.status !== undefined,
      hasNotesChange: updates.notes !== undefined,
    });
    // Read current state, apply mutations, write back.
    let current: BugReportPayload;
    try {
      current = await this.read(timestamp);
    } catch (err) {
      span?.fail(err);
      throw err;
    }
    const redactedNotes = updates.notes !== undefined ? redact(updates.notes).text : undefined;
    const next: BugReportPayload = {
      ...current,
      ...(updates.status !== undefined ? { status: updates.status } : {}),
      ...(redactedNotes !== undefined ? { notes: redactedNotes } : {}),
      lastModified: new Date().toISOString(),
    };
    try {
      await this.kv.set(KV_COLLECTION, timestamp, next);
      this.log('info', 'store: kv update ok', { timestamp });
      span?.finish({ kvUpdated: true });
      return { payload: next, kvUpdated: true, kvError: null };
    } catch (err) {
      // Soft-fail: surface a friendly message but don't throw, so the
      // modal can render an inline error and the user can retry.
      const friendly =
        err instanceof LiteError ? err.formatForUser() : (err as Error).message;
      this.log('error', 'store: kv update failed', {
        timestamp,
        error: friendly,
        ...(err instanceof LiteError ? { code: err.code } : {}),
      });
      span?.fail(err);
      return { payload: next, kvUpdated: false, kvError: friendly };
    }
  }

  /**
   * Delete a report from KV. Soft failure: returns kvDeleted=false on
   * failure rather than throwing, so the UI can render a graceful error.
   */
  async delete(timestamp: string): Promise<DeleteResult> {
    const span = this.spanEmitter?.('bug-report.delete', { timestamp });
    try {
      await this.kv.delete(KV_COLLECTION, timestamp);
      this.log('info', 'store: kv delete ok', { timestamp });
      span?.finish({ kvDeleted: true });
      return { kvDeleted: true, kvError: null };
    } catch (err) {
      const friendly =
        err instanceof LiteError ? err.formatForUser() : (err as Error).message;
      this.log('warn', 'store: kv delete failed', {
        timestamp,
        error: friendly,
        ...(err instanceof LiteError ? { code: err.code } : {}),
      });
      span?.fail(err);
      return { kvDeleted: false, kvError: friendly };
    }
  }

  /**
   * Subscribe to typed bug-report events (ADR-032). Filters
   * `getLoggingApi().onEvent('bug-report.*', ...)` and casts each
   * matching record to `BugReportEvent`.
   */
  onEvent(handler: (event: BugReportEvent) => void): () => void {
    return getLoggingApi().onEvent('bug-report.*', (ev) => {
      if (isBugReportEvent(ev)) {
        handler(ev as unknown as BugReportEvent);
      }
    });
  }

  /**
   * Convert a KV record value into a summary. Returns null if the value
   * doesn't look like a valid BugReportPayload (defensive -- KV may hold
   * orphaned records from older schemas).
   */
  private summaryFromRecord(value: unknown): BugReportSummary | null {
    if (typeof value !== 'object' || value === null) return null;
    const v = value as Partial<BugReportPayload>;
    if (
      typeof v.schemaVersion !== 'number' ||
      typeof v.timestamp !== 'string' ||
      typeof v.version !== 'string' ||
      typeof v.description !== 'string'
    ) {
      return null;
    }
    const counts = v.redactionTelemetry?.countsByKind ?? {};
    const totalCount = Object.values(counts).reduce((acc, c) => acc + c, 0);
    return {
      filePath: `kv:${v.timestamp}`,
      filename: `${v.timestamp}.json`,
      timestamp: v.timestamp,
      version: v.version,
      descriptionPreview: v.description.slice(0, 100),
      redactionBucket: v.redactionTelemetry?.bucket ?? 'none',
      redactionTotalCount: totalCount,
      bytes: JSON.stringify(v).length,
      status: v.status === 'resolved' ? 'resolved' : 'open',
      hasNotes: typeof v.notes === 'string' && v.notes.length > 0,
    };
  }
}
