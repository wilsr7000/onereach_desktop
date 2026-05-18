/**
 * Spaces module -- IPC channel registration.
 *
 * Renderer -> main bridge for the renderer-side `window.lite.spaces.*`
 * surface. Channels are prefixed `lite:spaces:` per the registry rule.
 *
 * Phase 0 ships only `OPEN` (so the menu wiring is complete and the
 * Spaces window can launch). Phase 1 lands `LIST_SPACES`,
 * `UNCATEGORIZED_COUNT`, and `ITEMS_LIST`; Phase 2 lands `ITEMS_GET`.
 *
 * @internal
 */

import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { getSpacesApi } from './api.js';
import type { SpacesError } from './errors.js';
import { resolveSpaceScope } from './scope.js';
import type {
  Item,
  ItemSummary,
  ListOpts,
  Space,
  EntityCounts,
  Contributor,
  Event,
  AgentSummary,
  PermissionSummary,
  ContributorWindow,
  CreateSpaceInput,
  DeleteSpaceOpts,
  SpaceKind,
  TicketStatus,
  CreateTicketInput,
  UpdateTicketPatch,
  SetPlaybookResult,
  Person,
  PersonUpsertInput,
  SpaceMember,
  CreateAssetInput,
  DeleteAssetOpts,
  SearchItemsOpts,
  ItemMetadata,
} from './types.js';
import { runDiscovery } from './discovery.js';
import type { DiscoveryResults } from './discovery-format.js';

export const SPACES_IPC = {
  OPEN: 'lite:spaces:open',
  LIST_SPACES: 'lite:spaces:listSpaces',
  UNCATEGORIZED_COUNT: 'lite:spaces:uncategorizedCount',
  ITEMS_LIST: 'lite:spaces:items:list',
  ITEMS_GET: 'lite:spaces:items:get',
  ITEMS_RESOLVE_FILE_URL: 'lite:spaces:items:resolveFileUrl',
  /** Item mutations (Phase 3b). Distinct from Phase 3a Space mutations. */
  ITEMS_UPDATE: 'lite:spaces:items:update',
  ITEMS_ADD_TAG: 'lite:spaces:items:addTag',
  ITEMS_REMOVE_TAG: 'lite:spaces:items:removeTag',
  /** Per-asset activity log (Phase 3c). */
  ITEMS_RECENT_COMMITS: 'lite:spaces:items:recentCommits',
  /** Phase 0.5: run the Q1-Q4 verification queries. */
  DISCOVERY_RUN: 'lite:spaces:discovery:run',
  /** Home view (chunk 3k + 3o). See `lite/spaces/HOME-V1.md`. */
  HOME_ENTITY_COUNTS: 'lite:spaces:home:entityCounts',
  HOME_RECENT_ITEMS: 'lite:spaces:home:recentItems',
  HOME_TOP_CONTRIBUTORS: 'lite:spaces:home:topContributors',
  HOME_RECENT_EVENTS: 'lite:spaces:home:recentEvents',
  HOME_AGENTS_SAMPLE: 'lite:spaces:home:agentsSample',
  HOME_PERMISSION_SUMMARY: 'lite:spaces:home:permissionSummary',
  /** Mutations (Phase 3a). ADR-048. */
  CREATE_SPACE: 'lite:spaces:create',
  RENAME_SPACE: 'lite:spaces:rename',
  DELETE_SPACE: 'lite:spaces:delete',
  UNDELETE_SPACE: 'lite:spaces:undelete',
  /** Phase 4 — shared spaces (playbooks + tickets). */
  SET_SPACE_KIND: 'lite:spaces:setKind',
  PLAYBOOKS_CURRENT: 'lite:spaces:playbooks:current',
  PLAYBOOKS_SET: 'lite:spaces:playbooks:set',
  TICKETS_LIST: 'lite:spaces:tickets:list',
  TICKETS_CREATE: 'lite:spaces:tickets:create',
  TICKETS_UPDATE: 'lite:spaces:tickets:update',
  /** Phase 4 v2 — identity + sharing. */
  IDENTITY_GET_OR_CREATE_PERSON: 'lite:spaces:identity:getOrCreatePerson',
  MEMBERS_LIST: 'lite:spaces:members:list',
  MEMBERS_ADD: 'lite:spaces:members:add',
  MEMBERS_REMOVE: 'lite:spaces:members:remove',
  /** Sprint 1 — asset CRUD. */
  ITEMS_CREATE: 'lite:spaces:items:create',
  ITEMS_DELETE: 'lite:spaces:items:delete',
  ITEMS_RESTORE: 'lite:spaces:items:restore',
  /** Sprint 3 — move / copy / search. */
  ITEMS_MOVE_TO_SPACE: 'lite:spaces:items:moveToSpace',
  ITEMS_ADD_TO_SPACE: 'lite:spaces:items:addToSpace',
  ITEMS_REMOVE_FROM_SPACE: 'lite:spaces:items:removeFromSpace',
  ITEMS_SEARCH: 'lite:spaces:items:search',
  /** Metadata sprint. */
  ITEMS_SET_METADATA: 'lite:spaces:items:setMetadata',
  ITEMS_PATCH_METADATA: 'lite:spaces:items:patchMetadata',
  ITEMS_REMOVE_METADATA_KEY: 'lite:spaces:items:removeMetadataKey',
} as const;

