/**
 * Updater module event types -- per-module typed event surface.
 * Per ADR-032.
 */

import type { EventRecord, SerializedEventError } from '../logging/events.js';

/** Stable event name catalog. */
export const UPDATER_EVENTS = {
  // check span (3)
  CHECK_START: 'updater.check.start',
  CHECK_FINISH: 'updater.check.finish',
  CHECK_FAIL: 'updater.check.fail',
  // install span (3)
  INSTALL_START: 'updater.install.start',
  INSTALL_FINISH: 'updater.install.finish',
  INSTALL_FAIL: 'updater.install.fail',
  // IPC entries (3)
  IPC_CHECK: 'updater.ipc.check',
  IPC_INSTALL: 'updater.ipc.install',
  IPC_GET_STATE: 'updater.ipc.get-state',
} as const;

export type UpdaterEventName =
  (typeof UPDATER_EVENTS)[keyof typeof UPDATER_EVENTS];

interface UpdaterEventBase {
  id: string;
  timestamp: string;
  category: 'updater';
}

interface UpdaterSpanBase extends UpdaterEventBase {
  spanId: string;
}

// ─── check ────────────────────────────────────────────────────────────────

export interface UpdaterCheckStartEvent extends UpdaterSpanBase {
  name: typeof UPDATER_EVENTS.CHECK_START;
  level: 'info';
  data: { manual: boolean };
}
export interface UpdaterCheckFinishEvent extends UpdaterSpanBase {
  name: typeof UPDATER_EVENTS.CHECK_FINISH;
  level: 'info';
  durationMs: number;
  data: { manual: boolean };
}
export interface UpdaterCheckFailEvent extends UpdaterSpanBase {
  name: typeof UPDATER_EVENTS.CHECK_FAIL;
  level: 'error';
  durationMs: number;
  error: SerializedEventError;
}

// ─── install ──────────────────────────────────────────────────────────────

export interface UpdaterInstallStartEvent extends UpdaterSpanBase {
  name: typeof UPDATER_EVENTS.INSTALL_START;
  level: 'info';
  data: { targetVersion: string | null };
}
export interface UpdaterInstallFinishEvent extends UpdaterSpanBase {
  name: typeof UPDATER_EVENTS.INSTALL_FINISH;
  level: 'info';
  durationMs: number;
  data: { targetVersion: string | null };
}
export interface UpdaterInstallFailEvent extends UpdaterSpanBase {
  name: typeof UPDATER_EVENTS.INSTALL_FAIL;
  level: 'error';
  durationMs: number;
  error: SerializedEventError;
}

// ─── IPC entries ──────────────────────────────────────────────────────────

export interface UpdaterIpcCheckEvent extends UpdaterEventBase {
  name: typeof UPDATER_EVENTS.IPC_CHECK;
  level: 'info';
  data: { manual: boolean };
}
export interface UpdaterIpcInstallEvent extends UpdaterEventBase {
  name: typeof UPDATER_EVENTS.IPC_INSTALL;
  level: 'info';
}
export interface UpdaterIpcGetStateEvent extends UpdaterEventBase {
  name: typeof UPDATER_EVENTS.IPC_GET_STATE;
  level: 'info';
}

/** Discriminated union of every event the updater module emits. */
export type UpdaterEvent =
  | UpdaterCheckStartEvent
  | UpdaterCheckFinishEvent
  | UpdaterCheckFailEvent
  | UpdaterInstallStartEvent
  | UpdaterInstallFinishEvent
  | UpdaterInstallFailEvent
  | UpdaterIpcCheckEvent
  | UpdaterIpcInstallEvent
  | UpdaterIpcGetStateEvent;

export function isUpdaterEvent(
  ev: EventRecord
): ev is EventRecord & UpdaterEvent {
  return Object.values(UPDATER_EVENTS).includes(ev.name as UpdaterEventName);
}

/**
 * Subscribe to typed updater events. Free function (not on
 * UpdaterHandle) because the updater handle's lifecycle is owned by
 * `initUpdater()` and may be `null` during teardown -- the event log
 * is process-wide and outlives the handle.
 *
 * @example
 * ```typescript
 * import { onUpdaterEvent, UPDATER_EVENTS } from '../updater/events.js';
 * const unsub = onUpdaterEvent((ev) => {
 *   if (ev.name === UPDATER_EVENTS.CHECK_FAIL) {
 *     showRetryToast();
 *   }
 * });
 * ```
 */
export function onUpdaterEvent(
  handler: (event: UpdaterEvent) => void
): () => void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
  const { getLoggingApi } = require('../logging/api.js') as typeof import('../logging/api.js');
  return getLoggingApi().onEvent('updater.*', (ev) => {
    if (isUpdaterEvent(ev)) {
      handler(ev as unknown as UpdaterEvent);
    }
  });
}
