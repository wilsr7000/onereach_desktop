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
import { getLoggingApi } from '../logging/api.js';
import type { SpacesError } from './errors.js';
import { resolveSpaceScope } from './scope.js';
import type {
  AssetVersion,
  AssetVersionSummary,
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
  UpdateSpaceInput,
  SpaceKind,
  TicketStatus,
  CreateTicketInput,
  UpdateTicketPatch,
  SetPlaybookResult,
  Person,
  PersonUpsertInput,
  SpaceMember,
  Checklist,
  TicketChecklist,
  CreateChecklistInput,
  UpdateChecklistInput,
  ChecklistDraft,
  AttachChecklistInput,
  SetChecklistItemInput,
  CreateAssetInput,
  CreateBinaryAssetInput,
  CreateAgentInput,
  CreateAgentFromLibraryInput,
  AgentLibraryEntry,
  MemberLibraryEntry,
  DeleteAssetOpts,
  SearchItemsOpts,
  ItemMetadata,
  AssetViewer,
  JourneyDraft,
} from './types.js';
import { runDiscovery } from './discovery.js';
import { openWiserPlaybooksWindow } from '../wiser-playbooks-window.js';
import type { DiscoveryResults } from './discovery-format.js';

export const SPACES_IPC = {
  OPEN: 'lite:spaces:open',
  /** Spaces↔WISER bridge: open the Playbooks window, optionally at a riff. */
  OPEN_WISER: 'lite:spaces:openWiser',
  LIST_SPACES: 'lite:spaces:listSpaces',
  REFRESH: 'lite:spaces:refresh',
  ITEMS_READ_FILE_DATA: 'lite:spaces:items:readFileData',
  UNCATEGORIZED_COUNT: 'lite:spaces:uncategorizedCount',
  ITEMS_LIST: 'lite:spaces:items:list',
  ITEMS_GET: 'lite:spaces:items:get',
  ITEMS_RESOLVE_FILE_URL: 'lite:spaces:items:resolveFileUrl',
  /** ADR-052 — the bucket's authoritative scheduled deletion. */
  ITEMS_GET_FILE_EXPIRY: 'lite:spaces:items:getFileExpiry',
  /** Item mutations (Phase 3b). Distinct from Phase 3a Space mutations. */
  ITEMS_UPDATE: 'lite:spaces:items:update',
  ITEMS_ADD_TAG: 'lite:spaces:items:addTag',
  ITEMS_REMOVE_TAG: 'lite:spaces:items:removeTag',
  /** Per-asset activity log (Phase 3c). */
  ITEMS_RECENT_COMMITS: 'lite:spaces:items:recentCommits',
  /** Audit trail — record/read who viewed an asset. */
  ITEMS_RECORD_VIEW: 'lite:spaces:items:recordView',
  ITEMS_VIEWERS: 'lite:spaces:items:viewers',
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
  UPDATE_SPACE: 'lite:spaces:update',
  PIN_SPACE: 'lite:spaces:pin',
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
  MEMBERS_SEARCH_LIBRARY: 'lite:spaces:members:searchLibrary',
  IDENTITY_ATTRIBUTION_EMAIL_GET: 'lite:spaces:identity:attributionEmail:get',
  IDENTITY_ATTRIBUTION_EMAIL_SET: 'lite:spaces:identity:attributionEmail:set',
  MEMBERS_REMOVE: 'lite:spaces:members:remove',
  /** Identity gate — first-run sign-in (2026-08-13). Main-process only
   * `signIn()` stays main-side; the renderer merely requests it. */
  AUTH_SIGN_IN: 'lite:spaces:auth:signIn',
  /** ADR-055 — checklists. */
  CHECKLISTS_CREATE: 'lite:spaces:checklists:create',
  CHECKLISTS_LIST: 'lite:spaces:checklists:list',
  CHECKLISTS_UPDATE: 'lite:spaces:checklists:update',
  CHECKLISTS_DRAFT: 'lite:spaces:checklists:draft',
  /** ADR-072 — journey maps (Planning). */
  JOURNEYS_DRAFT: 'lite:spaces:journeys:draft',
  JOURNEYS_CREATE: 'lite:spaces:journeys:create',
  CHECKLISTS_REMOVE: 'lite:spaces:checklists:remove',
  CHECKLISTS_ATTACH: 'lite:spaces:checklists:attach',
  CHECKLISTS_FOR_TICKET: 'lite:spaces:checklists:forTicket',
  CHECKLISTS_SET_ITEM: 'lite:spaces:checklists:setItem',
  CHECKLISTS_DETACH: 'lite:spaces:checklists:detach',
  /** Sprint 1 — asset CRUD. */
  ITEMS_CREATE: 'lite:spaces:items:create',
  ITEMS_CREATE_BINARY: 'lite:spaces:items:createBinary',
  ITEMS_CREATE_AGENT: 'lite:spaces:items:createAgent',
  ITEMS_AGENT_LIBRARY_SEARCH: 'lite:spaces:items:agentLibrarySearch',
  ITEMS_CREATE_AGENT_FROM_LIBRARY: 'lite:spaces:items:createAgentFromLibrary',
  ITEMS_DELETE: 'lite:spaces:items:delete',
  ITEMS_RESTORE: 'lite:spaces:items:restore',
  /** Sprint 3 — move / copy / search. */
  ITEMS_MOVE_TO_SPACE: 'lite:spaces:items:moveToSpace',
  ITEMS_ADD_TO_SPACE: 'lite:spaces:items:addToSpace',
  ITEMS_REMOVE_FROM_SPACE: 'lite:spaces:items:removeFromSpace',
  ITEMS_SEARCH: 'lite:spaces:items:search',
  /** Asset versioning (ADR-057). */
  ITEMS_VERSIONS: 'lite:spaces:items:versions',
  ITEMS_VERSION_GET: 'lite:spaces:items:versionGet',
  ITEMS_VERSION_RESTORE: 'lite:spaces:items:versionRestore',
  /** Learning Center (replaces Home, 2026-08-07). */
  LEARN_SIGNALS: 'lite:spaces:learn:signals',
  LEARN_PROGRESS_GET: 'lite:spaces:learn:progressGet',
  LEARN_PROGRESS_SAVE: 'lite:spaces:learn:progressSave',
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

/** Electron's `ipcMain.handle` listener type (uses `any[]` args). */
type SpacesIpcHandler = Parameters<typeof ipcMain.handle>[1];

/**
 * Register an IPC handler that emits a `spaces.ipc.<verb>` instant
 * event (ADR-030) before delegating, so every renderer-driven Spaces
 * call is visible in `/logs?category=spaces`. The verb is derived from
 * the `lite:spaces:<verb>` channel (colons -> hyphens) -- the channel
 * list is the single source of truth, so handlers stay declarative.
 *
 * Uses `ipcMain.handle.bind` internally so the module's wrapping of
 * each handler registration doesn't recurse into this function.
 */
function handleSpacesIpc(channel: string, handler: SpacesIpcHandler): void {
  const register = ipcMain.handle.bind(ipcMain);
  const verb = channel.replace(/^lite:spaces:/, '').replace(/:/g, '-');
  register(channel, (event, ...args) => {
    getLoggingApi().event(`spaces.ipc.${verb}`);
    return handler(event, ...args);
  });
}

/**
 * Register every Spaces IPC handler. Idempotent: safe to call across
 * test re-init cycles. Pair with `unregisterSpacesIpc()` on teardown.
 */
export function registerSpacesIpc(opts: RegisterOpts): void {
  if (registered) return;

  handleSpacesIpc(SPACES_IPC.OPEN, (_event: IpcMainInvokeEvent): { ok: true } => {
    opts.onOpen();
    return { ok: true };
  });

  handleSpacesIpc(
    SPACES_IPC.OPEN_WISER,
    (_event: IpcMainInvokeEvent, payload: unknown): { ok: true } => {
      const riffId =
        typeof (payload as { riffId?: unknown })?.riffId === 'string' &&
        ((payload as { riffId: string }).riffId).length > 0
          ? (payload as { riffId: string }).riffId
          : undefined;
      openWiserPlaybooksWindow(riffId === undefined ? undefined : { riffId });
      return { ok: true };
    }
  );

  handleSpacesIpc(
    SPACES_IPC.ITEMS_READ_FILE_DATA,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<SpacesIpcResult<{ dataUrl: string } | null>> => {
      try {
        const key =
          typeof (payload as { key?: unknown })?.key === 'string'
            ? ((payload as { key: string }).key)
            : '';
        const value = await getSpacesApi().items.readFileData(key);
        return { ok: true, value };
      } catch (err) {
        return { ok: false, error: serializeError(err) };
      }
    }
  );

  handleSpacesIpc(
    SPACES_IPC.REFRESH,
    async (_event: IpcMainInvokeEvent): Promise<SpacesIpcResult<{ ok: true }>> => {
      try {
        await getSpacesApi().refresh();
        return { ok: true, value: { ok: true } };
      } catch (err) {
        return { ok: false, error: serializeError(err) };
      }
    }
  );

  handleSpacesIpc(
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

  handleSpacesIpc(
    SPACES_IPC.IDENTITY_ATTRIBUTION_EMAIL_GET,
    async (_event: IpcMainInvokeEvent): Promise<SpacesIpcResult<string | null>> => {
      try {
        const value = await getSpacesApi().identity.attributionEmailGet();
        return { ok: true, value };
      } catch (err) {
        return { ok: false, error: serializeError(err) };
      }
    }
  );

  handleSpacesIpc(
    SPACES_IPC.IDENTITY_ATTRIBUTION_EMAIL_SET,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<SpacesIpcResult<string | null>> => {
      try {
        const raw = (payload as { email?: unknown })?.email;
        // Reject, don't drop: only an EXPLICIT null clears the stored
        // identity. A malformed payload (undefined, number, object)
        // must not silently delete the user's declared email
        // (v0.0.40 delta review).
        if (raw !== null && typeof raw !== 'string') {
          throw new Error(`email must be a string or null (got ${typeof raw})`);
        }
        const value = await getSpacesApi().identity.attributionEmailSet(raw);
        return { ok: true, value };
      } catch (err) {
        return { ok: false, error: serializeError(err) };
      }
    }
  );

  handleSpacesIpc(
    SPACES_IPC.LEARN_SIGNALS,
    async (_event: IpcMainInvokeEvent): Promise<SpacesIpcResult<unknown>> => {
      try {
        const value = await getSpacesApi().learnSignals();
        return { ok: true, value };
      } catch (err) {
        return { ok: false, error: serializeError(err) };
      }
    }
  );

  handleSpacesIpc(
    SPACES_IPC.LEARN_PROGRESS_GET,
    async (_event: IpcMainInvokeEvent): Promise<SpacesIpcResult<unknown>> => {
      try {
        const value = await getSpacesApi().learnProgressGet();
        return { ok: true, value };
      } catch (err) {
        return { ok: false, error: serializeError(err) };
      }
    }
  );

  handleSpacesIpc(
    SPACES_IPC.LEARN_PROGRESS_SAVE,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<SpacesIpcResult<unknown>> => {
      try {
        // Whole-object save; normalization happens store-side, so a
        // malformed payload degrades to a fresh start, never a throw
        // that loses the previous file.
        const value = await getSpacesApi().learnProgressSave(payload);
        return { ok: true, value };
      } catch (err) {
        return { ok: false, error: serializeError(err) };
      }
    }
  );

  handleSpacesIpc(
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

  handleSpacesIpc(
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

  handleSpacesIpc(
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

  handleSpacesIpc(
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

  handleSpacesIpc(
    SPACES_IPC.ITEMS_GET_FILE_EXPIRY,
    async (
      _event: IpcMainInvokeEvent,
      payload?: { key?: unknown }
    ): Promise<SpacesIpcResult<{ expiresAt: string | null; source: 'bucket' } | null>> => {
      try {
        const key =
          payload !== undefined && typeof payload.key === 'string' ? payload.key : '';
        const value = await getSpacesApi().items.getFileExpiry(key);
        return { ok: true, value };
      } catch (err) {
        return { ok: false, error: serializeError(err) };
      }
    }
  );

  // Phase 3b — item mutation handlers. Distinct from Phase 3a Space
  // mutations: these write to :Asset / :Tag.
  handleSpacesIpc(
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

  handleSpacesIpc(
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

  handleSpacesIpc(
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
  handleSpacesIpc(
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

  // Audit trail — fire-and-forget "viewed" write + the viewers read.
  handleSpacesIpc(
    SPACES_IPC.ITEMS_RECORD_VIEW,
    async (
      _event: IpcMainInvokeEvent,
      payload?: { id?: unknown }
    ): Promise<SpacesIpcResult<{ ok: true }>> => {
      try {
        const id =
          payload !== undefined && typeof payload.id === 'string' ? payload.id : '';
        if (id.length > 0) await getSpacesApi().items.recordView(id);
        return { ok: true, value: { ok: true } };
      } catch (err) {
        return { ok: false, error: serializeError(err) };
      }
    }
  );

  handleSpacesIpc(
    SPACES_IPC.ITEMS_VIEWERS,
    async (
      _event: IpcMainInvokeEvent,
      payload?: { id?: unknown }
    ): Promise<SpacesIpcResult<AssetViewer[]>> => {
      try {
        const id =
          payload !== undefined && typeof payload.id === 'string' ? payload.id : '';
        const value = await getSpacesApi().items.viewers(id);
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
  handleSpacesIpc(
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

  handleSpacesIpc(
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

  handleSpacesIpc(
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

  handleSpacesIpc(
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

  handleSpacesIpc(
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

  handleSpacesIpc(
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

  handleSpacesIpc(
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

  handleSpacesIpc(
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

  handleSpacesIpc(
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

  handleSpacesIpc(
    SPACES_IPC.UPDATE_SPACE,
    async (
      _event: IpcMainInvokeEvent,
      payload?: { id?: unknown; patch?: unknown }
    ): Promise<SpacesIpcResult<Space>> => {
      try {
        const id = typeof payload?.id === 'string' ? payload.id : '';
        const patch = coerceUpdateSpaceInput(payload?.patch);
        const value = await getSpacesApi().updateSpace(id, patch);
        return { ok: true, value };
      } catch (err) {
        return { ok: false, error: serializeError(err) };
      }
    }
  );

  handleSpacesIpc(
    SPACES_IPC.PIN_SPACE,
    async (
      _event: IpcMainInvokeEvent,
      payload?: { id?: unknown; pinned?: unknown }
    ): Promise<SpacesIpcResult<{ ok: true }>> => {
      try {
        const id = typeof payload?.id === 'string' ? payload.id : '';
        const pinned = payload?.pinned === true;
        await getSpacesApi().pinSpace(id, pinned);
        return { ok: true, value: { ok: true } };
      } catch (err) {
        return { ok: false, error: serializeError(err) };
      }
    }
  );

  handleSpacesIpc(
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

  handleSpacesIpc(
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

  handleSpacesIpc(
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

  handleSpacesIpc(
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

  handleSpacesIpc(
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

  handleSpacesIpc(
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

  handleSpacesIpc(
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

  handleSpacesIpc(
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

  handleSpacesIpc(
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

  handleSpacesIpc(
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

  handleSpacesIpc(
    SPACES_IPC.CHECKLISTS_DRAFT,
    async (
      _event: IpcMainInvokeEvent,
      payload?: { prompt?: unknown }
    ): Promise<SpacesIpcResult<ChecklistDraft>> => {
      try {
        const prompt = typeof payload?.prompt === 'string' ? payload.prompt : '';
        const value = await getSpacesApi().checklists.draft(prompt);
        return { ok: true, value };
      } catch (err) {
        return { ok: false, error: serializeError(err) };
      }
    }
  );

  // ADR-072 — journey maps.
  handleSpacesIpc(
    SPACES_IPC.JOURNEYS_DRAFT,
    async (
      _event: IpcMainInvokeEvent,
      payload?: { prompt?: unknown }
    ): Promise<SpacesIpcResult<JourneyDraft>> => {
      try {
        const prompt =
          payload !== undefined && typeof payload.prompt === 'string' ? payload.prompt : '';
        const value = await getSpacesApi().journeys.draft(prompt);
        return { ok: true, value };
      } catch (err) {
        return { ok: false, error: serializeError(err) };
      }
    }
  );

  handleSpacesIpc(
    SPACES_IPC.JOURNEYS_CREATE,
    async (
      _event: IpcMainInvokeEvent,
      payload?: { spaceId?: unknown; draft?: unknown }
    ): Promise<SpacesIpcResult<Item>> => {
      try {
        const spaceId =
          payload !== undefined && typeof payload.spaceId === 'string' ? payload.spaceId : '';
        const value = await getSpacesApi().journeys.create(
          spaceId,
          (payload?.draft ?? {}) as JourneyDraft
        );
        return { ok: true, value };
      } catch (err) {
        return { ok: false, error: serializeError(err) };
      }
    }
  );

  handleSpacesIpc(
    SPACES_IPC.CHECKLISTS_UPDATE,
    async (
      _event: IpcMainInvokeEvent,
      payload?: { input?: unknown }
    ): Promise<SpacesIpcResult<{ id: string; version: number }>> => {
      try {
        const value = await getSpacesApi().checklists.update(
          (payload?.input ?? {}) as UpdateChecklistInput
        );
        return { ok: true, value };
      } catch (err) {
        return { ok: false, error: serializeError(err) };
      }
    }
  );

  handleSpacesIpc(
    SPACES_IPC.CHECKLISTS_REMOVE,
    async (
      _event: IpcMainInvokeEvent,
      payload?: { id?: unknown }
    ): Promise<SpacesIpcResult<{ ok: true }>> => {
      try {
        const id = typeof payload?.id === 'string' ? payload.id : '';
        await getSpacesApi().checklists.remove(id);
        return { ok: true, value: { ok: true } };
      } catch (err) {
        return { ok: false, error: serializeError(err) };
      }
    }
  );

  handleSpacesIpc(
    SPACES_IPC.CHECKLISTS_CREATE,
    async (
      _event: IpcMainInvokeEvent,
      payload?: { input?: unknown }
    ): Promise<SpacesIpcResult<Checklist>> => {
      try {
        const value = await getSpacesApi().checklists.create(
          (payload?.input ?? {}) as CreateChecklistInput
        );
        return { ok: true, value };
      } catch (err) {
        return { ok: false, error: serializeError(err) };
      }
    }
  );

  handleSpacesIpc(
    SPACES_IPC.CHECKLISTS_LIST,
    async (
      _event: IpcMainInvokeEvent,
      payload?: { spaceId?: unknown }
    ): Promise<SpacesIpcResult<Checklist[]>> => {
      try {
        const spaceId = typeof payload?.spaceId === 'string' ? payload.spaceId : '';
        const value = await getSpacesApi().checklists.list(spaceId);
        return { ok: true, value };
      } catch (err) {
        return { ok: false, error: serializeError(err) };
      }
    }
  );

  handleSpacesIpc(
    SPACES_IPC.CHECKLISTS_ATTACH,
    async (
      _event: IpcMainInvokeEvent,
      payload?: { input?: unknown }
    ): Promise<SpacesIpcResult<{ ok: true }>> => {
      try {
        await getSpacesApi().checklists.attach(
          (payload?.input ?? {}) as AttachChecklistInput
        );
        return { ok: true, value: { ok: true } };
      } catch (err) {
        return { ok: false, error: serializeError(err) };
      }
    }
  );

  handleSpacesIpc(
    SPACES_IPC.CHECKLISTS_FOR_TICKET,
    async (
      _event: IpcMainInvokeEvent,
      payload?: { ticketId?: unknown }
    ): Promise<SpacesIpcResult<TicketChecklist[]>> => {
      try {
        const ticketId = typeof payload?.ticketId === 'string' ? payload.ticketId : '';
        const value = await getSpacesApi().checklists.forTicket(ticketId);
        return { ok: true, value };
      } catch (err) {
        return { ok: false, error: serializeError(err) };
      }
    }
  );

  handleSpacesIpc(
    SPACES_IPC.CHECKLISTS_SET_ITEM,
    async (
      _event: IpcMainInvokeEvent,
      payload?: { input?: unknown }
    ): Promise<SpacesIpcResult<{ checkedIndexes: number[]; complete: boolean }>> => {
      try {
        const value = await getSpacesApi().checklists.setItem(
          (payload?.input ?? {}) as SetChecklistItemInput
        );
        return { ok: true, value };
      } catch (err) {
        return { ok: false, error: serializeError(err) };
      }
    }
  );

  handleSpacesIpc(
    SPACES_IPC.CHECKLISTS_DETACH,
    async (
      _event: IpcMainInvokeEvent,
      payload?: { ticketId?: unknown; checklistId?: unknown; phase?: unknown }
    ): Promise<SpacesIpcResult<{ ok: true }>> => {
      try {
        const ticketId = typeof payload?.ticketId === 'string' ? payload.ticketId : '';
        const checklistId = typeof payload?.checklistId === 'string' ? payload.checklistId : '';
        const phase = payload?.phase === 'postflight' ? 'postflight' : 'preflight';
        await getSpacesApi().checklists.detach(ticketId, checklistId, phase);
        return { ok: true, value: { ok: true } };
      } catch (err) {
        return { ok: false, error: serializeError(err) };
      }
    }
  );

  handleSpacesIpc(
    SPACES_IPC.MEMBERS_ADD,
    async (
      _event: IpcMainInvokeEvent,
      payload?: { spaceId?: unknown; memberId?: unknown; expiresAt?: unknown }
    ): Promise<SpacesIpcResult<SpaceMember>> => {
      try {
        const spaceId = typeof payload?.spaceId === 'string' ? payload.spaceId : '';
        const memberId =
          typeof payload?.memberId === 'string' ? payload.memberId : '';
        // ADR-052: absent vs null vs value are three different
        // intents (leave / permanent / expire), so only forward the
        // key when the renderer actually sent it.
        const hasExpiry = payload !== undefined && 'expiresAt' in payload;
        // ADR-052 says REJECT a malformed expiry, never drop it. This
        // used to coerce anything non-string to `null` — which the SDK
        // reads as PERMANENT, so an epoch-ms number or a Date (both
        // survive structured clone) silently produced a grant the
        // admin believed expires Friday (2026-08-07 review). Pass the
        // raw value through and let parseGrantExpiry throw.
        const rawExpiry = payload?.expiresAt;
        if (
          hasExpiry &&
          rawExpiry !== null &&
          typeof rawExpiry !== 'string'
        ) {
          throw new Error(
            `expiresAt must be an ISO string or null (got ${typeof rawExpiry})`
          );
        }
        const expiresAt = (rawExpiry ?? null) as string | null;
        const value = await getSpacesApi().members.add(
          spaceId,
          memberId,
          hasExpiry ? { expiresAt } : {}
        );
        return { ok: true, value };
      } catch (err) {
        return { ok: false, error: serializeError(err) };
      }
    }
  );

  handleSpacesIpc(
    SPACES_IPC.AUTH_SIGN_IN,
    async (
      _event: IpcMainInvokeEvent
    ): Promise<SpacesIpcResult<{ email: string | null; accountId: string | null }>> => {
      try {
        // Lazy import keeps ipc.ts test-loadable without the full auth
        // module graph; `signIn()` opens the interactive GSX sign-in
        // window and resolves once the session lands in the vault.
        const { getAuthApi } = await import('../auth/api.js');
        const session = await getAuthApi().signIn('edison');
        const email =
          typeof session.email === 'string' && session.email.trim().length > 0
            ? session.email.trim().toLowerCase()
            : null;
        const accountId =
          typeof session.accountId === 'string' && session.accountId.length > 0
            ? session.accountId
            : null;
        return { ok: true, value: { email, accountId } };
      } catch (err) {
        return { ok: false, error: serializeError(err) };
      }
    }
  );

  handleSpacesIpc(
    SPACES_IPC.MEMBERS_SEARCH_LIBRARY,
    async (
      _event: IpcMainInvokeEvent,
      payload?: { q?: unknown; limit?: unknown }
    ): Promise<SpacesIpcResult<MemberLibraryEntry[]>> => {
      try {
        const q = typeof payload?.q === 'string' ? payload.q : '';
        const limit =
          typeof payload?.limit === 'number' && Number.isFinite(payload.limit)
            ? payload.limit
            : undefined;
        const value = await getSpacesApi().members.searchLibrary(
          q,
          ...(limit !== undefined ? [limit] : [])
        );
        return { ok: true, value };
      } catch (err) {
        return { ok: false, error: serializeError(err) };
      }
    }
  );

  handleSpacesIpc(
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

  handleSpacesIpc(
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

  // GSX-first binary create (ADR-050). The renderer hands raw bytes
  // over IPC (structured-clone ArrayBuffer); the main process uploads
  // them to the account's GSX bucket and creates the :Asset with the
  // resulting fileKey -- inline base64 never enters the graph.
  handleSpacesIpc(
    SPACES_IPC.ITEMS_CREATE_BINARY,
    async (
      _event: IpcMainInvokeEvent,
      payload?: { input?: unknown }
    ): Promise<SpacesIpcResult<Item>> => {
      try {
        const input =
          payload?.input !== null && typeof payload?.input === 'object'
            ? (payload?.input as CreateBinaryAssetInput)
            : ({
                spaceId: '',
                title: '',
                fileName: '',
                bytes: new ArrayBuffer(0),
              } as CreateBinaryAssetInput);
        const value = await getSpacesApi().items.createBinary(input);
        return { ok: true, value };
      } catch (err) {
        return { ok: false, error: serializeError(err) };
      }
    }
  );

  handleSpacesIpc(
    SPACES_IPC.ITEMS_CREATE_AGENT,
    async (
      _event: IpcMainInvokeEvent,
      payload?: { input?: unknown }
    ): Promise<SpacesIpcResult<Item>> => {
      try {
        const input =
          payload?.input !== null && typeof payload?.input === 'object'
            ? (payload?.input as CreateAgentInput)
            : ({ spaceId: '', name: '', okf: '', agentType: '' } as CreateAgentInput);
        const value = await getSpacesApi().items.createAgent(input);
        return { ok: true, value };
      } catch (err) {
        return { ok: false, error: serializeError(err) };
      }
    }
  );

  handleSpacesIpc(
    SPACES_IPC.ITEMS_AGENT_LIBRARY_SEARCH,
    async (
      _event: IpcMainInvokeEvent,
      payload?: { q?: unknown; limit?: unknown }
    ): Promise<SpacesIpcResult<AgentLibraryEntry[]>> => {
      try {
        const q = typeof payload?.q === 'string' ? payload.q : '';
        const limit =
          typeof payload?.limit === 'number' && Number.isFinite(payload.limit)
            ? payload.limit
            : undefined;
        const value = await getSpacesApi().items.searchAgentLibrary(
          q,
          ...(limit !== undefined ? [limit] : [])
        );
        return { ok: true, value };
      } catch (err) {
        return { ok: false, error: serializeError(err) };
      }
    }
  );

  handleSpacesIpc(
    SPACES_IPC.ITEMS_CREATE_AGENT_FROM_LIBRARY,
    async (
      _event: IpcMainInvokeEvent,
      payload?: { input?: unknown }
    ): Promise<SpacesIpcResult<Item>> => {
      try {
        const input =
          payload?.input !== null && typeof payload?.input === 'object'
            ? (payload?.input as CreateAgentFromLibraryInput)
            : ({ spaceId: '', agentId: '' } as CreateAgentFromLibraryInput);
        const value = await getSpacesApi().items.createAgentFromLibrary(input);
        return { ok: true, value };
      } catch (err) {
        return { ok: false, error: serializeError(err) };
      }
    }
  );

  handleSpacesIpc(
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

  handleSpacesIpc(
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

  handleSpacesIpc(
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

  handleSpacesIpc(
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

  handleSpacesIpc(
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

  handleSpacesIpc(
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

  // ─── Asset versioning (ADR-057) ───────────────────────────────────────

  handleSpacesIpc(
    SPACES_IPC.ITEMS_VERSIONS,
    async (
      _event: IpcMainInvokeEvent,
      payload?: { id?: unknown; limit?: unknown }
    ): Promise<SpacesIpcResult<AssetVersionSummary[]>> => {
      try {
        const id = typeof payload?.id === 'string' ? payload.id : '';
        const limit = typeof payload?.limit === 'number' ? payload.limit : undefined;
        const value = await getSpacesApi().items.versions(id, limit);
        return { ok: true, value };
      } catch (err) {
        return { ok: false, error: serializeError(err) };
      }
    }
  );

  handleSpacesIpc(
    SPACES_IPC.ITEMS_VERSION_GET,
    async (
      _event: IpcMainInvokeEvent,
      payload?: { id?: unknown; seq?: unknown }
    ): Promise<SpacesIpcResult<AssetVersion | null>> => {
      try {
        const id = typeof payload?.id === 'string' ? payload.id : '';
        const seq = typeof payload?.seq === 'number' ? payload.seq : -1;
        const value = await getSpacesApi().items.getVersion(id, seq);
        return { ok: true, value };
      } catch (err) {
        return { ok: false, error: serializeError(err) };
      }
    }
  );

  handleSpacesIpc(
    SPACES_IPC.ITEMS_VERSION_RESTORE,
    async (
      _event: IpcMainInvokeEvent,
      payload?: { id?: unknown; seq?: unknown; editorId?: unknown }
    ): Promise<SpacesIpcResult<Item>> => {
      try {
        const id = typeof payload?.id === 'string' ? payload.id : '';
        const seq = typeof payload?.seq === 'number' ? payload.seq : -1;
        const editorId =
          typeof payload?.editorId === 'string' && payload.editorId.length > 0
            ? payload.editorId
            : undefined;
        const value = await getSpacesApi().items.restoreVersion(id, seq, editorId);
        return { ok: true, value };
      } catch (err) {
        return { ok: false, error: serializeError(err) };
      }
    }
  );

  // ─── Metadata mutations ───────────────────────────────────────────────

  handleSpacesIpc(
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

  handleSpacesIpc(
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

  handleSpacesIpc(
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

/**
 * Coerce a renderer-supplied UpdateSpace patch payload. Only string
 * fields are forwarded; anything else is dropped so the SDK sees a
 * clean shape. The patch is intentionally tolerant of an empty
 * description string (that's how you clear it).
 */
function coerceUpdateSpaceInput(raw: unknown): UpdateSpaceInput {
  if (raw === null || typeof raw !== 'object') return {};
  const r = raw as Record<string, unknown>;
  const patch: UpdateSpaceInput = {};
  if (typeof r['description'] === 'string') patch.description = r['description'] as string;
  if (typeof r['color'] === 'string') patch.color = r['color'] as string;
  if (typeof r['iconKey'] === 'string') patch.iconKey = r['iconKey'] as string;
  // ADR-051 — visibility rides the same update patch. Enum-checked here
  // (belt) and again in the SDK client (suspenders); anything else is
  // dropped so a malformed renderer value can't reach the graph.
  if (r['visibility'] === 'open' || r['visibility'] === 'restricted') {
    patch.visibility = r['visibility'];
  }
  return patch;
}

/** @internal -- exposed for the visibility-coercion regression test. */
export function _coerceUpdateSpaceInputForTesting(raw: unknown): UpdateSpaceInput {
  return coerceUpdateSpaceInput(raw);
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
