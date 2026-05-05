/**
 * Files module event types -- per-module typed event surface.
 *
 * Per ADR-032 + Rule 12, every module that emits events through the
 * central logging API exposes:
 *
 *   1. A const-typed catalog (`FILES_EVENTS`) of every name
 *   2. A discriminated union (`FilesEvent`) of typed event records
 *   3. An `onEvent(handler)` helper on the public API
 *
 * Event-name-conformance.test.ts enforces every literal event name
 * in `files/store.ts` lives in this catalog.
 */

import type { EventRecord, SerializedEventError } from '../logging/events.js';

/** Stable event name catalog. Source-of-truth for what files/ emits. */
export const FILES_EVENTS = {
  UPLOAD_START: 'files.upload.start',
  UPLOAD_FINISH: 'files.upload.finish',
  UPLOAD_FAIL: 'files.upload.fail',
  DOWNLOAD_START: 'files.download.start',
  DOWNLOAD_FINISH: 'files.download.finish',
  DOWNLOAD_FAIL: 'files.download.fail',
  GET_START: 'files.get.start',
  GET_FINISH: 'files.get.finish',
  GET_FAIL: 'files.get.fail',
  LIST_START: 'files.list.start',
  LIST_FINISH: 'files.list.finish',
  LIST_FAIL: 'files.list.fail',
  DELETE_START: 'files.delete.start',
  DELETE_FINISH: 'files.delete.finish',
  DELETE_FAIL: 'files.delete.fail',
  CREATE_FOLDER_START: 'files.createFolder.start',
  CREATE_FOLDER_FINISH: 'files.createFolder.finish',
  CREATE_FOLDER_FAIL: 'files.createFolder.fail',
  TTL_SET_START: 'files.ttl.set.start',
  TTL_SET_FINISH: 'files.ttl.set.finish',
  TTL_SET_FAIL: 'files.ttl.set.fail',
  PRIVACY_CHANGE_START: 'files.privacy.start',
  PRIVACY_CHANGE_FINISH: 'files.privacy.finish',
  PRIVACY_CHANGE_FAIL: 'files.privacy.fail',
} as const;

export type FilesEventName = (typeof FILES_EVENTS)[keyof typeof FILES_EVENTS];

interface FilesEventBase {
  id: string;
  timestamp: string;
  category: 'files';
  spanId: string;
}

interface FilesOpStartData {
  /** Logical key the op targets (path inside the bucket). */
  key?: string;
  /** Bucket: 'public' or 'private'. */
  bucket?: 'public' | 'private';
}

interface FilesOpFinishData {
  /** Set on `files.upload.finish` -- bytes transferred. */
  bytes?: number;
  /** Set on `files.list.finish` -- count of items returned. */
  count?: number;
  /** Set on `files.download.finish` -- bytes transferred (when known). */
  downloaded?: number;
}

// ─── upload / download / get / list / delete / createFolder ──────────────
//
// Each op shares the same start/finish/fail shape. We declare them
// individually so TS can narrow `ev.name` to the right `data` shape
// in a switch statement.

export interface FilesUploadStartEvent extends FilesEventBase {
  name: typeof FILES_EVENTS.UPLOAD_START;
  level: 'info';
  data: FilesOpStartData;
}
export interface FilesUploadFinishEvent extends FilesEventBase {
  name: typeof FILES_EVENTS.UPLOAD_FINISH;
  level: 'info';
  durationMs: number;
  data: FilesOpFinishData;
}
export interface FilesUploadFailEvent extends FilesEventBase {
  name: typeof FILES_EVENTS.UPLOAD_FAIL;
  level: 'error';
  durationMs: number;
  error: SerializedEventError;
}

export interface FilesDownloadStartEvent extends FilesEventBase {
  name: typeof FILES_EVENTS.DOWNLOAD_START;
  level: 'info';
  data: FilesOpStartData;
}
export interface FilesDownloadFinishEvent extends FilesEventBase {
  name: typeof FILES_EVENTS.DOWNLOAD_FINISH;
  level: 'info';
  durationMs: number;
  data: FilesOpFinishData;
}
export interface FilesDownloadFailEvent extends FilesEventBase {
  name: typeof FILES_EVENTS.DOWNLOAD_FAIL;
  level: 'error';
  durationMs: number;
  error: SerializedEventError;
}

export interface FilesGetStartEvent extends FilesEventBase {
  name: typeof FILES_EVENTS.GET_START;
  level: 'info';
  data: FilesOpStartData;
}
export interface FilesGetFinishEvent extends FilesEventBase {
  name: typeof FILES_EVENTS.GET_FINISH;
  level: 'info';
  durationMs: number;
  data?: FilesOpFinishData;
}
export interface FilesGetFailEvent extends FilesEventBase {
  name: typeof FILES_EVENTS.GET_FAIL;
  level: 'error';
  durationMs: number;
  error: SerializedEventError;
}

