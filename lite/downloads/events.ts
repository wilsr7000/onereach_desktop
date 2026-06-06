/**
 * Downloads module event types -- per-module typed event surface
 * (ADR-032 + ADR-030).
 *
 * The downloads module captures `will-download` events and offers the
 * user a choice: save to the OS Downloads folder, or upload into a
 * OneReach Space. The events here make every stage observable in
 * `/logs?category=downloads`:
 *
 *   - `downloads.captured`            -- a download was intercepted
 *   - `downloads.routed-to-downloads` -- user chose the OS folder
 *   - `downloads.cancelled`           -- user cancelled (dialog or picker)
 *   - `downloads.save-to-space.*`     -- span around upload + asset-create
 *   - `downloads.ipc.*`               -- picker-window IPC entries
 *
 * Mirrors the catalog pattern in `lite/idw/events.ts`.
 */

import type { EventRecord, SerializedEventError } from '../logging/events.js';
import type { DerivedItemKind } from './mime.js';

/** Stable event-name catalog. Source of truth for what downloads/ emits. */
export const DOWNLOADS_EVENTS = {
  // Activity (instant).
  CAPTURED: 'downloads.captured',
  ROUTED_TO_DOWNLOADS: 'downloads.routed-to-downloads',
  CANCELLED: 'downloads.cancelled',
  PICKER_BUSY_FALLBACK: 'downloads.picker-busy-fallback',
  // Save-to-Space span (upload bytes -> Files, create :Asset -> Spaces).
  SAVE_TO_SPACE_START: 'downloads.save-to-space.start',
  SAVE_TO_SPACE_FINISH: 'downloads.save-to-space.finish',
  SAVE_TO_SPACE_FAIL: 'downloads.save-to-space.fail',
  // IPC entry events (per ADR-030).
  IPC_PICKER_BOOTSTRAP: 'downloads.ipc.picker-bootstrap',
  IPC_PICKER_RESOLVE: 'downloads.ipc.picker-resolve',
} as const;

export type DownloadsEventName =
  (typeof DOWNLOADS_EVENTS)[keyof typeof DOWNLOADS_EVENTS];

interface DownloadsEventBase {
  id: string;
  timestamp: string;
  category: 'downloads';
}

interface DownloadsSpanBase extends DownloadsEventBase {
  spanId: string;
}

export interface DownloadsCapturedEvent extends DownloadsEventBase {
  name: typeof DOWNLOADS_EVENTS.CAPTURED;
  level: 'info';
  data: {
    id: string;
    fileName: string;
    mimeType: string;
    kind: DerivedItemKind;
    totalBytes: number;
    source: string;
  };
}
export interface DownloadsRoutedToDownloadsEvent extends DownloadsEventBase {
  name: typeof DOWNLOADS_EVENTS.ROUTED_TO_DOWNLOADS;
  level: 'info';
  data: { id: string };
}
export interface DownloadsCancelledEvent extends DownloadsEventBase {
  name: typeof DOWNLOADS_EVENTS.CANCELLED;
  level: 'info';
  data: { id: string; stage: 'dialog' | 'picker' };
}
export interface DownloadsPickerBusyFallbackEvent extends DownloadsEventBase {
  name: typeof DOWNLOADS_EVENTS.PICKER_BUSY_FALLBACK;
  level: 'warn';
  data: { id: string };
}
export interface DownloadsSaveToSpaceStartEvent extends DownloadsSpanBase {
  name: typeof DOWNLOADS_EVENTS.SAVE_TO_SPACE_START;
  level: 'info';
  data?: { id: string; spaceId: string };
}
export interface DownloadsSaveToSpaceFinishEvent extends DownloadsSpanBase {
  name: typeof DOWNLOADS_EVENTS.SAVE_TO_SPACE_FINISH;
  level: 'info';
  durationMs: number;
  data?: { id: string; spaceId: string; fileKey: string };
}
export interface DownloadsSaveToSpaceFailEvent extends DownloadsSpanBase {
  name: typeof DOWNLOADS_EVENTS.SAVE_TO_SPACE_FAIL;
  level: 'error';
  durationMs: number;
  error: SerializedEventError;
}
export interface DownloadsIpcPickerBootstrapEvent extends DownloadsEventBase {
  name: typeof DOWNLOADS_EVENTS.IPC_PICKER_BOOTSTRAP;
  level: 'info';
}
export interface DownloadsIpcPickerResolveEvent extends DownloadsEventBase {
  name: typeof DOWNLOADS_EVENTS.IPC_PICKER_RESOLVE;
  level: 'info';
}

export type DownloadsEvent =
  | DownloadsCapturedEvent
  | DownloadsRoutedToDownloadsEvent
  | DownloadsCancelledEvent
  | DownloadsPickerBusyFallbackEvent
  | DownloadsSaveToSpaceStartEvent
  | DownloadsSaveToSpaceFinishEvent
  | DownloadsSaveToSpaceFailEvent
  | DownloadsIpcPickerBootstrapEvent
  | DownloadsIpcPickerResolveEvent;

export function isDownloadsEvent(
  ev: EventRecord
): ev is EventRecord & DownloadsEvent {
  return Object.values(DOWNLOADS_EVENTS).includes(ev.name as DownloadsEventName);
}
