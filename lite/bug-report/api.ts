/**
 * Bug-report module -- PUBLIC API.
 *
 * This is the only file other lite modules should import from in this
 * module. Per ADR-019 (and rule 11 in lite/LITE-RULES.md), cross-module
 * imports go through `<module>/api.ts` -- never reach into store.ts,
 * main.ts, or any other internal file.
 *
 * The bug-report module itself consumes the KV module via its public
 * API (`../kv/api.ts`); see ADR-020 for why KV lives at the top level
 * rather than buried inside bug-report.
 *
 * Usage from another module:
 *
 *   import { getBugReportApi } from '../bug-report/api.js';
 *   const reports = await getBugReportApi().list();
 *
 * The implementation backing `BugReportApi` is `BugReportStore` (in
 * store.ts), but the choice of backing class is an internal detail. If
 * we ever swap the implementation (caching layer, in-memory variant for
 * tests, alternate cloud sink), only this file changes.
 *
 * Initialization: callers do not need to wire dependencies. The default
 * singleton lazily creates a `BugReportStore` with a console logger.
 * Tests can swap the implementation via `_setBugReportApiForTesting`.
 */

import { BugReportStore } from './store.js';
import type { StoreConfig } from './store.js';
import { getLoggingApi } from '../logging/api.js';
import type { BugReportEvent } from './events.js';

// Re-export the public types other modules need to typecheck calls.
// Keeps callers from having to know that the types live in store.ts.
export type {
  BugReportSummary,
  SaveResult,
  UpdateResult,
  DeleteResult,
  BugReportErrorCode,
  BugReportErrorOptions,
} from './store.js';
export type { BugReportPayload, BugReportStatus } from './capture.js';

// Re-export the structured error class + code catalog so consumers
// catch and branch via the public surface, never reaching into
// store.ts.
export { BugReportError, BUG_REPORT_ERROR_CODES } from './store.js';

// Per-module typed event surface (ADR-032).
export {
  BUG_REPORT_EVENTS,
  isBugReportEvent,
  type BugReportEvent,
  type BugReportEventName,
  type BugReportSaveStartEvent,
  type BugReportSaveFinishEvent,
  type BugReportSaveFailEvent,
  type BugReportListStartEvent,
  type BugReportListFinishEvent,
  type BugReportListFailEvent,
  type BugReportReadStartEvent,
  type BugReportReadFinishEvent,
  type BugReportReadFailEvent,
  type BugReportUpdateStartEvent,
  type BugReportUpdateFinishEvent,
  type BugReportUpdateFailEvent,
  type BugReportDeleteStartEvent,
  type BugReportDeleteFinishEvent,
  type BugReportDeleteFailEvent,
  type BugReportIpcCaptureEvent,
  type BugReportIpcSaveEvent,
  type BugReportIpcCloseEvent,
  type BugReportIpcListEvent,
  type BugReportIpcReadEvent,
  type BugReportIpcUpdateEvent,
  type BugReportIpcDeleteEvent,
} from './events.js';
// Generic base class -- consumers can also catch via `instanceof LiteError`
// if they want to handle errors uniformly across all lite modules.
export { LiteError, isLiteError } from '../errors.js';

import type { BugReportPayload, BugReportStatus } from './capture.js';
import type { BugReportSummary, SaveResult, UpdateResult, DeleteResult } from './store.js';

/**
 * The public surface of the bug-report module. All cross-module callers
 * route through this interface.
 *
 * **Error contract**:
 * - `save()` and `read()` throw `BugReportError` (extends `LiteError`)
 *   on failure. Inspect `.code` to branch (`BR_SAVE_FAILED`,
 *   `BR_NOT_FOUND`, `BR_BAD_PAYLOAD`).
 * - `list()`, `update()`, and `delete()` are **soft-fail**: they never
 *   throw. Inspect the returned `kvWritten` / `kvUpdated` / `kvDeleted`
 *   booleans plus the `kvError` string for failure UX.
 *
 * The split is intentional: throws are reserved for "the operation
 * cannot succeed and there's nothing meaningful to return" (e.g.
 * NOT_FOUND from `read`). For mutations that have a partial-success
 * shape (the in-memory payload is still valid even if the network
 * write failed), we return a result object so the modal can render an
 * inline error and let the user retry.
 *
 * See `lite/bug-report/README.md` for the full error catalog and
 * recipe-style usage examples.
 */
export interface BugReportApi {
  /**
   * Persist a new bug report.
   *
   * @param payload Already-redacted, schema-validated payload from
   *   `capture()`. The `timestamp` field is the KV key.
   * @returns `{ kvWritten: true, kvError: null }` on success.
   * @throws {BugReportError} `BR_SAVE_FAILED` if the KV write rejected.
   *   Inspect `.cause` for the underlying `KVError` (`.code`,
   *   `.context`, `.remediation`).
   *
   * @example
   * ```typescript
   * try {
   *   await getBugReportApi().save(payload);
   * } catch (err) {
   *   if (err instanceof BugReportError) {
   *     toast(err.formatForUser());      // "Bug report save failed: ..."
   *     console.error(err.formatForLog()); // structured for diagnostics
   *   }
   * }
   * ```
   */
  save(payload: BugReportPayload): Promise<SaveResult>;

