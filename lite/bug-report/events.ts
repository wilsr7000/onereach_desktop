/**
 * Bug-report module event types -- per-module typed event surface.
 * Per ADR-032.
 */

import type { EventRecord, SerializedEventError } from '../logging/events.js';

/** Stable event name catalog. */
export const BUG_REPORT_EVENTS = {
  // Spans -- 6 ops × 3 outcomes = 18 names
  SAVE_START: 'bug-report.save.start',
  SAVE_FINISH: 'bug-report.save.finish',
  SAVE_FAIL: 'bug-report.save.fail',
  // Spool drain (ADR-078): stranded signed-out reports pushed to KV.
  DRAIN_START: 'bug-report.drain.start',
  DRAIN_FINISH: 'bug-report.drain.finish',
  DRAIN_FAIL: 'bug-report.drain.fail',
  LIST_START: 'bug-report.list.start',
  LIST_FINISH: 'bug-report.list.finish',
  LIST_FAIL: 'bug-report.list.fail',
  READ_START: 'bug-report.read.start',
  READ_FINISH: 'bug-report.read.finish',
  READ_FAIL: 'bug-report.read.fail',
  UPDATE_START: 'bug-report.update.start',
  UPDATE_FINISH: 'bug-report.update.finish',
  UPDATE_FAIL: 'bug-report.update.fail',
  DELETE_START: 'bug-report.delete.start',
  DELETE_FINISH: 'bug-report.delete.finish',
  DELETE_FAIL: 'bug-report.delete.fail',
  // IPC entry events -- one per renderer-driven channel
  IPC_OPEN: 'bug-report.ipc.open',
  IPC_CAPTURE: 'bug-report.ipc.capture',
  IPC_SAVE: 'bug-report.ipc.save',
  IPC_CLOSE: 'bug-report.ipc.close',
  IPC_LIST: 'bug-report.ipc.list',
  IPC_READ: 'bug-report.ipc.read',
  IPC_UPDATE: 'bug-report.ipc.update',
  IPC_DELETE: 'bug-report.ipc.delete',
  IPC_ATTACH: 'bug-report.ipc.attach',
  IPC_DOWNLOAD_ATTACHMENT: 'bug-report.ipc.download-attachment',
} as const;

export type BugReportEventName =
  (typeof BUG_REPORT_EVENTS)[keyof typeof BUG_REPORT_EVENTS];

interface BugReportEventBase {
  id: string;
  timestamp: string;
  category: 'bug-report';
}

interface BugReportSpanBase extends BugReportEventBase {
  spanId: string;
}

// ─── save ─────────────────────────────────────────────────────────────────

export interface BugReportSaveStartEvent extends BugReportSpanBase {
  name: typeof BUG_REPORT_EVENTS.SAVE_START;
  level: 'info';
  data: { timestamp: string };
}
export interface BugReportSaveFinishEvent extends BugReportSpanBase {
  name: typeof BUG_REPORT_EVENTS.SAVE_FINISH;
  level: 'info';
  durationMs: number;
  // spooled=true means the report rests in the local spool awaiting
  // sync (ADR-078); kvError carries the deferred-sync reason if the KV
  // write was attempted and failed.
  data: { kvWritten: boolean; spooled: boolean; kvError?: string };
}
export interface BugReportSaveFailEvent extends BugReportSpanBase {
  name: typeof BUG_REPORT_EVENTS.SAVE_FAIL;
  level: 'error';
  durationMs: number;
  error: SerializedEventError;
}

// ─── drain (ADR-078) ─────────────────────────────────────────────────────

export interface BugReportDrainStartEvent extends BugReportSpanBase {
  name: typeof BUG_REPORT_EVENTS.DRAIN_START;
  level: 'info';
  data: { pending: number };
}
export interface BugReportDrainFinishEvent extends BugReportSpanBase {
  name: typeof BUG_REPORT_EVENTS.DRAIN_FINISH;
  level: 'info';
  durationMs: number;
  data: { drained: number; remaining: number };
}
export interface BugReportDrainFailEvent extends BugReportSpanBase {
  name: typeof BUG_REPORT_EVENTS.DRAIN_FAIL;
  level: 'error';
  durationMs: number;
  data?: { drained: number; remaining: number };
  error: SerializedEventError;
}

// ─── list ─────────────────────────────────────────────────────────────────

export interface BugReportListStartEvent extends BugReportSpanBase {
  name: typeof BUG_REPORT_EVENTS.LIST_START;
  level: 'info';
}
export interface BugReportListFinishEvent extends BugReportSpanBase {
  name: typeof BUG_REPORT_EVENTS.LIST_FINISH;
  level: 'info';
  durationMs: number;
  data: { count: number };
}
export interface BugReportListFailEvent extends BugReportSpanBase {
  name: typeof BUG_REPORT_EVENTS.LIST_FAIL;
  level: 'error';
  durationMs: number;
  error: SerializedEventError;
}

// ─── read ─────────────────────────────────────────────────────────────────

