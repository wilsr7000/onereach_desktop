/**
 * Bug-report store -- KV system-of-record with a local spool (ADR-078).
 *
 * KV (the Edison flow) is the system of record. The local spool exists
 * for exactly one reason: a bug report must NEVER be refusable. The
 * support channel matters most when auth or the network is broken --
 * the KV-only store (2026-08 kernel direction) hard-failed signed-out
 * saves, which killed bug filing precisely when things were going
 * wrong.
 *
 * Shape: `save()` writes the redacted payload to `spoolDir` FIRST, then
 * pushes to KV when a session exists. Reports stranded in the spool
 * (signed out / KV down) drain to KV on the next sign-in, session
 * hydrate, or successful save. `list()`/`read()`/`update()`/`delete()`
 * see spooled reports too, so a signed-out filer still finds their
 * report in the modal.
 *
 * This is a SPOOL, not the old dual-store mirror: a report lives in the
 * spool only until its KV write succeeds, then the file is removed.
 * When `spoolDir` is not configured (legacy tests / standalone usage),
 * the store behaves exactly like the KV-only era, including the
 * signed-out hard fail.
 */

import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
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
  /** Number of attachments (0 when the report predates ADR-045). */
  attachmentCount: number;
}

export interface SaveResult {
  /** Whether the KV write succeeded. */
  kvWritten: boolean;
  /** Error message if the KV write failed. */
  kvError: string | null;
  /**
   * True when the report currently rests in the local spool (ADR-078):
   * saved on this machine, awaiting sync to KV. `kvWritten` and
   * `spooled` are mutually exclusive on a successful save.
   */
  spooled: boolean;
}

export interface UpdateResult {
  payload: BugReportPayload;
  kvUpdated: boolean;
  kvError: string | null;
  /** True when the mutation landed on a spooled (not-yet-synced) report. */
  spooled: boolean;
}

export interface DeleteResult {
  kvDeleted: boolean;
  kvError: string | null;
  /** True when the deletion removed a spooled (not-yet-synced) report. */
  spooled: boolean;
}

export interface DrainResult {
  /** Reports successfully pushed to KV (and removed from the spool). */
  drained: number;
  /** Reports still waiting in the spool after this attempt. */
  remaining: number;
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
  /**
   * Resolver for the active OneReach `accountId`. When `null`, the
   * store treats the user as signed-out: `list()` returns empty,
   * `save()` / `update()` / `delete()` reject with a clear error.
   * Wired in `lite/bug-report/api.ts` to
   * `getAuthApi().getSession('edison')?.accountId ?? null`.
   *
   * If omitted (legacy tests / standalone usage), the store falls
   * back to allowing all operations -- preserves backward compat.
   */
  getActiveAccountId?: () => string | null;
  /**
   * Directory for the local spool (ADR-078). When set, `save()` writes
   * the redacted payload here FIRST and never hard-fails for
   * signed-out/KV reasons; `drainSpool()` pushes spooled reports to KV
   * once a session exists. When omitted (legacy tests / standalone
   * usage), the store is KV-only and signed-out saves reject as they
   * did before the spool.
   */
  spoolDir?: string;
  /**
   * Optional post-save mirror. Called with the redacted payload AFTER a
   * successful KV write, to file the report into the Onereach.ai Lite
   * Bugs Space so it is visible alongside every other kind of work.
   *
   * Deliberately fire-and-report, never fire-and-block: `save()` awaits
   * it but treats ANY rejection as non-fatal and still returns
   * `kvWritten: true`. The KV write is what saved the report; a graph
   * outage must not turn a filed bug into a failed one. Wired in
   * `lite/bug-report/api.ts` to `fileBugReportToGraph`.
   */
  mirrorToGraph?: (payload: BugReportPayload) => Promise<{ filed: boolean; error?: string }>;
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
  private readonly getActiveAccountId: NonNullable<StoreConfig['getActiveAccountId']> | null;
  private readonly mirrorToGraph: NonNullable<StoreConfig['mirrorToGraph']> | null;
  private readonly spoolDir: string | null;
  /** In-flight guard: overlapping drains would double-mirror to graph. */
  private draining = false;