  /**
   * List all reports, newest first. Soft-fails: returns `[]` on KV
   * failure so the modal can render an empty state instead of an
   * error.
   *
   * @returns Summaries (timestamp, version, description preview,
   *   redaction stats, status, notes presence). Empty if no reports
   *   are stored or KV is unreachable.
   *
   * @example
   * ```typescript
   * const reports = await getBugReportApi().list();
   * for (const r of reports) {
   *   console.log(r.timestamp, r.descriptionPreview, r.status);
   * }
   * ```
   */
  list(): Promise<BugReportSummary[]>;

  /**
   * Read a single report by id.
   *
   * @param idOrPath Either a bare timestamp (e.g.
   *   `2026-05-04T01:02:03Z`) or the synthetic `kv:<timestamp>` form
   *   produced by `list()`.
   * @returns The full payload, with legacy schemas migrated.
   * @throws {BugReportError} `BR_NOT_FOUND` if the id resolves to no
   *   record. Remediation: refresh the list and retry.
   * @throws {BugReportError} `BR_BAD_PAYLOAD` if KV returned a value
   *   that doesn't deserialize as a `BugReportPayload`.
   * @throws {KVError} on network/server failures (`KV_TIMEOUT`,
   *   `KV_HTTP`, `KV_NETWORK`).
   *
   * @example
   * ```typescript
   * const report = await getBugReportApi().read('kv:2026-05-04T01:02:03Z');
   * ```
   */
  read(idOrPath: string): Promise<BugReportPayload>;

  /**
   * Update mutable fields (status, notes) on an existing report.
   * Notes are redacted before save. Soft-fails: returns
   * `{ kvUpdated: false, kvError: "..." }` on KV failure so the modal
   * can show an inline retry without losing the user's edits.
   *
   * @param timestamp The KV key (bare timestamp -- not the
   *   `kv:<timestamp>` synthetic form).
   * @param updates Partial mutation. Omit fields that should not change.
   * @returns The new payload (in-memory) plus a `kvUpdated` flag.
   *
   * @example
   * ```typescript
   * const result = await getBugReportApi().update('2026-05-04T01:02:03Z', {
   *   status: 'resolved',
   *   notes: 'Closed by ricky -- duplicate of #42',
   * });
   * if (!result.kvUpdated) toast(result.kvError ?? 'Update failed');
   * ```
   */
  update(
    timestamp: string,
    updates: { status?: BugReportStatus; notes?: string }
  ): Promise<UpdateResult>;

  /**
   * Delete a report. Soft-fails: returns
   * `{ kvDeleted: false, kvError: "..." }` rather than throwing.
   *
   * @param timestamp The KV key.
   * @returns `{ kvDeleted: boolean, kvError: string | null }`.
   *
   * @example
   * ```typescript
   * const result = await getBugReportApi().delete('2026-05-04T01:02:03Z');
   * if (!result.kvDeleted) toast(result.kvError ?? 'Delete failed');
   * ```
   */
  delete(timestamp: string): Promise<DeleteResult>;

  /**
   * Subscribe to typed bug-report events (ADR-032). Branch on
   * `ev.name` for type-narrowed access to span data, IPC payloads,
   * and serialized errors.
   *
   * @example
   * ```typescript
   * const unsub = getBugReportApi().onEvent((ev) => {
   *   switch (ev.name) {
   *     case 'bug-report.save.finish':
   *       metrics.timing('bug-report.save', ev.durationMs);
   *       break;
   *     case 'bug-report.save.fail':
   *       sentry.capture(ev.data.error);
   *       break;
   *   }
   * });
   * ```
   */
  onEvent(handler: (event: BugReportEvent) => void): () => void;
}

let _instance: BugReportApi | null = null;

/**
 * Get the singleton bug-report API. Lazily instantiates on first call.
 *
 * Default backing implementation is `BugReportStore` with a console
 * logger. To override (e.g. for tests, or to pass a custom KV client),
 * use `_setBugReportApiForTesting()` before this is first called, or
 * call `_resetBugReportApiForTesting()` to clear and re-init.
 */
export function getBugReportApi(): BugReportApi {
  if (_instance === null) {
    _instance = new BugReportStore(defaultConfig());
  }
  return _instance;
}

/** Reset the singleton (for tests). */
export function _resetBugReportApiForTesting(): void {
  _instance = null;
}

/**
 * Override the singleton with a custom implementation (for tests). The
 * provided value is returned by subsequent `getBugReportApi()` calls
 * until reset.
 */
export function _setBugReportApiForTesting(api: BugReportApi): void {
  _instance = api;
}

/**
 * Default store config -- routes the store's `logger` callback through
 * the lite logging module (per ADR-025), so every `[bug-report-store]`
 * line shows up in the unified log stream (port 47392, /logs HTTP,
 * WebSocket, recent() buffer). Tests can override by passing their own
 * `logger` to `BugReportStore` directly.
 */
function defaultConfig(): StoreConfig {
  return {
    logger: (level, message, data) => {
      const log = getLoggingApi();
      log[level]('bug-report', message, data);
    },
    // ADR-026: every save/list/read/update/delete emits a
    // start/finish/fail span through the central event log.
    spanEmitter: (name, data) => getLoggingApi().start(name, data),
  };
}