export interface BugReportReadStartEvent extends BugReportSpanBase {
  name: typeof BUG_REPORT_EVENTS.READ_START;
  level: 'info';
  data: { key: string };
}
export interface BugReportReadFinishEvent extends BugReportSpanBase {
  name: typeof BUG_REPORT_EVENTS.READ_FINISH;
  level: 'info';
  durationMs: number;
}
export interface BugReportReadFailEvent extends BugReportSpanBase {
  name: typeof BUG_REPORT_EVENTS.READ_FAIL;
  level: 'error';
  durationMs: number;
  error: SerializedEventError;
}

// ─── update ───────────────────────────────────────────────────────────────

export interface BugReportUpdateStartEvent extends BugReportSpanBase {
  name: typeof BUG_REPORT_EVENTS.UPDATE_START;
  level: 'info';
  data: {
    timestamp: string;
    hasStatusChange: boolean;
    hasNotesChange: boolean;
  };
}
export interface BugReportUpdateFinishEvent extends BugReportSpanBase {
  name: typeof BUG_REPORT_EVENTS.UPDATE_FINISH;
  level: 'info';
  durationMs: number;
  data: { kvUpdated?: boolean; spooled?: boolean };
}
export interface BugReportUpdateFailEvent extends BugReportSpanBase {
  name: typeof BUG_REPORT_EVENTS.UPDATE_FAIL;
  level: 'error';
  durationMs: number;
  error: SerializedEventError;
}

// ─── delete ───────────────────────────────────────────────────────────────

export interface BugReportDeleteStartEvent extends BugReportSpanBase {
  name: typeof BUG_REPORT_EVENTS.DELETE_START;
  level: 'info';
  data: { timestamp: string };
}
export interface BugReportDeleteFinishEvent extends BugReportSpanBase {
  name: typeof BUG_REPORT_EVENTS.DELETE_FINISH;
  level: 'info';
  durationMs: number;
  data: { kvDeleted: boolean; spooled?: boolean; signedOut?: boolean };
}
export interface BugReportDeleteFailEvent extends BugReportSpanBase {
  name: typeof BUG_REPORT_EVENTS.DELETE_FAIL;
  level: 'error';
  durationMs: number;
  error: SerializedEventError;
}

// ─── IPC entry events ─────────────────────────────────────────────────────

export interface BugReportIpcCaptureEvent extends BugReportEventBase {
  name: typeof BUG_REPORT_EVENTS.IPC_CAPTURE;
  level: 'info';
}
export interface BugReportIpcSaveEvent extends BugReportEventBase {
  name: typeof BUG_REPORT_EVENTS.IPC_SAVE;
  level: 'info';
}
export interface BugReportIpcCloseEvent extends BugReportEventBase {
  name: typeof BUG_REPORT_EVENTS.IPC_CLOSE;
  level: 'info';
}
export interface BugReportIpcListEvent extends BugReportEventBase {
  name: typeof BUG_REPORT_EVENTS.IPC_LIST;
  level: 'info';
}
export interface BugReportIpcReadEvent extends BugReportEventBase {
  name: typeof BUG_REPORT_EVENTS.IPC_READ;
  level: 'info';
  data: { idOrPath: string };
}
export interface BugReportIpcUpdateEvent extends BugReportEventBase {
  name: typeof BUG_REPORT_EVENTS.IPC_UPDATE;
  level: 'info';
  data: { timestamp: string };
}
export interface BugReportIpcAttachEvent extends BugReportEventBase {
  name: typeof BUG_REPORT_EVENTS.IPC_ATTACH;
  level: 'info';
  data?: undefined;
}
export interface BugReportIpcDownloadAttachmentEvent extends BugReportEventBase {
  name: typeof BUG_REPORT_EVENTS.IPC_DOWNLOAD_ATTACHMENT;
  level: 'info';
  data?: { key: string | null };
}
export interface BugReportIpcDeleteEvent extends BugReportEventBase {
  name: typeof BUG_REPORT_EVENTS.IPC_DELETE;
  level: 'info';
  data: { timestamp: string };
}

/** Discriminated union of every event the bug-report module emits. */
export type BugReportEvent =
  | BugReportSaveStartEvent
  | BugReportSaveFinishEvent
  | BugReportSaveFailEvent
  | BugReportDrainStartEvent
  | BugReportDrainFinishEvent
  | BugReportDrainFailEvent
  | BugReportListStartEvent
  | BugReportListFinishEvent
  | BugReportListFailEvent
  | BugReportReadStartEvent
  | BugReportReadFinishEvent
  | BugReportReadFailEvent
  | BugReportUpdateStartEvent
  | BugReportUpdateFinishEvent
  | BugReportUpdateFailEvent
  | BugReportDeleteStartEvent
  | BugReportDeleteFinishEvent
  | BugReportDeleteFailEvent
  | BugReportIpcCaptureEvent
  | BugReportIpcSaveEvent
  | BugReportIpcCloseEvent
  | BugReportIpcListEvent
  | BugReportIpcReadEvent
  | BugReportIpcUpdateEvent
  | BugReportIpcDeleteEvent
  | BugReportIpcAttachEvent
  | BugReportIpcDownloadAttachmentEvent;

export function isBugReportEvent(
  ev: EventRecord
): ev is EventRecord & BugReportEvent {
  return Object.values(BUG_REPORT_EVENTS).includes(ev.name as BugReportEventName);
}