export interface FilesListStartEvent extends FilesEventBase {
  name: typeof FILES_EVENTS.LIST_START;
  level: 'info';
  data: FilesOpStartData;
}
export interface FilesListFinishEvent extends FilesEventBase {
  name: typeof FILES_EVENTS.LIST_FINISH;
  level: 'info';
  durationMs: number;
  data: FilesOpFinishData;
}
export interface FilesListFailEvent extends FilesEventBase {
  name: typeof FILES_EVENTS.LIST_FAIL;
  level: 'error';
  durationMs: number;
  error: SerializedEventError;
}

export interface FilesDeleteStartEvent extends FilesEventBase {
  name: typeof FILES_EVENTS.DELETE_START;
  level: 'info';
  data: FilesOpStartData;
}
export interface FilesDeleteFinishEvent extends FilesEventBase {
  name: typeof FILES_EVENTS.DELETE_FINISH;
  level: 'info';
  durationMs: number;
  data?: FilesOpFinishData;
}
export interface FilesDeleteFailEvent extends FilesEventBase {
  name: typeof FILES_EVENTS.DELETE_FAIL;
  level: 'error';
  durationMs: number;
  error: SerializedEventError;
}

export interface FilesCreateFolderStartEvent extends FilesEventBase {
  name: typeof FILES_EVENTS.CREATE_FOLDER_START;
  level: 'info';
  data: FilesOpStartData;
}
export interface FilesCreateFolderFinishEvent extends FilesEventBase {
  name: typeof FILES_EVENTS.CREATE_FOLDER_FINISH;
  level: 'info';
  durationMs: number;
  data?: FilesOpFinishData;
}
export interface FilesCreateFolderFailEvent extends FilesEventBase {
  name: typeof FILES_EVENTS.CREATE_FOLDER_FAIL;
  level: 'error';
  durationMs: number;
  error: SerializedEventError;
}

export interface FilesTtlSetStartEvent extends FilesEventBase {
  name: typeof FILES_EVENTS.TTL_SET_START;
  level: 'info';
  data: FilesOpStartData;
}
export interface FilesTtlSetFinishEvent extends FilesEventBase {
  name: typeof FILES_EVENTS.TTL_SET_FINISH;
  level: 'info';
  durationMs: number;
  data?: FilesOpFinishData;
}
export interface FilesTtlSetFailEvent extends FilesEventBase {
  name: typeof FILES_EVENTS.TTL_SET_FAIL;
  level: 'error';
  durationMs: number;
  error: SerializedEventError;
}

export interface FilesPrivacyChangeStartEvent extends FilesEventBase {
  name: typeof FILES_EVENTS.PRIVACY_CHANGE_START;
  level: 'info';
  data: FilesOpStartData;
}
export interface FilesPrivacyChangeFinishEvent extends FilesEventBase {
  name: typeof FILES_EVENTS.PRIVACY_CHANGE_FINISH;
  level: 'info';
  durationMs: number;
  data?: FilesOpFinishData;
}
export interface FilesPrivacyChangeFailEvent extends FilesEventBase {
  name: typeof FILES_EVENTS.PRIVACY_CHANGE_FAIL;
  level: 'error';
  durationMs: number;
  error: SerializedEventError;
}

/** Discriminated union -- branch on `ev.name` to narrow `ev.data`. */
export type FilesEvent =
  | FilesUploadStartEvent
  | FilesUploadFinishEvent
  | FilesUploadFailEvent
  | FilesDownloadStartEvent
  | FilesDownloadFinishEvent
  | FilesDownloadFailEvent
  | FilesGetStartEvent
  | FilesGetFinishEvent
  | FilesGetFailEvent
  | FilesListStartEvent
  | FilesListFinishEvent
  | FilesListFailEvent
  | FilesDeleteStartEvent
  | FilesDeleteFinishEvent
  | FilesDeleteFailEvent
  | FilesCreateFolderStartEvent
  | FilesCreateFolderFinishEvent
  | FilesCreateFolderFailEvent
  | FilesTtlSetStartEvent
  | FilesTtlSetFinishEvent
  | FilesTtlSetFailEvent
  | FilesPrivacyChangeStartEvent
  | FilesPrivacyChangeFinishEvent
  | FilesPrivacyChangeFailEvent;

/**
 * Type-guard. Use to narrow a generic `EventRecord` to the typed
 * `FilesEvent` union.
 */
export function isFilesEvent(ev: EventRecord): ev is EventRecord & FilesEvent {
  return Object.values(FILES_EVENTS).includes(ev.name as FilesEventName);
}