  constructor(config: StoreConfig = {}) {
    this.kv = config.kvApi ?? getKVApi();
    this.log =
      config.logger ??
      ((): void => {
        /* default: silent */
      });
    this.spanEmitter = config.spanEmitter ?? null;
    this.getActiveAccountId = config.getActiveAccountId ?? null;
    this.mirrorToGraph = config.mirrorToGraph ?? null;
    this.spoolDir = config.spoolDir ?? null;
  }

  // ─── Spool primitives (ADR-078) ─────────────────────────────────────

  /**
   * Spool filename for a timestamp key. Colons are legal on APFS but
   * not on Windows -- sanitize so the spool stays portable. The file's
   * OWN `payload.timestamp` is the source of truth; filenames are never
   * parsed back.
   */
  private spoolFileFor(timestamp: string): string {
    return path.join(this.spoolDir as string, `${timestamp.replace(/:/g, '-')}.json`);
  }

  private async writeSpool(payload: BugReportPayload): Promise<void> {
    await fsp.mkdir(this.spoolDir as string, { recursive: true });
    await fsp.writeFile(this.spoolFileFor(payload.timestamp), JSON.stringify(payload, null, 2), 'utf-8');
  }

  /** All parseable spooled payloads. `[]` when the dir doesn't exist. */
  private async readSpoolPayloads(): Promise<BugReportPayload[]> {
    if (this.spoolDir === null) return [];
    let entries: string[];
    try {
      entries = await fsp.readdir(this.spoolDir);
    } catch {
      return [];
    }
    const out: BugReportPayload[] = [];
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      try {
        const raw = await fsp.readFile(path.join(this.spoolDir, entry), 'utf-8');
        const value = JSON.parse(raw) as Record<string, unknown>;
        out.push(migrateLegacyPayload(value));
      } catch (err) {
        // Corrupt spool file: log, keep the file (evidence), skip it.
        this.log('warn', 'store: unreadable spool file skipped', {
          file: entry,
          error: (err as Error).message,
        });
      }
    }
    return out;
  }

  /** One spooled payload by timestamp key, or null. */
  private async readSpoolPayload(timestamp: string): Promise<BugReportPayload | null> {
    if (this.spoolDir === null) return null;
    try {
      const raw = await fsp.readFile(this.spoolFileFor(timestamp), 'utf-8');
      return migrateLegacyPayload(JSON.parse(raw) as Record<string, unknown>);
    } catch {
      return null;
    }
  }

  private async removeSpoolFile(timestamp: string): Promise<void> {
    if (this.spoolDir === null) return;
    try {
      await fsp.unlink(this.spoolFileFor(timestamp));
    } catch (err) {
      // Non-fatal: the next drain re-uploads (kv.set is idempotent).
      this.log('warn', 'store: spool file removal failed', {
        key: timestamp,
        error: (err as Error).message,
      });
    }
  }

  /**
   * Mirror a saved report into the bugs Space. Swallows EVERYTHING --
   * a rejected promise, a thrown synchronous error, a soft-failed
   * result. By the time this runs the report is already in KV, so the
   * only thing a failure here costs is graph visibility, and the user
   * must still be told their report was filed. Failures are logged so
   * the gap is diagnosable rather than silent.
   */
  private async mirrorToGraphSafely(payload: BugReportPayload): Promise<void> {
    if (this.mirrorToGraph === null) return;
    try {
      const result = await this.mirrorToGraph(payload);
      if (result.filed) {
        this.log('info', 'store: graph mirror ok', { key: payload.timestamp });
      } else {
        this.log('warn', 'store: graph mirror skipped', {
          key: payload.timestamp,
          error: result.error ?? 'unknown',
        });
      }
    } catch (err) {
      this.log('warn', 'store: graph mirror threw', {
        key: payload.timestamp,
        error: (err as Error).message,
      });
    }
  }

  /**
   * True when callers should treat the user as signed-in. When
   * `getActiveAccountId` was not provided (legacy tests), always
   * returns true so existing callers are unaffected.
   */
  private isSignedIn(): boolean {
    if (this.getActiveAccountId === null) return true;
    const accountId = this.getActiveAccountId();
    return typeof accountId === 'string' && accountId.length > 0;
  }

  /**
   * Save a new bug report. Spool-first (ADR-078): the redacted payload
   * lands on local disk before any network is attempted, so a save can
   * only fail when BOTH the spool and KV are unavailable. Signed out
   * with a spool configured, the save succeeds locally
   * (`spooled: true`) and syncs on the next drain.
   *
   * Without a configured spool (legacy KV-only usage): throws when
   * signed out or when the KV write fails, exactly as before.
   */
  async save(payload: BugReportPayload): Promise<SaveResult> {
    const span = this.spanEmitter?.('bug-report.save', { timestamp: payload.timestamp });

    let spooled = false;
    let spoolError: string | null = null;
    if (this.spoolDir !== null) {
      try {
        await this.writeSpool(payload);
        spooled = true;
        this.log('info', 'store: spool save ok', { key: payload.timestamp });
      } catch (err) {
        spoolError = (err as Error).message;
        this.log('warn', 'store: spool write failed', { error: spoolError });
      }
    }

    if (!this.isSignedIn()) {
      if (spooled) {
        span?.finish({ kvWritten: false, spooled: true });
        return { kvWritten: false, kvError: null, spooled: true };
      }
      const wrapped = new BugReportError({
        code: BUG_REPORT_ERROR_CODES.SAVE_FAILED,
        message:
          spoolError !== null
            ? `Bug report save failed: ${spoolError}`
            : 'Cannot save a bug report while signed out.',
        context: {
          op: 'save',
          timestamp: payload.timestamp,
          reason: spoolError !== null ? 'spool-write-failed' : 'signed-out',
        },
        remediation:
          spoolError !== null
            ? 'The local spool could not be written -- check disk space and permissions.'
            : 'Open Settings -> Account and sign in to OneReach.',
      });
      span?.fail(wrapped);
      throw wrapped;
    }

    try {
      await this.kv.set(KV_COLLECTION, payload.timestamp, payload);
      this.log('info', 'store: kv save ok', { key: payload.timestamp });
      if (spooled) await this.removeSpoolFile(payload.timestamp);
      await this.mirrorToGraphSafely(payload);
      span?.finish({ kvWritten: true, spooled: false });
      // Opportunistic backlog drain -- KV just proved reachable, so any
      // stranded signed-out reports can ride along. Never blocks the
      // caller's save.
      if (this.spoolDir !== null) {
        void this.drainSpool().catch(() => {
          /* drain logs its own failures */
        });
      }
      return { kvWritten: true, kvError: null, spooled: false };
    } catch (err) {
      const message = (err as Error).message;
      if (spooled) {
        // The report is safe on disk -- this is a deferred sync, not a
        // failed save. Finish (not fail) the span so dashboards don't
        // count a filed report as an error.
        this.log('warn', 'store: kv save failed -- report kept in local spool', {
          key: payload.timestamp,
          error: message,
        });
        const friendly = err instanceof LiteError ? err.formatForUser() : message;
        span?.finish({ kvWritten: false, spooled: true, kvError: friendly });
        return { kvWritten: false, kvError: friendly, spooled: true };
      }
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
   * Push spooled reports to KV (ADR-078). No-op without a spool, when
   * the spool is empty, or when signed out. Stops on the first KV
   * failure (a down server fails every subsequent write too). Each
   * drained report is mirrored to the graph and its spool file removed.
   * Concurrent calls coalesce: a second drain while one is running
   * reports the pending count without acting.
   */
  async drainSpool(): Promise<DrainResult> {
    if (this.spoolDir === null) return { drained: 0, remaining: 0 };
    const pending = await this.readSpoolPayloads();
    if (pending.length === 0) return { drained: 0, remaining: 0 };
    if (!this.isSignedIn()) return { drained: 0, remaining: pending.length };
    if (this.draining) {
      this.log('info', 'store: spool drain already in flight', { pending: pending.length });
      return { drained: 0, remaining: pending.length };
    }
    this.draining = true;
    const span = this.spanEmitter?.('bug-report.drain', { pending: pending.length });
    let drained = 0;
    try {
      for (const payload of pending) {
        try {
          await this.kv.set(KV_COLLECTION, payload.timestamp, payload);
        } catch (err) {
          const remaining = pending.length - drained;
          this.log('warn', 'store: spool drain stopped on kv failure', {
            error: (err as Error).message,
            drained,
            remaining,
          });
          span?.fail(err, { drained, remaining });
          return { drained, remaining };
        }
        await this.mirrorToGraphSafely(payload);
        await this.removeSpoolFile(payload.timestamp);
        drained++;
      }
      this.log('info', 'store: spool drained', { drained });
      span?.finish({ drained, remaining: 0 });
      return { drained, remaining: 0 };
    } finally {
      this.draining = false;
    }
  }

  /**
   * List all bug reports: KV plus any still-spooled ones (ADR-078).
   * Soft-fails: on KV failure (or signed out) the spooled reports are
   * still returned, so a signed-out filer sees what they filed. Spool
   * entries carry a `spool:<timestamp>` filePath.
   */
  async list(): Promise<BugReportSummary[]> {
    const span = this.spanEmitter?.('bug-report.list');
    const spoolSummaries = (await this.readSpoolPayloads())
      .map((p) => this.summaryFromRecord(p))
      .filter((s): s is BugReportSummary => s !== null)
      .map((s) => ({ ...s, filePath: `spool:${s.timestamp}` }));

    if (!this.isSignedIn()) {
      spoolSummaries.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
      span?.finish({ count: spoolSummaries.length, signedOut: true });
      return spoolSummaries;
    }
    try {
      const records = await this.kv.list(KV_COLLECTION);
      const summaries = records
        .map((r) => this.summaryFromRecord(r.value))
        .filter((s): s is BugReportSummary => s !== null);
      // Merge: a timestamp present in both (mid-drain window) counts
      // once, and KV -- the system of record -- wins.
      const kvKeys = new Set(summaries.map((s) => s.timestamp));
      for (const s of spoolSummaries) {
        if (!kvKeys.has(s.timestamp)) summaries.push(s);
      }
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
      // renders whatever the spool holds (previously always []).
      span?.fail(err);
      spoolSummaries.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
      return spoolSummaries;
    }
  }

  /**
   * Read a single report by its identifier. Accepts:
   *   - A bare timestamp (the KV key)
   *   - A synthetic `kv:<timestamp>` identifier (as produced by list())
   *   - A synthetic `spool:<timestamp>` identifier (ADR-078)
   * The spool is consulted for any form: a just-filed signed-out report
   * must be readable before it ever reaches KV.
   */
  async read(idOrPath: string): Promise<BugReportPayload> {
    const key = idOrPath.startsWith('kv:')
      ? idOrPath.slice(3)
      : idOrPath.startsWith('spool:')
        ? idOrPath.slice(6)
        : idOrPath;
    const span = this.spanEmitter?.('bug-report.read', { key });
    const spoolPayload = await this.readSpoolPayload(key);
    if (spoolPayload !== null && (idOrPath.startsWith('spool:') || !this.isSignedIn())) {
      span?.finish({ spooled: true });
      return spoolPayload;
    }
    if (!this.isSignedIn()) {
      const notFoundErr = new BugReportError({
        code: BUG_REPORT_ERROR_CODES.NOT_FOUND,
        message: `Bug report not found: ${key} (signed out)`,
        context: { op: 'read', idOrPath, key, reason: 'signed-out' },
        remediation: 'Sign in to OneReach (Settings -> Account) to access saved reports.',
      });
      span?.fail(notFoundErr);
      throw notFoundErr;
    }
    try {
      const value = await this.kv.get(KV_COLLECTION, key);
      if (value === null && spoolPayload !== null) {
        // Signed in, not yet drained -- the spool is the only copy.
        span?.finish({ spooled: true });
        return spoolPayload;
      }
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
      // KV unreachable but the report is spooled locally: serve the
      // local copy rather than erroring (ADR-078 offline read).
      if (!(err instanceof BugReportError) && spoolPayload !== null) {
        this.log('warn', 'store: kv read failed -- serving spooled copy', {
          key,
          error: (err as Error).message,
        });
        span?.finish({ spooled: true, kvError: (err as Error).message });
        return spoolPayload;
      }
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
    // Spooled report (ADR-078): mutate the spool file in place -- it
    // hasn't reached KV yet, and the eventual drain uploads the mutated
    // version. Works signed out too.
    const spoolCurrent = await this.readSpoolPayload(timestamp);
    if (spoolCurrent !== null) {
      const redactedSpoolNotes = updates.notes !== undefined ? redact(updates.notes).text : undefined;
      const next: BugReportPayload = {
        ...spoolCurrent,
        ...(updates.status !== undefined ? { status: updates.status } : {}),
        ...(redactedSpoolNotes !== undefined ? { notes: redactedSpoolNotes } : {}),
        lastModified: new Date().toISOString(),
      };
      try {
        await this.writeSpool(next);
        this.log('info', 'store: spool update ok', { timestamp });
        span?.finish({ spooled: true });
        return { payload: next, kvUpdated: false, kvError: null, spooled: true };
      } catch (err) {
        const friendly = (err as Error).message;
        this.log('error', 'store: spool update failed', { timestamp, error: friendly });
        span?.fail(err);
        return { payload: next, kvUpdated: false, kvError: friendly, spooled: false };
      }
    }
    if (!this.isSignedIn()) {
      const wrapped = new BugReportError({
        code: BUG_REPORT_ERROR_CODES.SAVE_FAILED,
        message: 'Cannot update a bug report while signed out.',
        context: { op: 'update', timestamp, reason: 'signed-out' },
        remediation: 'Open Settings -> Account and sign in to OneReach.',
      });
      span?.fail(wrapped);
      throw wrapped;
    }
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
      return { payload: next, kvUpdated: true, kvError: null, spooled: false };
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
      return { payload: next, kvUpdated: false, kvError: friendly, spooled: false };
    }
  }

  /**
   * Delete a report from KV. Soft failure: returns kvDeleted=false on
   * failure rather than throwing, so the UI can render a graceful error.
   */
  async delete(timestamp: string): Promise<DeleteResult> {
    const span = this.spanEmitter?.('bug-report.delete', { timestamp });
    // Spooled copy first (ADR-078): removing it prevents a later drain
    // from resurrecting a report the user deleted.
    let spoolRemoved = false;
    if (this.spoolDir !== null && (await this.readSpoolPayload(timestamp)) !== null) {
      try {
        await fsp.unlink(this.spoolFileFor(timestamp));
        spoolRemoved = true;
        this.log('info', 'store: spool delete ok', { timestamp });
      } catch (err) {
        this.log('warn', 'store: spool delete failed', {
          timestamp,
          error: (err as Error).message,
        });
      }
    }
    if (!this.isSignedIn()) {
      span?.finish({ kvDeleted: false, spooled: spoolRemoved, signedOut: true });
      return {
        kvDeleted: false,
        kvError: spoolRemoved
          ? null
          : 'Cannot delete bug reports while signed out. Sign in via Settings -> Account.',
        spooled: spoolRemoved,
      };
    }
    try {
      await this.kv.delete(KV_COLLECTION, timestamp);
      this.log('info', 'store: kv delete ok', { timestamp });
      span?.finish({ kvDeleted: true, spooled: spoolRemoved });
      return { kvDeleted: true, kvError: null, spooled: spoolRemoved };
    } catch (err) {
      const friendly =
        err instanceof LiteError ? err.formatForUser() : (err as Error).message;
      this.log('warn', 'store: kv delete failed', {
        timestamp,
        error: friendly,
        ...(err instanceof LiteError ? { code: err.code } : {}),
      });
      span?.fail(err);
      // The spool removal (if any) already succeeded -- report it so
      // the modal can render "removed from this Mac" truthfully.
      return { kvDeleted: false, kvError: spoolRemoved ? null : friendly, spooled: spoolRemoved };
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
      attachmentCount: Array.isArray(v.attachments) ? v.attachments.length : 0,
    };
  }
}

// Re-export the type used by api.ts so consumers don't have to know
// it lives in capture.ts.
export type { BugReportAttachment } from './capture.js';