/**
 * Envelope wrapping the success or failure of an SDK call when the
 * value crosses the IPC boundary. Errors don't serialize through
 * `ipcMain.handle` losslessly, so we project them into a structured
 * envelope the renderer can re-throw.
 */
export type SpacesIpcResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      error: {
        code: string;
        message: string;
        remediation?: string;
        context?: Record<string, unknown>;
      };
    };

interface RegisterOpts {
  /** Called for `OPEN` -- the menu wiring boils down to this. */
  onOpen: () => void;
}

let registered = false;

/**
 * Register every Spaces IPC handler. Idempotent: safe to call across
 * test re-init cycles. Pair with `unregisterSpacesIpc()` on teardown.
 */
export function registerSpacesIpc(opts: RegisterOpts): void {
  if (registered) return;

  ipcMain.handle(SPACES_IPC.OPEN, (_event: IpcMainInvokeEvent): { ok: true } => {
    opts.onOpen();
    return { ok: true };
  });

  ipcMain.handle(
    SPACES_IPC.LIST_SPACES,
    async (_event: IpcMainInvokeEvent): Promise<SpacesIpcResult<Space[]>> => {
      try {
        const value = await getSpacesApi().listSpaces();
        return { ok: true, value };
      } catch (err) {
        return { ok: false, error: serializeError(err) };
      }
    }
  );

  ipcMain.handle(
    SPACES_IPC.UNCATEGORIZED_COUNT,
    async (_event: IpcMainInvokeEvent): Promise<SpacesIpcResult<number>> => {
      try {
        const value = await getSpacesApi().getUncategorizedCount();
        return { ok: true, value };
      } catch (err) {
        return { ok: false, error: serializeError(err) };
      }
    }
  );

  ipcMain.handle(
    SPACES_IPC.ITEMS_LIST,
    async (
      _event: IpcMainInvokeEvent,
      payload?: { scopeId?: unknown; opts?: unknown }
    ): Promise<SpacesIpcResult<ItemSummary[]>> => {
      try {
        const scopeId =
          payload !== undefined && typeof payload.scopeId === 'string'
            ? payload.scopeId
            : '';
        const opts = isListOpts(payload?.opts) ? payload.opts : undefined;
        const scope = resolveSpaceScope(scopeId);
        const value = await getSpacesApi().items.list(scope, opts);
        return { ok: true, value };
      } catch (err) {
        return { ok: false, error: serializeError(err) };
      }
    }
  );

  ipcMain.handle(
    SPACES_IPC.ITEMS_GET,
    async (
      _event: IpcMainInvokeEvent,
      payload?: { id?: unknown }
    ): Promise<SpacesIpcResult<Item | null>> => {
      try {
        const id =
          payload !== undefined && typeof payload.id === 'string'
            ? payload.id
            : '';
        const value = await getSpacesApi().items.get(id);
        return { ok: true, value };
      } catch (err) {
        return { ok: false, error: serializeError(err) };
      }
    }
  );

  ipcMain.handle(
    SPACES_IPC.ITEMS_RESOLVE_FILE_URL,
    async (
      _event: IpcMainInvokeEvent,
      payload?: { key?: unknown }
    ): Promise<SpacesIpcResult<string | null>> => {
      try {
        const key =
          payload !== undefined && typeof payload.key === 'string'
            ? payload.key
            : '';
        const value = await getSpacesApi().items.resolveFileUrl(key);
        return { ok: true, value };
      } catch (err) {
        return { ok: false, error: serializeError(err) };
      }
    }
  );

  // Phase 3b — item mutation handlers. Distinct from Phase 3a Space
  // mutations: these write to :Asset / :Tag.
  ipcMain.handle(
    SPACES_IPC.ITEMS_UPDATE,
    async (
      _event: IpcMainInvokeEvent,
      payload?: { id?: unknown; patch?: unknown }
    ): Promise<SpacesIpcResult<Item>> => {
      try {
        const id =
          payload !== undefined && typeof payload.id === 'string'
            ? payload.id
            : '';
        const patch =
          payload !== undefined && payload.patch !== null && typeof payload.patch === 'object'
            ? (payload.patch as Record<string, unknown>)
            : {};
        const value = await getSpacesApi().items.update(id, patch);
        return { ok: true, value };
      } catch (err) {
        return { ok: false, error: serializeError(err) };
      }
    }
  );

  ipcMain.handle(
    SPACES_IPC.ITEMS_ADD_TAG,
    async (
      _event: IpcMainInvokeEvent,
      payload?: { id?: unknown; tag?: unknown }
    ): Promise<SpacesIpcResult<string[]>> => {
      try {
        const id =
          payload !== undefined && typeof payload.id === 'string'
            ? payload.id
            : '';
        const tag =
          payload !== undefined && typeof payload.tag === 'string'
            ? payload.tag
            : '';
        const value = await getSpacesApi().items.addTag(id, tag);
        return { ok: true, value };
      } catch (err) {
        return { ok: false, error: serializeError(err) };
      }
    }
  );

  ipcMain.handle(
    SPACES_IPC.ITEMS_REMOVE_TAG,
    async (
      _event: IpcMainInvokeEvent,
      payload?: { id?: unknown; tag?: unknown }
    ): Promise<SpacesIpcResult<string[]>> => {
      try {
        const id =
          payload !== undefined && typeof payload.id === 'string'
            ? payload.id
            : '';
        const tag =
          payload !== undefined && typeof payload.tag === 'string'
            ? payload.tag
            : '';
        const value = await getSpacesApi().items.removeTag(id, tag);
        return { ok: true, value };
      } catch (err) {
        return { ok: false, error: serializeError(err) };
      }
    }
  );

  // Phase 3c — per-asset activity log. Returns recent commits referencing
  // the given asset.
  ipcMain.handle(
    SPACES_IPC.ITEMS_RECENT_COMMITS,
    async (
      _event: IpcMainInvokeEvent,
      payload?: { id?: unknown; limit?: unknown; since?: unknown }
    ): Promise<SpacesIpcResult<Event[]>> => {
      try {
        const id =
          payload !== undefined && typeof payload.id === 'string'
            ? payload.id
            : '';
        const opts: { limit?: number; since?: number } = {};
        if (isPositiveInteger(payload?.limit)) opts.limit = payload?.limit as number;
        if (
          typeof payload?.since === 'number' &&
          Number.isFinite(payload?.since) &&
          (payload?.since as number) >= 0
        ) {
          opts.since = payload?.since as number;
        }
        const value = await getSpacesApi().items.recentCommits(id, opts);
        return { ok: true, value };
      } catch (err) {
        return { ok: false, error: serializeError(err) };
      }
    }
  );

  // Phase 0.5: discovery. Runs Q1-Q4 via getNeonApi() and returns the
  // structured envelope. runDiscovery() never throws -- per-query
  // failures land in the envelope -- so this handler always returns
  // ok=true. The runner result itself encodes pass/fail per query.
  ipcMain.handle(
    SPACES_IPC.DISCOVERY_RUN,
    async (_event: IpcMainInvokeEvent): Promise<SpacesIpcResult<DiscoveryResults>> => {
      try {
        const value = await runDiscovery();
        return { ok: true, value };
      } catch (err) {
        return { ok: false, error: serializeError(err) };
      }
    }
  );

  // ─── Home view (chunk 3k + 3o) ─────────────────────────────────────────
  //
  // Six read-only handlers powering the Home news-feed cards. All
  // delegate to the SpacesApi singleton; errors normalize through the
  // existing `serializeError` helper. Detail in
  // `lite/spaces/HOME-V1.md`.

  ipcMain.handle(
    SPACES_IPC.HOME_ENTITY_COUNTS,
    async (_event: IpcMainInvokeEvent): Promise<SpacesIpcResult<EntityCounts>> => {
      try {
        const value = await getSpacesApi().getEntityCounts();
        return { ok: true, value };
      } catch (err) {
        return { ok: false, error: serializeError(err) };
      }
    }
  );

  ipcMain.handle(
    SPACES_IPC.HOME_RECENT_ITEMS,
    async (
      _event: IpcMainInvokeEvent,
      payload?: { limit?: unknown }
    ): Promise<SpacesIpcResult<ItemSummary[]>> => {
      try {
        const limit = isPositiveInteger(payload?.limit) ? (payload?.limit as number) : undefined;
        const opts = limit !== undefined ? { limit } : undefined;
        const value = await getSpacesApi().listRecentItems(opts);
        return { ok: true, value };
      } catch (err) {
        return { ok: false, error: serializeError(err) };
      }
    }
  );

  ipcMain.handle(
    SPACES_IPC.HOME_TOP_CONTRIBUTORS,
    async (
      _event: IpcMainInvokeEvent,
      payload?: { window?: unknown; limit?: unknown }
    ): Promise<SpacesIpcResult<Contributor[]>> => {
      try {
        const opts: { window?: ContributorWindow; limit?: number } = {};
        if (isContributorWindow(payload?.window)) opts.window = payload?.window as ContributorWindow;
        if (isPositiveInteger(payload?.limit)) opts.limit = payload?.limit as number;
        const value = await getSpacesApi().topContributors(opts);
        return { ok: true, value };
      } catch (err) {
        return { ok: false, error: serializeError(err) };
      }
    }
  );

  ipcMain.handle(
    SPACES_IPC.HOME_RECENT_EVENTS,
    async (
      _event: IpcMainInvokeEvent,
      payload?: { limit?: unknown; since?: unknown; spaceId?: unknown }
    ): Promise<SpacesIpcResult<Event[]>> => {
      try {
        const opts: { limit?: number; since?: number; spaceId?: string } = {};
        if (isPositiveInteger(payload?.limit)) opts.limit = payload?.limit as number;
        if (
          typeof payload?.since === 'number' &&
          Number.isFinite(payload?.since) &&
          payload?.since >= 0
        ) {
          opts.since = Math.floor(payload.since as number);
        }
        if (typeof payload?.spaceId === 'string' && payload.spaceId.length > 0) {
          opts.spaceId = payload.spaceId;
        }
        const value = await getSpacesApi().listRecentEvents(opts);
        return { ok: true, value };
      } catch (err) {
        return { ok: false, error: serializeError(err) };
      }
    }
  );

  ipcMain.handle(
    SPACES_IPC.HOME_AGENTS_SAMPLE,
    async (
      _event: IpcMainInvokeEvent,
      payload?: { limit?: unknown }
    ): Promise<SpacesIpcResult<AgentSummary[]>> => {
      try {
        const limit = isPositiveInteger(payload?.limit) ? (payload?.limit as number) : undefined;
        const opts = limit !== undefined ? { limit } : undefined;
        const value = await getSpacesApi().listAgentsSample(opts);
        return { ok: true, value };
      } catch (err) {
        return { ok: false, error: serializeError(err) };
      }
    }
  );

  ipcMain.handle(
    SPACES_IPC.HOME_PERMISSION_SUMMARY,
    async (_event: IpcMainInvokeEvent): Promise<SpacesIpcResult<PermissionSummary>> => {
      try {
        const value = await getSpacesApi().getPermissionSummary();
        return { ok: true, value };
      } catch (err) {
        return { ok: false, error: serializeError(err) };
      }
    }
  );

  // ─── Mutations (Phase 3a) ────────────────────────────────────────────
  //
  // Each handler validates the payload shape minimally (type guards),
  // then delegates to the singleton. Argument validation (empty name,
  // too-long name, etc.) happens in the SDK client; the IPC layer
  // surfaces those as `SPACES_INVALID_INPUT` via the standard envelope.

  ipcMain.handle(
    SPACES_IPC.CREATE_SPACE,
    async (
      _event: IpcMainInvokeEvent,
      payload?: { input?: unknown }
    ): Promise<SpacesIpcResult<Space>> => {
      try {
        const input = coerceCreateSpaceInput(payload?.input);
        const value = await getSpacesApi().createSpace(input);
        return { ok: true, value };
      } catch (err) {
        return { ok: false, error: serializeError(err) };
      }
    }
  );

  ipcMain.handle(
    SPACES_IPC.RENAME_SPACE,
    async (
      _event: IpcMainInvokeEvent,
      payload?: { id?: unknown; name?: unknown }
    ): Promise<SpacesIpcResult<Space>> => {
      try {
        const id = typeof payload?.id === 'string' ? payload.id : '';
        const name = typeof payload?.name === 'string' ? payload.name : '';
        const value = await getSpacesApi().renameSpace(id, name);
        return { ok: true, value };
      } catch (err) {
        return { ok: false, error: serializeError(err) };
      }
    }
  );

  ipcMain.handle(
    SPACES_IPC.DELETE_SPACE,
    async (
      _event: IpcMainInvokeEvent,
      payload?: { id?: unknown; opts?: unknown }
    ): Promise<SpacesIpcResult<{ ok: true }>> => {
      try {
        const id = typeof payload?.id === 'string' ? payload.id : '';
        const opts = coerceDeleteSpaceOpts(payload?.opts);
        await getSpacesApi().deleteSpace(id, opts);
        return { ok: true, value: { ok: true } };
      } catch (err) {
        return { ok: false, error: serializeError(err) };
      }
    }
  );

  ipcMain.handle(
    SPACES_IPC.UNDELETE_SPACE,
    async (
      _event: IpcMainInvokeEvent,
      payload?: { id?: unknown }
    ): Promise<SpacesIpcResult<Space>> => {
      try {
        const id = typeof payload?.id === 'string' ? payload.id : '';
        const value = await getSpacesApi().undeleteSpace(id);
        return { ok: true, value };
      } catch (err) {
        return { ok: false, error: serializeError(err) };
      }
    }
  );

  // ─── Phase 4: shared spaces (playbooks + tickets) ──────────────────────

  ipcMain.handle(
    SPACES_IPC.SET_SPACE_KIND,
    async (
      _event: IpcMainInvokeEvent,
      payload?: { id?: unknown; kind?: unknown }
    ): Promise<SpacesIpcResult<SpaceKind>> => {
      try {
        const id = typeof payload?.id === 'string' ? payload.id : '';
        const kind =
          payload?.kind === 'shared' || payload?.kind === 'user'
            ? (payload.kind as SpaceKind)
            : ('user' as SpaceKind);
        const value = await getSpacesApi().setSpaceKind(id, kind);
        return { ok: true, value };
      } catch (err) {
        return { ok: false, error: serializeError(err) };
      }
    }
  );

  ipcMain.handle(
    SPACES_IPC.PLAYBOOKS_CURRENT,
    async (
      _event: IpcMainInvokeEvent,
      payload?: { spaceId?: unknown }
    ): Promise<SpacesIpcResult<Item | null>> => {
      try {
        const spaceId = typeof payload?.spaceId === 'string' ? payload.spaceId : '';
        const value = await getSpacesApi().playbooks.current(spaceId);
        return { ok: true, value };
      } catch (err) {
        return { ok: false, error: serializeError(err) };
      }
    }
  );

  ipcMain.handle(
    SPACES_IPC.PLAYBOOKS_SET,
    async (
      _event: IpcMainInvokeEvent,
      payload?: { spaceId?: unknown; playbookId?: unknown }
    ): Promise<SpacesIpcResult<SetPlaybookResult>> => {
      try {
        const spaceId = typeof payload?.spaceId === 'string' ? payload.spaceId : '';
        const playbookId =
          typeof payload?.playbookId === 'string' ? payload.playbookId : '';
        const value = await getSpacesApi().playbooks.set(spaceId, playbookId);
        return { ok: true, value };
      } catch (err) {
        return { ok: false, error: serializeError(err) };
      }
    }
  );

  ipcMain.handle(
    SPACES_IPC.TICKETS_LIST,
    async (
      _event: IpcMainInvokeEvent,
      payload?: { spaceId?: unknown; status?: unknown; limit?: unknown; offset?: unknown }
    ): Promise<SpacesIpcResult<Item[]>> => {
      try {
        const spaceId = typeof payload?.spaceId === 'string' ? payload.spaceId : '';
        const opts: { status?: TicketStatus; limit?: number; offset?: number } = {};
        if (isTicketStatus(payload?.status)) opts.status = payload?.status as TicketStatus;
        if (isPositiveInteger(payload?.limit)) opts.limit = payload?.limit as number;
        if (
          typeof payload?.offset === 'number' &&
          Number.isFinite(payload?.offset) &&
          (payload?.offset as number) >= 0
        ) {
          opts.offset = payload?.offset as number;
        }
        const value = await getSpacesApi().tickets.list(spaceId, opts);
        return { ok: true, value };
      } catch (err) {
        return { ok: false, error: serializeError(err) };
      }
    }
  );

  ipcMain.handle(
    SPACES_IPC.TICKETS_CREATE,
    async (
      _event: IpcMainInvokeEvent,
      payload?: { spaceId?: unknown; input?: unknown }
    ): Promise<SpacesIpcResult<Item>> => {
      try {
        const spaceId = typeof payload?.spaceId === 'string' ? payload.spaceId : '';
        const input =
          payload?.input !== null && typeof payload?.input === 'object'
            ? (payload?.input as CreateTicketInput)
            : ({ title: '' } as CreateTicketInput);
        const value = await getSpacesApi().tickets.create(spaceId, input);
        return { ok: true, value };
      } catch (err) {
        return { ok: false, error: serializeError(err) };
      }
    }
  );

  ipcMain.handle(
    SPACES_IPC.TICKETS_UPDATE,
    async (
      _event: IpcMainInvokeEvent,
      payload?: { id?: unknown; patch?: unknown }
    ): Promise<SpacesIpcResult<Item>> => {
      try {
        const id = typeof payload?.id === 'string' ? payload.id : '';
        const patch =
          payload?.patch !== null && typeof payload?.patch === 'object'
            ? (payload?.patch as UpdateTicketPatch)
            : ({} as UpdateTicketPatch);
        const value = await getSpacesApi().tickets.update(id, patch);
        return { ok: true, value };
      } catch (err) {
        return { ok: false, error: serializeError(err) };
      }
    }
  );

  // ─── Identity + sharing (Phase 4 v2) ──────────────────────────────────

  ipcMain.handle(
    SPACES_IPC.IDENTITY_GET_OR_CREATE_PERSON,
    async (
      _event: IpcMainInvokeEvent,
      payload?: { input?: unknown }
    ): Promise<SpacesIpcResult<Person>> => {
      try {
        const input =
          payload?.input !== null && typeof payload?.input === 'object'
            ? (payload?.input as PersonUpsertInput)
            : ({ id: '' } as PersonUpsertInput);
        const value = await getSpacesApi().identity.getOrCreatePerson(input);
        return { ok: true, value };
      } catch (err) {
        return { ok: false, error: serializeError(err) };
      }
    }
  );

  ipcMain.handle(
    SPACES_IPC.MEMBERS_LIST,
    async (
      _event: IpcMainInvokeEvent,
      payload?: { spaceId?: unknown }
    ): Promise<SpacesIpcResult<SpaceMember[]>> => {
      try {
        const spaceId = typeof payload?.spaceId === 'string' ? payload.spaceId : '';
        const value = await getSpacesApi().members.list(spaceId);
        return { ok: true, value };
      } catch (err) {
        return { ok: false, error: serializeError(err) };
      }
    }
  );

  ipcMain.handle(
    SPACES_IPC.MEMBERS_ADD,
    async (
      _event: IpcMainInvokeEvent,
      payload?: { spaceId?: unknown; memberId?: unknown }
    ): Promise<SpacesIpcResult<SpaceMember>> => {
      try {
        const spaceId = typeof payload?.spaceId === 'string' ? payload.spaceId : '';
        const memberId =
          typeof payload?.memberId === 'string' ? payload.memberId : '';
        const value = await getSpacesApi().members.add(spaceId, memberId);
        return { ok: true, value };
      } catch (err) {
        return { ok: false, error: serializeError(err) };
      }
    }
  );

  ipcMain.handle(
    SPACES_IPC.MEMBERS_REMOVE,
    async (
      _event: IpcMainInvokeEvent,
      payload?: { spaceId?: unknown; memberId?: unknown }
    ): Promise<SpacesIpcResult<{ ok: true }>> => {
      try {
        const spaceId = typeof payload?.spaceId === 'string' ? payload.spaceId : '';
        const memberId =
          typeof payload?.memberId === 'string' ? payload.memberId : '';
        await getSpacesApi().members.remove(spaceId, memberId);
        return { ok: true, value: { ok: true } };
      } catch (err) {
        return { ok: false, error: serializeError(err) };
      }
    }
  );

  // ─── Asset CRUD (Sprint 1) ─────────────────────────────────────────────

  ipcMain.handle(
    SPACES_IPC.ITEMS_CREATE,
    async (
      _event: IpcMainInvokeEvent,
      payload?: { input?: unknown }
    ): Promise<SpacesIpcResult<Item>> => {
      try {
        const input =
          payload?.input !== null && typeof payload?.input === 'object'
            ? (payload?.input as CreateAssetInput)
            : ({ spaceId: '', title: '' } as CreateAssetInput);
        const value = await getSpacesApi().items.create(input);
        return { ok: true, value };
      } catch (err) {
        return { ok: false, error: serializeError(err) };
      }
    }
  );

  ipcMain.handle(
    SPACES_IPC.ITEMS_DELETE,
    async (
      _event: IpcMainInvokeEvent,
      payload?: { id?: unknown; opts?: unknown }
    ): Promise<SpacesIpcResult<{ ok: true }>> => {
      try {
        const id = typeof payload?.id === 'string' ? payload.id : '';
        const opts =
          payload?.opts !== null && typeof payload?.opts === 'object'
            ? (payload?.opts as DeleteAssetOpts)
            : ({} as DeleteAssetOpts);
        await getSpacesApi().items.delete(id, opts);
        return { ok: true, value: { ok: true } };
      } catch (err) {
        return { ok: false, error: serializeError(err) };
      }
    }
  );

  ipcMain.handle(
    SPACES_IPC.ITEMS_RESTORE,
    async (
      _event: IpcMainInvokeEvent,
      payload?: { id?: unknown }
    ): Promise<SpacesIpcResult<Item>> => {
      try {
        const id = typeof payload?.id === 'string' ? payload.id : '';
        const value = await getSpacesApi().items.restore(id);
        return { ok: true, value };
      } catch (err) {
        return { ok: false, error: serializeError(err) };
      }
    }
  );

  // ─── Sprint 3: move / copy / search ──────────────────────────────────

  ipcMain.handle(
    SPACES_IPC.ITEMS_MOVE_TO_SPACE,
    async (
      _event: IpcMainInvokeEvent,
      payload?: { id?: unknown; fromSpaceId?: unknown; toSpaceId?: unknown }
    ): Promise<SpacesIpcResult<Item>> => {
      try {
        const id = typeof payload?.id === 'string' ? payload.id : '';
        const fromSpaceId =
          typeof payload?.fromSpaceId === 'string' ? payload.fromSpaceId : null;
        const toSpaceId =
          typeof payload?.toSpaceId === 'string' ? payload.toSpaceId : '';
        const value = await getSpacesApi().items.moveToSpace(
          id,
          fromSpaceId,
          toSpaceId
        );
        return { ok: true, value };
      } catch (err) {
        return { ok: false, error: serializeError(err) };
      }
    }
  );

  ipcMain.handle(
    SPACES_IPC.ITEMS_ADD_TO_SPACE,
    async (
      _event: IpcMainInvokeEvent,
      payload?: { id?: unknown; toSpaceId?: unknown }
    ): Promise<SpacesIpcResult<Item>> => {
      try {
        const id = typeof payload?.id === 'string' ? payload.id : '';
        const toSpaceId =
          typeof payload?.toSpaceId === 'string' ? payload.toSpaceId : '';
        const value = await getSpacesApi().items.addToSpace(id, toSpaceId);
        return { ok: true, value };
      } catch (err) {
        return { ok: false, error: serializeError(err) };
      }
    }
  );

  ipcMain.handle(
    SPACES_IPC.ITEMS_REMOVE_FROM_SPACE,
    async (
      _event: IpcMainInvokeEvent,
      payload?: { id?: unknown; spaceId?: unknown }
    ): Promise<SpacesIpcResult<Item>> => {
      try {
        const id = typeof payload?.id === 'string' ? payload.id : '';
        const spaceId =
          typeof payload?.spaceId === 'string' ? payload.spaceId : '';
        const value = await getSpacesApi().items.removeFromSpace(id, spaceId);
        return { ok: true, value };
      } catch (err) {
        return { ok: false, error: serializeError(err) };
      }
    }
  );

  ipcMain.handle(
    SPACES_IPC.ITEMS_SEARCH,
    async (
      _event: IpcMainInvokeEvent,
      payload?: { opts?: unknown }
    ): Promise<SpacesIpcResult<ItemSummary[]>> => {
      try {
        const opts =
          payload?.opts !== null && typeof payload?.opts === 'object'
            ? (payload?.opts as SearchItemsOpts)
            : ({ query: '' } as SearchItemsOpts);
        const value = await getSpacesApi().items.search(opts);
        return { ok: true, value };
      } catch (err) {
        return { ok: false, error: serializeError(err) };
      }
    }
  );

  // ─── Metadata mutations ───────────────────────────────────────────────

  ipcMain.handle(
    SPACES_IPC.ITEMS_SET_METADATA,
    async (
      _event: IpcMainInvokeEvent,
      payload?: { id?: unknown; metadata?: unknown }
    ): Promise<SpacesIpcResult<Item>> => {
      try {
        const id = typeof payload?.id === 'string' ? payload.id : '';
        const metadata =
          payload?.metadata !== null && typeof payload?.metadata === 'object'
            ? (payload?.metadata as ItemMetadata)
            : ({} as ItemMetadata);
        const value = await getSpacesApi().items.setMetadata(id, metadata);
        return { ok: true, value };
      } catch (err) {
        return { ok: false, error: serializeError(err) };
      }
    }
  );

  ipcMain.handle(
    SPACES_IPC.ITEMS_PATCH_METADATA,
    async (
      _event: IpcMainInvokeEvent,
      payload?: { id?: unknown; patch?: unknown }
    ): Promise<SpacesIpcResult<Item>> => {
      try {
        const id = typeof payload?.id === 'string' ? payload.id : '';
        const patch =
          payload?.patch !== null && typeof payload?.patch === 'object'
            ? (payload?.patch as ItemMetadata)
            : ({} as ItemMetadata);
        const value = await getSpacesApi().items.patchMetadata(id, patch);
        return { ok: true, value };
      } catch (err) {
        return { ok: false, error: serializeError(err) };
      }
    }
  );

  ipcMain.handle(
    SPACES_IPC.ITEMS_REMOVE_METADATA_KEY,
    async (
      _event: IpcMainInvokeEvent,
      payload?: { id?: unknown; key?: unknown }
    ): Promise<SpacesIpcResult<Item>> => {
      try {
        const id = typeof payload?.id === 'string' ? payload.id : '';
        const key = typeof payload?.key === 'string' ? payload.key : '';
        const value = await getSpacesApi().items.removeMetadataKey(id, key);
        return { ok: true, value };
      } catch (err) {
        return { ok: false, error: serializeError(err) };
      }
    }
  );

  registered = true;
}

