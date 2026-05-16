/**
 * Spaces module event types -- per-module typed event surface.
 *
 * Per ADR-032 + Rule 12, every module that emits events through the
 * central logging API exposes:
 *
 *   1. A const-typed catalog (`SPACES_EVENTS`) of every name
 *   2. A discriminated union (`SpacesEvent`) of typed event records
 *   3. An `onEvent(handler)` helper on the public API (Phase 1+)
 *
 * Event-name-conformance.test.ts enforces every literal event name in
 * `spaces/sdk-client.ts` (and any other spaces/ source files that emit)
 * lives in this catalog.
 *
 * Phase 0 ships the catalog and union shape so the module compiles +
 * passes conformance. Real emit sites land in Phase 1 (`items.list`,
 * `listSpaces`) and Phase 2 (multi-Space query, item detail fetch).
 */

import type { EventRecord, SerializedEventError } from '../logging/events.js';

/** Stable event name catalog. Source-of-truth for what spaces/ emits. */
export const SPACES_EVENTS = {
  // ─── listSpaces ───────────────────────────────────────────────────────
  LIST_SPACES_START: 'spaces.listSpaces.start',
  LIST_SPACES_FINISH: 'spaces.listSpaces.finish',
  LIST_SPACES_FAIL: 'spaces.listSpaces.fail',
  // ─── items.list ──────────────────────────────────────────────────────
  ITEMS_LIST_START: 'spaces.items.list.start',
  ITEMS_LIST_FINISH: 'spaces.items.list.finish',
  ITEMS_LIST_FAIL: 'spaces.items.list.fail',
  // ─── items.get ───────────────────────────────────────────────────────
  ITEMS_GET_START: 'spaces.items.get.start',
  ITEMS_GET_FINISH: 'spaces.items.get.finish',
  ITEMS_GET_FAIL: 'spaces.items.get.fail',
  // ─── getUncategorizedCount ───────────────────────────────────────────
  UNCATEGORIZED_COUNT_START: 'spaces.uncategorizedCount.start',
  UNCATEGORIZED_COUNT_FINISH: 'spaces.uncategorizedCount.finish',
  UNCATEGORIZED_COUNT_FAIL: 'spaces.uncategorizedCount.fail',
  // ─── create (Phase 3a) ───────────────────────────────────────────────
  CREATE_START: 'spaces.create.start',
  CREATE_FINISH: 'spaces.create.finish',
  CREATE_FAIL: 'spaces.create.fail',
  // ─── rename (Phase 3a) ───────────────────────────────────────────────
  RENAME_START: 'spaces.rename.start',
  RENAME_FINISH: 'spaces.rename.finish',
  RENAME_FAIL: 'spaces.rename.fail',
  // ─── delete (Phase 3a) ───────────────────────────────────────────────
  DELETE_START: 'spaces.delete.start',
  DELETE_FINISH: 'spaces.delete.finish',
  DELETE_FAIL: 'spaces.delete.fail',
  // ─── undelete (Phase 3a) ─────────────────────────────────────────────
  UNDELETE_START: 'spaces.undelete.start',
  UNDELETE_FINISH: 'spaces.undelete.finish',
  UNDELETE_FAIL: 'spaces.undelete.fail',
} as const;

export type SpacesEventName = (typeof SPACES_EVENTS)[keyof typeof SPACES_EVENTS];

interface SpacesEventBase {
  id: string;
  timestamp: string;
  category: 'spaces';
  spanId: string;
}

interface SpacesScopeData {
  /** Scope discriminant: 'space' or 'uncategorized'. */
  scope?: 'space' | 'uncategorized';
  /** Real space id when scope is 'space'. */
  spaceId?: string;
}

interface SpacesCountData {
  /** Count returned by a list / count query. */
  count?: number;
}

// ─── listSpaces ──────────────────────────────────────────────────────

export interface SpacesListSpacesStartEvent extends SpacesEventBase {
  name: typeof SPACES_EVENTS.LIST_SPACES_START;
  level: 'info';
  data?: Record<string, never>;
}
export interface SpacesListSpacesFinishEvent extends SpacesEventBase {
  name: typeof SPACES_EVENTS.LIST_SPACES_FINISH;
  level: 'info';
  durationMs: number;
  data: SpacesCountData;
}
export interface SpacesListSpacesFailEvent extends SpacesEventBase {
  name: typeof SPACES_EVENTS.LIST_SPACES_FAIL;
  level: 'error';
  durationMs: number;
  error: SerializedEventError;
}

// ─── items.list ──────────────────────────────────────────────────────

export interface SpacesItemsListStartEvent extends SpacesEventBase {
  name: typeof SPACES_EVENTS.ITEMS_LIST_START;
  level: 'info';
  data: SpacesScopeData;
}
export interface SpacesItemsListFinishEvent extends SpacesEventBase {
  name: typeof SPACES_EVENTS.ITEMS_LIST_FINISH;
  level: 'info';
  durationMs: number;
  data: SpacesScopeData & SpacesCountData;
}
export interface SpacesItemsListFailEvent extends SpacesEventBase {
  name: typeof SPACES_EVENTS.ITEMS_LIST_FAIL;
  level: 'error';
  durationMs: number;
  error: SerializedEventError;
}

// ─── items.get ───────────────────────────────────────────────────────

export interface SpacesItemsGetStartEvent extends SpacesEventBase {
  name: typeof SPACES_EVENTS.ITEMS_GET_START;
  level: 'info';
  data: { itemId: string };
}
export interface SpacesItemsGetFinishEvent extends SpacesEventBase {
  name: typeof SPACES_EVENTS.ITEMS_GET_FINISH;
  level: 'info';
  durationMs: number;
  data?: Record<string, never>;
}
export interface SpacesItemsGetFailEvent extends SpacesEventBase {
  name: typeof SPACES_EVENTS.ITEMS_GET_FAIL;
  level: 'error';
  durationMs: number;
  error: SerializedEventError;
}

