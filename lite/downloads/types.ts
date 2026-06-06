/**
 * Shared types for the lite downloads module.
 *
 * The download module captures `will-download` events from any
 * webContents session and offers the user a choice: save to the OS
 * Downloads folder (Electron-default behavior) or save into a OneReach
 * Space (upload to Files + create `:Asset` with `[:BELONGS_TO]`).
 *
 * Per ADR-019 / Rule 11, consumers go through `lite/downloads/api.ts`.
 */

import type { DerivedItemKind } from './mime.js';

/**
 * Per-download context captured at the moment `will-download` fires.
 * Carried through the prompt + picker + upload pipeline so each stage
 * has the data it needs without re-deriving from the Electron item.
 */
export interface CapturedDownload {
  /** Random short id used for storage prefixing + tracking. */
  id: string;
  /** Filename the server suggested. Already sanitized. */
  fileName: string;
  /** MIME type the server sent, or '' when absent. */
  mimeType: string;
  /** Derived Spaces ItemKind for the captured file. */
  kind: DerivedItemKind;
  /** Server-reported byte size, or 0 when the server didn't advertise. */
  totalBytes: number;
  /** Human description of where the download came from ('main', 'tab:t-…'). */
  source: string;
  /** URL the download started from (best-effort). */
  url: string;
}

/**
 * Result the picker window returns to the orchestrator. `null` means
 * the user cancelled.
 */
export interface PickerResult {
  spaceId: string;
  /** Display name the picker showed; used in success toasts. */
  spaceName: string;
}

/**
 * Lightweight Space record handed to the picker for display. The
 * picker doesn't need the full `Space` shape -- just enough to render
 * the row + filter on name.
 */
export interface PickerSpace {
  id: string;
  name: string;
  color?: string;
  itemCount?: number;
}

/**
 * Payload the main process sends to the picker once both spaces and
 * the captured-file metadata are ready. The picker renders this and
 * resolves back with either a `PickerResult` (user picked a space) or
 * `null` (user cancelled).
 */
export interface PickerBootstrap {
  /** Captured-download summary the picker displays at the top. */
  download: {
    fileName: string;
    mimeType: string;
    kind: DerivedItemKind;
    totalBytes: number;
    source: string;
  };
  spaces: PickerSpace[];
  /** Suggested default space id (last-used) -- picker pre-selects this row. */
  defaultSpaceId?: string;
}
