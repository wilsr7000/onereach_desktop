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
  // ─── checklists (ADR-055) ────────────────────────────────────────────
  CHECKLISTS_CREATE_START: 'spaces.checklists.create.start',
  CHECKLISTS_CREATE_FINISH: 'spaces.checklists.create.finish',
  CHECKLISTS_CREATE_FAIL: 'spaces.checklists.create.fail',
  CHECKLISTS_LIST_START: 'spaces.checklists.list.start',
  CHECKLISTS_LIST_FINISH: 'spaces.checklists.list.finish',
  CHECKLISTS_LIST_FAIL: 'spaces.checklists.list.fail',
  CHECKLISTS_UPDATE_START: 'spaces.checklists.update.start',
  CHECKLISTS_UPDATE_FINISH: 'spaces.checklists.update.finish',
  CHECKLISTS_UPDATE_FAIL: 'spaces.checklists.update.fail',
  CHECKLISTS_DELETE_START: 'spaces.checklists.delete.start',
  CHECKLISTS_DELETE_FINISH: 'spaces.checklists.delete.finish',
  CHECKLISTS_DELETE_FAIL: 'spaces.checklists.delete.fail',
  CHECKLISTS_ATTACH_START: 'spaces.checklists.attach.start',
  CHECKLISTS_ATTACH_FINISH: 'spaces.checklists.attach.finish',
  CHECKLISTS_ATTACH_FAIL: 'spaces.checklists.attach.fail',
  CHECKLISTS_CHECK_START: 'spaces.checklists.check.start',
  CHECKLISTS_CHECK_FINISH: 'spaces.checklists.check.finish',
  CHECKLISTS_CHECK_FAIL: 'spaces.checklists.check.fail',
  CHECKLISTS_DETACH_START: 'spaces.checklists.detach.start',
  CHECKLISTS_DETACH_FINISH: 'spaces.checklists.detach.finish',
  CHECKLISTS_DETACH_FAIL: 'spaces.checklists.detach.fail',

  // ─── Asset versioning (ADR-057) ─────────────────────────────────────
  VERSIONS_LIST_START: 'spaces.items.versions.list.start',
  VERSIONS_LIST_FINISH: 'spaces.items.versions.list.finish',
  VERSIONS_LIST_FAIL: 'spaces.items.versions.list.fail',
  VERSIONS_GET_START: 'spaces.items.versions.get.start',
  VERSIONS_GET_FINISH: 'spaces.items.versions.get.finish',
  VERSIONS_GET_FAIL: 'spaces.items.versions.get.fail',
  VERSIONS_RESTORE_START: 'spaces.items.versions.restore.start',
  VERSIONS_RESTORE_FINISH: 'spaces.items.versions.restore.finish',
  VERSIONS_RESTORE_FAIL: 'spaces.items.versions.restore.fail',
  VERSIONS_ANNOTATE_START: 'spaces.items.versions.annotate.start',
  VERSIONS_ANNOTATE_FINISH: 'spaces.items.versions.annotate.finish',
  VERSIONS_ANNOTATE_FAIL: 'spaces.items.versions.annotate.fail',

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
  // ─── meetings.live (ADR-061 live-meeting banner) ─────────────────────
  MEETINGS_LIVE_START: 'spaces.meetings.live.start',
  MEETINGS_LIVE_FINISH: 'spaces.meetings.live.finish',
  MEETINGS_LIVE_FAIL: 'spaces.meetings.live.fail',
  // ─── getUncategorizedCount ───────────────────────────────────────────
  UNCATEGORIZED_COUNT_START: 'spaces.uncategorizedCount.start',
  UNCATEGORIZED_COUNT_FINISH: 'spaces.uncategorizedCount.finish',
  UNCATEGORIZED_COUNT_FAIL: 'spaces.uncategorizedCount.fail',
  // ─── learn signals (Learning Center, 2026-08-07) ─────────────────────
  PRESENCE_IN_SPACE_START: 'spaces.presence.inSpace.start',
  PRESENCE_IN_SPACE_FINISH: 'spaces.presence.inSpace.finish',
  PRESENCE_IN_SPACE_FAIL: 'spaces.presence.inSpace.fail',
  LEARN_SIGNALS_START: 'spaces.learn.signals.start',
  LEARN_SIGNALS_FINISH: 'spaces.learn.signals.finish',
  LEARN_SIGNALS_FAIL: 'spaces.learn.signals.fail',
  // ─── create (Phase 3a) ───────────────────────────────────────────────
  CREATE_START: 'spaces.create.start',
  CREATE_FINISH: 'spaces.create.finish',
  CREATE_FAIL: 'spaces.create.fail',
  // ─── rename (Phase 3a) ───────────────────────────────────────────────
  RENAME_START: 'spaces.rename.start',
  RENAME_FINISH: 'spaces.rename.finish',
  RENAME_FAIL: 'spaces.rename.fail',
  // ─── update (non-identity fields: description / color / iconKey) ──────
  UPDATE_START: 'spaces.update.start',
  UPDATE_FINISH: 'spaces.update.finish',
  UPDATE_FAIL: 'spaces.update.fail',
  // ─── delete (Phase 3a) ───────────────────────────────────────────────
  DELETE_START: 'spaces.delete.start',
  DELETE_FINISH: 'spaces.delete.finish',
  DELETE_FAIL: 'spaces.delete.fail',
  // ─── undelete (Phase 3a) ─────────────────────────────────────────────
  UNDELETE_START: 'spaces.undelete.start',
  UNDELETE_FINISH: 'spaces.undelete.finish',
  UNDELETE_FAIL: 'spaces.undelete.fail',
  // ─── setSpaceKind (user <-> shared) ──────────────────────────────────
  SET_KIND_START: 'spaces.setKind.start',
  SET_KIND_FINISH: 'spaces.setKind.finish',
  SET_KIND_FAIL: 'spaces.setKind.fail',
  // ─── item mutations (2026-08-08 observability pass) ──────────────────
  // Asset-level CRUD + tag/metadata/space-membership writes. The
  // `items.setMetadata` span also covers `patchMetadata` /
  // `removeMetadataKey` (both funnel through `setMetadata`).
  ITEMS_CREATE_START: 'spaces.items.create.start',
  ITEMS_CREATE_FINISH: 'spaces.items.create.finish',
  ITEMS_CREATE_FAIL: 'spaces.items.create.fail',
  ITEMS_UPDATE_START: 'spaces.items.update.start',
  ITEMS_UPDATE_FINISH: 'spaces.items.update.finish',
  ITEMS_UPDATE_FAIL: 'spaces.items.update.fail',
  ITEMS_DELETE_START: 'spaces.items.delete.start',
  ITEMS_DELETE_FINISH: 'spaces.items.delete.finish',
  ITEMS_DELETE_FAIL: 'spaces.items.delete.fail',
  ITEMS_ADD_TAG_START: 'spaces.items.addTag.start',
  ITEMS_ADD_TAG_FINISH: 'spaces.items.addTag.finish',
  ITEMS_ADD_TAG_FAIL: 'spaces.items.addTag.fail',
  ITEMS_REMOVE_TAG_START: 'spaces.items.removeTag.start',
  ITEMS_REMOVE_TAG_FINISH: 'spaces.items.removeTag.finish',
  ITEMS_REMOVE_TAG_FAIL: 'spaces.items.removeTag.fail',
  ITEMS_SET_METADATA_START: 'spaces.items.setMetadata.start',
  ITEMS_SET_METADATA_FINISH: 'spaces.items.setMetadata.finish',
  ITEMS_SET_METADATA_FAIL: 'spaces.items.setMetadata.fail',
  ITEMS_MOVE_TO_SPACE_START: 'spaces.items.moveToSpace.start',
  ITEMS_MOVE_TO_SPACE_FINISH: 'spaces.items.moveToSpace.finish',
  ITEMS_MOVE_TO_SPACE_FAIL: 'spaces.items.moveToSpace.fail',
  ITEMS_ADD_TO_SPACE_START: 'spaces.items.addToSpace.start',
  ITEMS_ADD_TO_SPACE_FINISH: 'spaces.items.addToSpace.finish',
  ITEMS_ADD_TO_SPACE_FAIL: 'spaces.items.addToSpace.fail',
  ITEMS_REMOVE_FROM_SPACE_START: 'spaces.items.removeFromSpace.start',
  ITEMS_REMOVE_FROM_SPACE_FINISH: 'spaces.items.removeFromSpace.finish',
  ITEMS_REMOVE_FROM_SPACE_FAIL: 'spaces.items.removeFromSpace.fail',
  // ─── ticket mutations ────────────────────────────────────────────────
  TICKETS_CREATE_START: 'spaces.tickets.create.start',
  TICKETS_CREATE_FINISH: 'spaces.tickets.create.finish',
  TICKETS_CREATE_FAIL: 'spaces.tickets.create.fail',
  TICKETS_UPDATE_START: 'spaces.tickets.update.start',
  TICKETS_UPDATE_FINISH: 'spaces.tickets.update.finish',
  TICKETS_UPDATE_FAIL: 'spaces.tickets.update.fail',
  // ─── agent creation (agents-as-assets) ───────────────────────────────
  AGENTS_CREATE_START: 'spaces.agents.create.start',
  AGENTS_CREATE_FINISH: 'spaces.agents.create.finish',
  AGENTS_CREATE_FAIL: 'spaces.agents.create.fail',
  AGENTS_CREATE_FROM_LIBRARY_START: 'spaces.agents.createFromLibrary.start',
  AGENTS_CREATE_FROM_LIBRARY_FINISH: 'spaces.agents.createFromLibrary.finish',
  AGENTS_CREATE_FROM_LIBRARY_FAIL: 'spaces.agents.createFromLibrary.fail',
  // ─── membership mutations (sharing) ──────────────────────────────────
  MEMBERS_ADD_START: 'spaces.members.add.start',
  MEMBERS_ADD_FINISH: 'spaces.members.add.finish',
  MEMBERS_ADD_FAIL: 'spaces.members.add.fail',
  MEMBERS_REMOVE_START: 'spaces.members.remove.start',
  MEMBERS_REMOVE_FINISH: 'spaces.members.remove.finish',
  MEMBERS_REMOVE_FAIL: 'spaces.members.remove.fail',
  // ─── GSX migration sweep (ADR-050) ───────────────────────────────────
  GSX_MIGRATE_START: 'spaces.gsxMigrate.start',
  GSX_MIGRATE_FINISH: 'spaces.gsxMigrate.finish',
  GSX_MIGRATE_FAIL: 'spaces.gsxMigrate.fail',
  /** One inline-stub asset lifted into GSX (or skipped; see data.outcome). */
  // Per-item progress tick. Named `.item.finish` (not bare `.item`) so it
  // conforms to the platform contract's span taxonomy — every spaces
  // event ends .start | .finish | .fail (platform-contract.test.ts).
  GSX_MIGRATE_ITEM: 'spaces.gsxMigrate.item.finish',
  // NOTE: IPC entry events are emitted dynamically as
  // `spaces.ipc.<verb>` by the wrapper in `ipc.ts` (the verb derived
  // from each `lite:spaces:*` channel). They are intentionally NOT
  // enumerated here -- the channel list in `ipc.ts` is the single
  // source of truth, and the conformance meta-test treats the
  // `spaces.ipc.` namespace as dynamically covered (same handling as
  // KV's `kv.${op}` family).
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
  level: 'debug';
  data?: Record<string, never>;
}
export interface SpacesListSpacesFinishEvent extends SpacesEventBase {
  name: typeof SPACES_EVENTS.LIST_SPACES_FINISH;
  level: 'debug';
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
  level: 'debug';
  data: SpacesScopeData;
}
export interface SpacesItemsListFinishEvent extends SpacesEventBase {
  name: typeof SPACES_EVENTS.ITEMS_LIST_FINISH;
  level: 'debug';
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
  level: 'debug';
  data: { itemId: string };
}
export interface SpacesItemsGetFinishEvent extends SpacesEventBase {
  name: typeof SPACES_EVENTS.ITEMS_GET_FINISH;
  level: 'debug';
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
  level: 'debug';
  data?: Record<string, never>;
}
export interface SpacesUncategorizedCountFinishEvent extends SpacesEventBase {
  name: typeof SPACES_EVENTS.UNCATEGORIZED_COUNT_FINISH;
  level: 'debug';
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

// ─── update (description / color / iconKey) ──────────────────────────────

export interface SpacesUpdateStartEvent extends SpacesEventBase {
  name: typeof SPACES_EVENTS.UPDATE_START;
  level: 'info';
  data: SpacesIdData;
}
export interface SpacesUpdateFinishEvent extends SpacesEventBase {
  name: typeof SPACES_EVENTS.UPDATE_FINISH;
  level: 'info';
  durationMs: number;
  data: SpacesIdData;
}
export interface SpacesUpdateFailEvent extends SpacesEventBase {
  name: typeof SPACES_EVENTS.UPDATE_FAIL;
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
// ─── GSX migration sweep (ADR-050) ──────────────────────────────────────

export interface SpacesGsxMigrateStartEvent extends SpacesEventBase {
  name: typeof SPACES_EVENTS.GSX_MIGRATE_START;
  level: 'info';
}
export interface SpacesGsxMigrateFinishEvent extends SpacesEventBase {
  name: typeof SPACES_EVENTS.GSX_MIGRATE_FINISH;
  level: 'info';
  durationMs: number;
  data?: { scanned: number; migrated: number; failed: number };
}
export interface SpacesGsxMigrateFailEvent extends SpacesEventBase {
  name: typeof SPACES_EVENTS.GSX_MIGRATE_FAIL;
  level: 'error';
  durationMs: number;
  error: SerializedEventError;
}
export interface SpacesGsxMigrateItemEvent
  extends Omit<SpacesEventBase, 'spanId'> {
  name: typeof SPACES_EVENTS.GSX_MIGRATE_ITEM;
  level: 'info';
  data: { assetId: string; outcome: 'migrated' | 'skipped' | 'failed'; bytes?: number };
}

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
  | SpacesUpdateStartEvent
  | SpacesUpdateFinishEvent
  | SpacesUpdateFailEvent
  | SpacesDeleteStartEvent
  | SpacesDeleteFinishEvent
  | SpacesDeleteFailEvent
  | SpacesUndeleteStartEvent
  | SpacesUndeleteFinishEvent
  | SpacesUndeleteFailEvent
  | SpacesGsxMigrateStartEvent
  | SpacesGsxMigrateFinishEvent
  | SpacesGsxMigrateFailEvent
  | SpacesGsxMigrateItemEvent;

/**
 * Type-guard. Use to narrow a generic `EventRecord` to the typed
 * `SpacesEvent` union.
 */
export function isSpacesEvent(ev: EventRecord): ev is EventRecord & SpacesEvent {
  return Object.values(SPACES_EVENTS).includes(ev.name as SpacesEventName);
}