// ─── getUncategorizedCount ───────────────────────────────────────────

export interface SpacesUncategorizedCountStartEvent extends SpacesEventBase {
  name: typeof SPACES_EVENTS.UNCATEGORIZED_COUNT_START;
  level: 'info';
  data?: Record<string, never>;
}
export interface SpacesUncategorizedCountFinishEvent extends SpacesEventBase {
  name: typeof SPACES_EVENTS.UNCATEGORIZED_COUNT_FINISH;
  level: 'info';
  durationMs: number;
  data: SpacesCountData;
}
export interface SpacesUncategorizedCountFailEvent extends SpacesEventBase {
  name: typeof SPACES_EVENTS.UNCATEGORIZED_COUNT_FAIL;
  level: 'error';
  durationMs: number;
  error: SerializedEventError;
}

// ─── create (Phase 3a) ───────────────────────────────────────────────────
//
// The mutation events carry a SPACE id where known. `start` doesn't have
// one (the Space hasn't been created yet); `finish` carries the assigned
// id so consumers can correlate. `fail` carries no id when the error
// arose before assignment.

interface SpacesIdData {
  spaceId?: string;
}

export interface SpacesCreateStartEvent extends SpacesEventBase {
  name: typeof SPACES_EVENTS.CREATE_START;
  level: 'info';
  /** `nameLength` is logged instead of the name itself -- names can be PII (project codenames, client names). */
  data: { nameLength: number; hasDescription: boolean };
}
export interface SpacesCreateFinishEvent extends SpacesEventBase {
  name: typeof SPACES_EVENTS.CREATE_FINISH;
  level: 'info';
  durationMs: number;
  data: SpacesIdData;
}
export interface SpacesCreateFailEvent extends SpacesEventBase {
  name: typeof SPACES_EVENTS.CREATE_FAIL;
  level: 'error';
  durationMs: number;
  error: SerializedEventError;
}

// ─── rename (Phase 3a) ───────────────────────────────────────────────────

export interface SpacesRenameStartEvent extends SpacesEventBase {
  name: typeof SPACES_EVENTS.RENAME_START;
  level: 'info';
  data: SpacesIdData & { nameLength: number };
}
export interface SpacesRenameFinishEvent extends SpacesEventBase {
  name: typeof SPACES_EVENTS.RENAME_FINISH;
  level: 'info';
  durationMs: number;
  data: SpacesIdData;
}
export interface SpacesRenameFailEvent extends SpacesEventBase {
  name: typeof SPACES_EVENTS.RENAME_FAIL;
  level: 'error';
  durationMs: number;
  error: SerializedEventError;
}

// ─── delete (Phase 3a) ───────────────────────────────────────────────────

export interface SpacesDeleteStartEvent extends SpacesEventBase {
  name: typeof SPACES_EVENTS.DELETE_START;
  level: 'info';
  data: SpacesIdData & { soft: boolean };
}
export interface SpacesDeleteFinishEvent extends SpacesEventBase {
  name: typeof SPACES_EVENTS.DELETE_FINISH;
  level: 'info';
  durationMs: number;
  data: SpacesIdData & { soft: boolean };
}
export interface SpacesDeleteFailEvent extends SpacesEventBase {
  name: typeof SPACES_EVENTS.DELETE_FAIL;
  level: 'error';
  durationMs: number;
  error: SerializedEventError;
}

// ─── undelete (Phase 3a) ─────────────────────────────────────────────────

export interface SpacesUndeleteStartEvent extends SpacesEventBase {
  name: typeof SPACES_EVENTS.UNDELETE_START;
  level: 'info';
  data: SpacesIdData;
}
export interface SpacesUndeleteFinishEvent extends SpacesEventBase {
  name: typeof SPACES_EVENTS.UNDELETE_FINISH;
  level: 'info';
  durationMs: number;
  data: SpacesIdData;
}
export interface SpacesUndeleteFailEvent extends SpacesEventBase {
  name: typeof SPACES_EVENTS.UNDELETE_FAIL;
  level: 'error';
  durationMs: number;
  error: SerializedEventError;
}

/** Discriminated union -- branch on `ev.name` to narrow `ev.data`. */
export type SpacesEvent =
  | SpacesListSpacesStartEvent
  | SpacesListSpacesFinishEvent
  | SpacesListSpacesFailEvent
  | SpacesItemsListStartEvent
  | SpacesItemsListFinishEvent
  | SpacesItemsListFailEvent
  | SpacesItemsGetStartEvent
  | SpacesItemsGetFinishEvent
  | SpacesItemsGetFailEvent
  | SpacesUncategorizedCountStartEvent
  | SpacesUncategorizedCountFinishEvent
  | SpacesUncategorizedCountFailEvent
  | SpacesCreateStartEvent
  | SpacesCreateFinishEvent
  | SpacesCreateFailEvent
  | SpacesRenameStartEvent
  | SpacesRenameFinishEvent
  | SpacesRenameFailEvent
  | SpacesDeleteStartEvent
  | SpacesDeleteFinishEvent
  | SpacesDeleteFailEvent
  | SpacesUndeleteStartEvent
  | SpacesUndeleteFinishEvent
  | SpacesUndeleteFailEvent;

/**
 * Type-guard. Use to narrow a generic `EventRecord` to the typed
 * `SpacesEvent` union.
 */
export function isSpacesEvent(ev: EventRecord): ev is EventRecord & SpacesEvent {
  return Object.values(SPACES_EVENTS).includes(ev.name as SpacesEventName);
}