function isTicketStatus(v: unknown): v is TicketStatus {
  return v === 'open' || v === 'in_progress' || v === 'done' || v === 'blocked';
}

function coerceCreateSpaceInput(raw: unknown): CreateSpaceInput {
  if (raw === null || typeof raw !== 'object') {
    // Let the SDK throw SPACES_INVALID_INPUT with a uniform message.
    return { name: '' };
  }
  const r = raw as Record<string, unknown>;
  const input: CreateSpaceInput = {
    name: typeof r['name'] === 'string' ? (r['name'] as string) : '',
  };
  if (typeof r['description'] === 'string') input.description = r['description'] as string;
  if (typeof r['color'] === 'string') input.color = r['color'] as string;
  if (typeof r['iconKey'] === 'string') input.iconKey = r['iconKey'] as string;
  return input;
}

function coerceDeleteSpaceOpts(raw: unknown): DeleteSpaceOpts | undefined {
  if (raw === undefined || raw === null || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const opts: DeleteSpaceOpts = {};
  if (typeof r['soft'] === 'boolean') opts.soft = r['soft'] as boolean;
  return opts;
}

/** Remove every Spaces IPC handler. Idempotent. */
export function unregisterSpacesIpc(): void {
  if (!registered) return;
  for (const channel of Object.values(SPACES_IPC)) {
    try {
      ipcMain.removeHandler(channel);
    } catch {
      // best-effort
    }
  }
  registered = false;
}

/** @internal -- for tests. */
export function _isSpacesIpcRegisteredForTesting(): boolean {
  return registered;
}

function isListOpts(v: unknown): v is ListOpts {
  if (v === undefined || v === null || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  if ('limit' in o && typeof o['limit'] !== 'number') return false;
  if ('offset' in o && typeof o['offset'] !== 'number') return false;
  return true;
}

function isPositiveInteger(v: unknown): boolean {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

function isContributorWindow(v: unknown): v is ContributorWindow {
  return v === 'day' || v === 'week' || v === 'month';
}

function serializeError(err: unknown): {
  code: string;
  message: string;
  remediation?: string;
  context?: Record<string, unknown>;
} {
  if (err !== null && typeof err === 'object' && 'code' in err && 'message' in err) {
    const e = err as SpacesError;
    const out: {
      code: string;
      message: string;
      remediation?: string;
      context?: Record<string, unknown>;
    } = {
      code: typeof e.code === 'string' ? e.code : 'SPACES_UNKNOWN',
      message: typeof e.message === 'string' ? e.message : String(err),
    };
    if (typeof e.remediation === 'string') out.remediation = e.remediation;
    if (e.context !== null && typeof e.context === 'object') {
      out.context = e.context as Record<string, unknown>;
    }
    return out;
  }
  return {
    code: 'SPACES_UNKNOWN',
    message: err instanceof Error ? err.message : String(err),
  };
}
