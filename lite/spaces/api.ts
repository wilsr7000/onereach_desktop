/**
 * Spaces module -- PUBLIC API.
 *
 * The only file other lite modules should import from in this module.
 * Per ADR-019 / Rule 11 in `lite/LITE-RULES.md`, cross-module imports
 * go through `<module>/api.ts` -- never reach into `sdk-client.ts`,
 * `window.ts`, `main.ts`, or any other internal file.
 *
 * Per the Spaces plan ("Spaces as Platform Primitive" section), the
 * methods declared here ARE the platform contract -- the same surface
 * GSX agents, Cowork integrations, and the renderer all consume. The
 * Lite UI is just the first consumer.
 *
 * Phase 0 ships:
 *   - The singleton swap pattern (`getSpacesApi` + `_setSpacesApiForTesting`)
 *   - Method signatures (every method throws `SPACES_NOT_INITIALIZED`
 *     in the default implementation)
 *   - `open()` to launch the Spaces window
 *
 * Phase 1 wires the BrowserWindow-backed implementation via
 * `initSpaces()` and lands the real `listSpaces` + `items.list` queries.
 *
 * Tests: `_setSpacesApiForTesting(stub)` to inject a custom
 * implementation, `_resetSpacesApiForTesting()` to clear the singleton.
 */

import { SpacesError } from './errors.js';
import type {
  Space,
  Item,
  ItemSummary,
  ListOpts,
  EntityCounts,
  Contributor,
  Event,
  AgentSummary,
  PermissionSummary,
  TopContributorsOpts,
  RecentEventsOpts,
  RecentItemsOpts,
  AgentsSampleOpts,
  CreateSpaceInput,
  DeleteSpaceOpts,
  UpdateSpaceInput,
  ItemUpdatePatch,
  RecentCommitsOpts,
  SpaceKind,
  ListTicketsOpts,
  CreateTicketInput,
  UpdateTicketPatch,
  SetPlaybookResult,
  Person,
  PersonUpsertInput,
  SpaceMember,
  AddSpaceMemberOptions,
  Checklist,
  ChecklistPhase,
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
  AssetVersion,
  AssetVersionSummary,
  AssetViewer,
  JourneyDraft,
  JourneySuggestions,
} from './types.js';
import type { SpaceScope } from './scope.js';

// ── Re-export public types consumers need ───────────────────────────────

export type {
  Space,
  Item,
  ItemSummary,
  ItemKind,
  ItemProvenance,
  SpaceChipRef,
  ListOpts,
  EntityCounts,
  Contributor,
  Event,
  AgentSummary,
  PermissionSummary,
  ContributorWindow,
  TopContributorsOpts,
  RecentEventsOpts,
  RecentItemsOpts,
  AgentsSampleOpts,
  CreateSpaceInput,
  RenameSpaceInput,
  UpdateSpaceInput,
  DeleteSpaceOpts,
  ItemUpdatePatch,
  RecentCommitsOpts,
  SpaceKind,
  TicketStatus,
  TicketDetails,
  ListTicketsOpts,
  CreateTicketInput,
  UpdateTicketPatch,
  SetPlaybookResult,
  Person,
  PersonUpsertInput,
  SpaceMember,
  AddSpaceMemberOptions,
  Checklist,
  ChecklistMode,
  ChecklistPhase,
  ChecklistObligation,
  ChecklistItemSpec,
  TicketChecklist,
  CreateChecklistInput,
  AttachChecklistInput,
  SetChecklistItemInput,
  CreateAssetInput,
  CreateBinaryAssetInput,
  CreateAgentInput,
  AgentEndpoint,
  AgentEndpointKind,
  DeleteAssetOpts,
  SearchItemsOpts,
  ItemMetadata,
  MetadataValue,
  MetadataPrimitive,
  AssetVersion,
  AssetVersionSummary,
} from './types.js';
export {
  SPACES_MODULE_VERSION,
  MAX_SPACE_NAME_LENGTH,
  MAX_SPACE_DESC_LENGTH,
  MAX_ITEM_TITLE_LENGTH,
  MAX_ITEM_DESCRIPTION_LENGTH,
  MAX_ITEM_TAG_LENGTH,
  TICKET_STATUSES,
} from './types.js';

export type { SpaceScope } from './scope.js';
export { UNCATEGORIZED_SPACE_ID, resolveSpaceScope, isUncategorized } from './scope.js';

// ── Structured error class + code catalog ──────────────────────────────

export type { SpacesErrorCode, SpacesErrorOptions } from './errors.js';
export { SpacesError, SPACES_ERROR_CODES } from './errors.js';
export { LiteError, isLiteError } from '../errors.js';

// ── Per-module typed event surface (ADR-032) ───────────────────────────

export {
  SPACES_EVENTS,
  isSpacesEvent,
  type SpacesEvent,
  type SpacesEventName,
  type SpacesListSpacesStartEvent,
  type SpacesListSpacesFinishEvent,
  type SpacesListSpacesFailEvent,
  type SpacesItemsListStartEvent,
  type SpacesItemsListFinishEvent,
  type SpacesItemsListFailEvent,
  type SpacesItemsGetStartEvent,
  type SpacesItemsGetFinishEvent,
  type SpacesItemsGetFailEvent,
  type SpacesUncategorizedCountStartEvent,
  type SpacesUncategorizedCountFinishEvent,
  type SpacesUncategorizedCountFailEvent,
  type SpacesCreateStartEvent,
  type SpacesCreateFinishEvent,
  type SpacesCreateFailEvent,
  type SpacesRenameStartEvent,
  type SpacesRenameFinishEvent,
  type SpacesRenameFailEvent,
  type SpacesUpdateStartEvent,
  type SpacesUpdateFinishEvent,
  type SpacesUpdateFailEvent,
  type SpacesDeleteStartEvent,
  type SpacesDeleteFinishEvent,
  type SpacesDeleteFailEvent,
  type SpacesUndeleteStartEvent,
  type SpacesUndeleteFinishEvent,
  type SpacesUndeleteFailEvent,
} from './events.js';

// ─── Public surface ─────────────────────────────────────────────────────

/**
 * Items sub-surface, scoped to a Space. Mirrored on the renderer side
 * as `window.lite.spaces.items.*`.
 *
 * **Error contract**: every method throws `SpacesError` on failure.
 * Inspect `.code`: `SPACES_NOT_AUTHENTICATED`, `SPACES_NOT_FOUND`,
 * `SPACES_FORBIDDEN`, `SPACES_CYPHER`, `SPACES_NETWORK`,
 * `SPACES_INVALID_INPUT`, `SPACES_NOT_INITIALIZED`. `get()` soft-fails
 * not-found (returns `null`).
 */
export interface SpacesItemsApi {
  /**
   * List items in the given scope. When `scope.kind === 'uncategorized'`,
   * returns items NOT participating in any `:Space` (the intake +
   * exception zone). Permission-filtered server-side.
   */
  list(scope: SpaceScope, opts?: ListOpts): Promise<ItemSummary[]>;

  /**
   * Fetch a single item by id. Returns `null` when the item doesn't
   * exist or is filtered out by ACL. Throws on auth / network / Cypher
   * failure.
   */
  get(id: string): Promise<Item | null>;

  /**
   * Resolve a binary `fileKey` (taken off `Item.fileKey`) into a
   * short-TTL signed download URL via the Files module. Used by the
   * detail panel to render image previews and offer download links
   * for non-image binary kinds.
   *
   * Returns `null` on any failure (missing key, no auth, network
   * error). Consumers treat `null` as "no preview available" rather
   * than surface an error toast -- the detail pane already shows the
   * item; the missing preview is a soft degrade.
   */
  resolveFileUrl(key: string): Promise<string | null>;

  /**
   * Read a stored file's BYTES and hand back a `data:` URL.
   *
   * The detail pane needs this to render a PDF inline. It cannot fetch
   * the signed URL itself -- the Spaces window's CSP is
   * `default-src 'self'`, so a cross-origin fetch is blocked -- and
   * even if it could, signed URLs are frequently served
   * `Content-Disposition: attachment`, which makes an embedded viewer
   * paint a blank page. A data: URL sidesteps both (CSP allows
   * `object-src`/`frame-src` data:).
   *
   * Returns null when the key is missing from storage, the download
   * fails, or the file exceeds the inline-preview cap -- callers show
   * an explicit message rather than a dead viewer.
   */
  readFileData(key: string): Promise<{ dataUrl: string } | null>;
  /**
   * Parse an uploaded .xlsx into a capped preview table (2026-08-20).
   * Soft: null on missing/oversized/unparseable — the pane falls back
   * to the generic document card. Parsing runs in main; the renderer
   * receives plain strings only.
   */
  readSpreadsheet(
    key: string
  ): Promise<import('./spreadsheet-preview.js').SpreadsheetPreviewModel | null>;

  /**
   * Read the file's AUTHORITATIVE scheduled deletion from the bucket.
   *
   * The asset carries `metadata.fileExpiresAt` when Lite set a TTL at
   * upload, but that is only a mirror of our own intent. The bucket
   * reports the real thing on every `get`, and until now nothing read
   * it -- so a TTL set by an account policy, the platform, or another
   * app was invisible here even though we were being told about it on
   * every request.
   *
   * `source` distinguishes the two, which is the point: a `'bucket'`
   * expiry that Lite never stamped is exactly the shape of "a file
   * disappeared and nobody knows why".
   *
   * Soft API: any failure resolves to null rather than throwing, since
   * this only enriches a badge.
   */
  getFileExpiry(
    key: string
  ): Promise<{ expiresAt: string | null; source: 'bucket' } | null>;

  /**
   * Update mutable fields on an Item (Phase 3b). Returns the freshly
   * re-fetched Item so callers can update their state with the new
   * `updatedAt`, `lastEditedBy`, etc. in one shape.
   *
   * @throws {SpacesError} `SPACES_INVALID_INPUT` for missing id / bad
   *   patch shapes (empty title, oversized description, unknown type).
   * @throws {SpacesError} `SPACES_NOT_FOUND` if the item disappeared
   *   between the update and the re-fetch.
   */
  update(id: string, patch: ItemUpdatePatch): Promise<Item>;

  /**
   * Append a tag to an Item (Phase 3b). Idempotent — duplicate calls
   * for the same tag are a no-op at the graph level. Returns the
   * updated tag list.
   *
   * @throws {SpacesError} `SPACES_INVALID_INPUT` for empty tags or
   *   tags longer than `MAX_ITEM_TAG_LENGTH`.
   */
  addTag(id: string, tag: string): Promise<string[]>;

  /**
   * Remove a tag from an Item. No-op when the tag is already absent.
   * Returns the updated tag list.
   */
  removeTag(id: string, tag: string): Promise<string[]>;

  /**
   * Per-asset activity log (Phase 3c). Returns the most recent commits
   * referencing the given Item, in reverse-chronological order. Row
   * shape matches `listRecentEvents()` so the detail-pane timeline can
   * reuse the same row renderer as the home-feed timeline.
   *
   * Defaults: 20 rows. Cap: 100.
   *
   * @throws {SpacesError} `SPACES_INVALID_INPUT` when `id` is empty.
   *   Unknown ids soft-fail to `[]` so a stale detail view doesn't
   *   crash on a freshly-deleted asset.
   */
  recentCommits(id: string, opts?: RecentCommitsOpts): Promise<Event[]>;

  /**
   * Audit trail (2026-08-10): record that the current viewer opened
   * this asset (fire-and-forget graph write), and read who has viewed
   * it. Backed by a (:Person)-[:VIEWED {firstAt,lastAt,count}]->(:Asset)
   * edge, updated per view.
   */
  recordView(id: string): Promise<void>;
  viewers(id: string): Promise<AssetViewer[]>;

  /**
   * Create a new asset (Sprint 1). Either `content` (text body) or
   * `fileKey` (already uploaded via `getFilesApi().upload(...)`)
   * supplies the payload. Returns the freshly re-fetched Item.
   *
   * @throws {SpacesError} `SPACES_INVALID_INPUT` for empty title;
   *   `SPACES_NOT_FOUND` if the target space is missing/soft-deleted.
   */
  create(input: CreateAssetInput): Promise<Item>;

  /**
   * Create a binary asset GSX-first (ADR-050): uploads the raw bytes
   * to the account's GSX bucket under `lite-spaces/assets/…`, then
   * creates the `:Asset` with the resulting `fileKey`. Inline base64
   * never enters the graph, so the asset is readable by every app on
   * the account (full app, Lite, agents) via the shared bucket.
   *
   * If the graph create fails after the upload succeeded, the
   * just-uploaded file is best-effort deleted so no orphan remains.
   *
   * @throws {SpacesError} `SPACES_INVALID_INPUT` for empty
   *   title/fileName/bytes or an over-cap payload;
   *   `SPACES_NOT_FOUND` if the target space is missing/soft-deleted.
   *   Files-layer failures (`FILES_NOT_AUTHENTICATED`, ...) propagate.
   */
  createBinary(input: CreateBinaryAssetInput): Promise<Item>;

  /**
   * Create an agent asset in a Space. The OKF definition text (already
   * AI-converted; see `getAiApi().convertToOkf`) is stored as the
   * asset's `content`. In the graph this also writes a parent `:Agent`
   * node + a per-type `:AgentType:<TypeLabel>` child linked via
   * `[:REPRESENTS]`/`[:HAS_TYPE]`. Returns the freshly re-fetched Item
   * (`kind === 'agent'`, with `agentType` populated).
   *
   * @throws {SpacesError} `SPACES_INVALID_INPUT` for empty name/okf or
   *   missing spaceId; `SPACES_NOT_FOUND` if the target Space is missing.
   */
  createAgent(input: CreateAgentInput): Promise<Item>;

  /**
   * Search the account's agent library (graph `:Agent` nodes) by
   * name/description substring for the "From library" picker.
   */
  searchAgentLibrary(q: string, limit?: number): Promise<AgentLibraryEntry[]>;

  /**
   * Add a LIBRARY agent to a Space — the asset `[:REPRESENTS]` the
   * existing `:Agent` (no new agent node); endpoints attach to it.
   */
  createAgentFromLibrary(input: CreateAgentFromLibraryInput): Promise<Item>;

  /**
   * Delete an asset. Soft by default (sets `a.deletedAt`; reversible
   * via `restore`). Hard-delete with `{ soft: false }` — irreversible.
   *
   * Soft-deleted assets disappear from every list/get because the
   * underlying Cypher filters `WHERE a.deletedAt IS NULL`.
   *
   * @throws {SpacesError} `SPACES_NOT_FOUND` when the soft-delete
   *   path finds nothing to delete.
   */
  delete(id: string, opts?: DeleteAssetOpts): Promise<void>;

  /**
   * Restore a soft-deleted asset. Returns the freshly-fetched Item.
   *
   * @throws {SpacesError} `SPACES_NOT_FOUND` when the asset is missing
   *   OR wasn't soft-deleted.
   */
  restore(id: string): Promise<Item>;

  /**
   * Sprint 3 — move an asset to a different Space. Drops the
   * [:BELONGS_TO] edge to `fromSpaceId` (when provided) and MERGEs a
   * new one to `toSpaceId`. The asset retains any OTHER space
   * memberships.
   */
  moveToSpace(id: string, fromSpaceId: string | null, toSpaceId: string): Promise<Item>;

  /**
   * Sprint 3 — add an asset to ANOTHER space (multi-space membership).
   * Idempotent.
   */
  addToSpace(id: string, toSpaceId: string): Promise<Item>;

  /**
   * Sprint 3 — remove an asset from a specific space. Does NOT
   * soft-delete the asset; it just drops one [:BELONGS_TO] edge.
   */
  removeFromSpace(id: string, spaceId: string): Promise<Item>;

  /**
   * Sprint 3 — substring search across asset title / description /
   * excerpt. Optional `spaceId` restricts the search to one space.
   * Empty query returns `[]`.
   */
  search(opts: SearchItemsOpts): Promise<ItemSummary[]>;

  // ── Asset versioning (ADR-057) ──
  /** History for one asset, newest first (summaries — no content). */
  versions(id: string, limit?: number): Promise<AssetVersionSummary[]>;
  /** One full snapshot, for the read-only version viewer. */
  getVersion(id: string, seq: number): Promise<AssetVersion | null>;
  /** Restore a prior version. Snapshots the present first — undoable. */
  restoreVersion(id: string, seq: number, editorId?: string): Promise<Item>;

  /**
   * Replace the metadata bag on an asset (Metadata sprint). Pass an
   * empty `{}` to clear.
   */
  setMetadata(id: string, metadata: ItemMetadata): Promise<Item>;

  /**
   * Merge a patch into the existing metadata bag. `null` values in
   * the patch remove the corresponding keys; primitives + arrays of
   * primitives set them.
   */
  patchMetadata(id: string, patch: ItemMetadata): Promise<Item>;

  /** Remove a single metadata key. No-op when already absent. */
  removeMetadataKey(id: string, key: string): Promise<Item>;
}

/**
 * Tickets sub-surface (Phase 4 — shared spaces). Tickets are
 * `:Asset {type: 'ticket'}` rows that decompose a playbook into
 * actionable work units. They live alongside other items in a Space
 * but get their own listing for the shared-space dashboard.
 */
export interface SpacesTicketsApi {
  /**
   * List tickets in a Space, optionally filtered by status. Returns
   * ticket-shaped Items (`Item.kind === 'ticket'` with `Item.ticket`
   * populated). Ordered by status priority (open → in_progress →
   * blocked → done) then most-recently-updated within each status.
   */
  list(spaceId: string, opts?: ListTicketsOpts): Promise<Item[]>;

  /**
   * Create a new ticket in a Space. Optionally links the ticket back
   * to a source playbook via `[:DECOMPOSED_FROM]` and to an initial
   * assignee via `[:ASSIGNED_TO]`.
   *
   * @throws {SpacesError} `SPACES_INVALID_INPUT` for empty title or
   *   unknown status. `SPACES_NOT_FOUND` if the Space is missing.
   */
  create(spaceId: string, input: CreateTicketInput): Promise<Item>;

  /**
   * Update a ticket. Mirrors `items.update()` but exposes ticket-
   * specific fields (status, priority, assignee). Pass
   * `{ assigneeId: null }` to clear the assignment.
   */
  update(id: string, patch: UpdateTicketPatch): Promise<Item>;
}

/**
 * Playbooks sub-surface (Phase 4 — shared spaces). A Space designates
 * one Asset as its "current playbook" — the plan agents are working
 * against. The playbook is just an Item with `kind === 'playbook'`.
 */
export interface SpacesPlaybooksApi {
  /**
   * Return the current playbook for a Space, or `null` when none is
   * set. `null` also covers the "space doesn't exist" case.
   */
  current(spaceId: string): Promise<Item | null>;

  /**
   * Promote an Asset to the Space's current playbook. The asset's
   * `kind` is rewritten to `'playbook'` so listings show the
   * playbook chrome. Any previous current playbook is demoted (the
   * `[:CURRENT_PLAYBOOK]` edge is dropped).
   */
  set(spaceId: string, playbookId: string): Promise<SetPlaybookResult>;
}

/**
 * Identity sub-surface (Phase 4 v2). Maps the active OneReach account
 * to a stable `:Person` row so attribution edges + assignee picks +
 * "who am I" lookups all resolve consistently.
 */
export interface SpacesIdentityApi {
  /**
   * Upsert a Person by id. Idempotent. Used by the renderer on boot
   * to ensure the current user has a graph row, and by the sharing
   * dialog when inviting a new collaborator who isn't in the graph
   * yet.
   */
  getOrCreatePerson(input: PersonUpsertInput): Promise<Person>;

  /**
   * Attribution email fallback: user-declared identity email used by
   * the renderer bootstrap when the auth session carries none (some
   * sign-in flows never put an email in the or-cookie).
   */
  attributionEmailGet(): Promise<string | null>;
  attributionEmailSet(raw: string | null): Promise<string | null>;

  /**
   * ADR-065 drop-box internals (main-process only — deliberately NOT
   * registered on the IPC surface). The feedback filing flow finds the
   * shared Space by name past the belonging gate, grants the reporter
   * a live membership, and then every downstream gated flow works.
   */
  findSpaceByNameInternal(name: string): Promise<{ id: string; name: string } | null>;
  grantSelfAccessInternal(spaceId: string): Promise<boolean>;
}

/**
 * Members sub-surface (Phase 4 v2 — sharing). Manages the
 * `[:HAS_ACCESS]` edge set on a Space. Each member is either a
 * `:Person` (human collaborator) or `:Agent` (AI worker). Tickets are
 * assignable to anyone in this set.
 */
/**
 * Checklists sub-surface (ADR-055). A `:Checklist` is a Space-scoped,
 * runnable list built on The Checklist Manifesto's doctrine (mode,
 * pause point, killer items, brevity cap, living-document versioning).
 * Tickets attach checklists via PREFLIGHT_CHECKLIST /
 * POSTFLIGHT_CHECKLIST edges whose `obligation` gates status
 * transitions: an incomplete REQUIRED preflight blocks leaving `open`;
 * an incomplete REQUIRED postflight blocks entering `done`
 * (`SPACES_CHECKLIST_REQUIRED`).
 */
/**
 * ADR-072 — journey maps. `draft` is the AI call (no writes); `create`
 * persists the draft as a `journey` asset in a Space. Split so the
 * composer can preview a draft before anything touches the graph.
 */
export interface SpacesJourneysApi {
  /** Draft a journey map from a free-text subject. Never writes. */
  draft(prompt: string): Promise<JourneyDraft>;
  /** Persist a draft as a `journey` asset; returns the new item. */
  create(spaceId: string, draft: JourneyDraft): Promise<Item>;
  /**
   * Asset-grounded picks for the composer (2026-08-18). Fail-soft:
   * every failure mode returns EMPTY suggestions, never throws.
   */
  suggest(spaceId: string): Promise<JourneySuggestions>;
}

export interface SpacesChecklistsApi {
  /** Create a checklist in a Space. Doctrine-validated (mode, pause point, ≤12 items). */
  create(input: CreateChecklistInput): Promise<Checklist>;
  /** List a Space's checklists. Visibility-gated like every read. */
  list(spaceId: string): Promise<Checklist[]>;

  /** AI-drafted checklist from a prompt — reviewed in the GUI, never auto-saved. */
  draft(prompt: string): Promise<ChecklistDraft>;

  /** ADR-055 addendum: revise (version bump; ALL run states reset). */
  update(input: UpdateChecklistInput): Promise<{ id: string; version: number }>;

  /** Delete — refused while attached to any ticket. */
  remove(id: string): Promise<void>;
  /** Attach to a ticket as pre- or post-flight with an obligation. Idempotent. */
  attach(input: AttachChecklistInput): Promise<void>;
  /** Every checklist attached to a ticket, with per-ticket run state. */
  forTicket(ticketId: string): Promise<TicketChecklist[]>;
  /** Atomically check/uncheck one item on a ticket's run. */
  setItem(input: SetChecklistItemInput): Promise<{ checkedIndexes: number[]; complete: boolean }>;
  /** Remove an attachment (run state on the edge goes with it). */
  detach(ticketId: string, checklistId: string, phase: ChecklistPhase): Promise<void>;
}

export interface SpacesMembersApi {
  /** List every Person + Agent with access to a Space. */
  list(spaceId: string): Promise<SpaceMember[]>;

  /**
   * Grant a Person or Agent access. Idempotent — adding the same
   * member twice is a no-op. Returns the canonical (kind, id, name)
   * tuple so the renderer can patch its cached list.
   *
   * @throws {SpacesError} `SPACES_NOT_FOUND` if either the Space or
   *   the principal is missing from the graph.
   */
  add(
    spaceId: string,
    memberId: string,
    opts?: AddSpaceMemberOptions
  ): Promise<SpaceMember>;

  /** Revoke access. No-op when the edge is already absent. */
  remove(spaceId: string, memberId: string): Promise<void>;

  /**
   * Search the account's people + agents (graph `:Person`/`:Agent`)
   * for the add-member picker. People sort first.
   */
  searchLibrary(q: string, limit?: number): Promise<MemberLibraryEntry[]>;
}

/**
 * The public surface of the spaces module.
 *
 * **Error contract**: every async method throws `SpacesError` on
 * failure (see `SpacesItemsApi` for codes). `open()` is fire-and-forget
 * and never throws; opening failures are logged.
 *
 * **Auth**: every data method requires a signed-in OneReach account.
 * Signed-out callers see `SPACES_NOT_AUTHENTICATED`.
 */
export interface SpacesApi {
  /**
   * Open (or focus) the Spaces window. Idempotent: subsequent calls
   * focus the existing window instead of opening a second.
   *
   * No-op until `initSpaces()` runs at boot (logs a warning).
   */
  open(): void;

  /**
   * List every Space the current account has read access to. Sorted
   * server-side by name; pinning is layered on top by the renderer
   * via local preferences (KV).
   */
  listSpaces(): Promise<Space[]>;

  /**
   * Drop the cached read set and refetch, so data created OUTSIDE this
   * app (a Space made in WISER Playbooks, an asset added by an agent)
   * shows up on demand instead of waiting on the background timer.
   * Resolves once the space list has been refetched; the cache's
   * update broadcast repaints any open window.
   */
  refresh(): Promise<void>;

  /**
   * Count of items in the Uncategorized scope. Surfaced in the sidebar
   * row so users see intake pressure at a glance.
   */
  getUncategorizedCount(): Promise<number>;

  /** Live presence: who has this Space open right now (fresh beacons). */
  presenceInSpace(spaceId: string): Promise<import('./types.js').SpacePresenceEntry[]>;

  /** Report the viewer's active Space onto their presence beacon. */
  presenceScope(spaceId: string | null, spaceName: string | null): void;

  /** Learning Center: workspace signals for mission auto-detection. */
  learnSignals(): Promise<import('./learn-content.js').LearnSignals>;

  /** Learning Center: read the persisted per-user progress. */
  learnProgressGet(): Promise<import('./learn-content.js').LearnProgress>;

  /** Learning Center: persist progress (normalized + atomic). */
  learnProgressSave(
    raw: unknown
  ): Promise<import('./learn-content.js').LearnProgress>;

  /** Items sub-surface. */
  readonly items: SpacesItemsApi;

  /** Tickets sub-surface (Phase 4 — shared spaces). */
  readonly tickets: SpacesTicketsApi;

  /** Playbooks sub-surface (Phase 4 — shared spaces). */
  readonly playbooks: SpacesPlaybooksApi;

  /** Identity sub-surface (Phase 4 v2 — sharing). */
  readonly identity: SpacesIdentityApi;

  /** Space-membership sub-surface (Phase 4 v2 — sharing). */
  readonly members: SpacesMembersApi;

  /** ADR-055 — checklists + ticket gating. */
  readonly checklists: SpacesChecklistsApi;
  /** ADR-072 — agent-enabled journey maps (Planning). */
  readonly journeys: SpacesJourneysApi;

  /**
   * Toggle a Space between 'user' (default) and 'shared' (AI-managed).
   * Idempotent: setting the same kind again is a no-op aside from
   * refreshing `updatedAt`. Returns the new kind so the caller can
   * confirm the flip landed.
   *
   * @throws {SpacesError} `SPACES_INVALID_INPUT` for an unknown kind;
   *   `SPACES_NOT_FOUND` if the Space is missing or soft-deleted.
   */
  setSpaceKind(id: string, kind: SpaceKind): Promise<SpaceKind>;

  // ─── Home view (chunk 3k + 3o) ────────────────────────────────────────
  //
  // Read-only methods powering the Home news-feed cards. Detail in
  // `lite/spaces/HOME-V1.md`. All return canonical shapes from
  // `./types.ts`; SDK normalises wire-format variations.

  /**
   * Flat entity counts for the "Your data room at a glance" card.
   * Counts default to 0 (never undefined) so the renderer can tell
   * "loaded with no data" apart from "still loading".
   *
   * Tries APOC's `apoc.meta.stats()` first and falls back to an
   * explicit per-label `UNION ALL` if APOC isn't installed. The
   * fallback is transparent.
   */
  getEntityCounts(): Promise<EntityCounts>;

  /**
   * Most-recent assets across the entire account, ordered by
   * `updatedAt` (or `createdAt`) descending. Powers Card 5
   * ("Just added"). Returns the same `ItemSummary` shape as
   * `items.list()` so renderers reuse the existing card builder.
   */
  listRecentItems(opts?: RecentItemsOpts): Promise<ItemSummary[]>;

  /**
   * Top contributors over a rolling time window. Powers Card 2
   * ("Recent activity"). Window defaults to 'week'; limit defaults
   * to 4 (matches the card's row count).
   */
  topContributors(opts?: TopContributorsOpts): Promise<Contributor[]>;

  /**
   * Recent commit events across the account, optionally filtered to
   * those after a `since` epoch ms cutoff. Powers Card 2's "See
   * timeline" drill-down (modal in v1).
   */
  listRecentEvents(opts?: RecentEventsOpts): Promise<Event[]>;

  /**
   * Sample of `:Agent` nodes visible to the current account. Powers
   * Card 3 ("Agents in your account"). Limit defaults to 3 (matches
   * the card's row count); cap is 200 (matches modal pagination size).
   */
  listAgentsSample(opts?: AgentsSampleOpts): Promise<AgentSummary[]>;

  /**
   * "Your view" payload for Card 4: how many Spaces the current
   * account can see. `totalSpaceCount` is omitted in v1 because the
   * canonical schema doesn't expose a way to count Spaces the user
   * CAN'T see; renderer falls back to "you see X Spaces" copy.
   */
  getPermissionSummary(): Promise<PermissionSummary>;

  // ─── Mutations (Phase 3a) ─────────────────────────────────────────────
  //
  // All four methods throw `SpacesError`. Common codes:
  //   - SPACES_INVALID_INPUT   -- empty / too-long name; bad id
  //   - SPACES_DUPLICATE_NAME  -- name collision (create / rename)
  //   - SPACES_NOT_FOUND       -- target space missing or already hard-deleted
  //   - SPACES_DELETE_NON_EMPTY -- hard delete refused because items remain
  //   - SPACES_NOT_AUTHENTICATED / SPACES_NETWORK / SPACES_CYPHER (as for reads)
  //
  // Reversibility (ADR-048 Trust Principles):
  //   - create  <-> delete({ soft: true })
  //   - rename  <-> rename(id, previousName)
  //   - delete({ soft: true }) <-> undelete
  //   - delete({ soft: false }) -- one-way; not reversible
  // The trust-principles test harness registers the first three pairs.

  /**
   * Create a new Space. The name must be unique within the account
   * (case-insensitive). Returns the persisted `Space` with its
   * server-assigned id and timestamps. Trims whitespace and enforces
   * `MAX_SPACE_NAME_LENGTH` / `MAX_SPACE_DESC_LENGTH` client-side.
   */
  createSpace(input: CreateSpaceInput): Promise<Space>;

  /**
   * Rename an existing Space. Trims whitespace and enforces
   * `MAX_SPACE_NAME_LENGTH`. Returns the updated `Space`. Throws
   * `SPACES_NOT_FOUND` if the id doesn't exist (or is soft-deleted)
   * and `SPACES_DUPLICATE_NAME` if the new name collides.
   */
  renameSpace(id: string, name: string): Promise<Space>;

  /**
   * Patch a Space's non-identity fields (`description`, `color`,
   * `iconKey`). Each is optional; only fields present in the patch
   * are written. Pass an empty string for `description` to clear it.
   *
   * Name changes go through `renameSpace` (the uniqueness check is
   * name-specific); attempting to pass a name field here is a
   * compile-time error -- the patch shape doesn't allow it.
   *
   * Returns the freshly-fetched `Space` so callers can refresh local
   * state with the new `updatedAt`. Throws `SPACES_NOT_FOUND` when
   * the id doesn't exist or is soft-deleted;
   * `SPACES_INVALID_INPUT` for an oversized description.
   */
  updateSpace(id: string, patch: UpdateSpaceInput): Promise<Space>;

  /**
   * ADR-069 — toggle the viewer's pin mark on a Space. The pin is a
   * per-user `(Person)-[:PINNED]->(Space)` edge (cross-device); a
   * missing viewer identity is a harmless no-op. Mutates the read
   * cache (the `pinned` flag rides `listSpaces()` rows).
   */
  pinSpace(id: string, pinned: boolean): Promise<void>;

  /**
   * Delete a Space. Defaults to a soft delete (sets `deletedAt`); the
   * Space disappears from `listSpaces()` but its items keep their
   * `[:BELONGS_TO]` edges and can be restored via `undeleteSpace()`.
   *
   * Hard delete (`{ soft: false }`) removes the node entirely. Hard
   * delete refuses if items still belong to the Space (throws
   * `SPACES_DELETE_NON_EMPTY`); soft delete first, or move the items
   * out via `items.list()` and a future remove-from-space call.
   *
   * Soft-deleting an already-deleted Space is idempotent (no throw).
   */
  deleteSpace(id: string, opts?: DeleteSpaceOpts): Promise<void>;

  /**
   * Restore a soft-deleted Space. Throws `SPACES_NOT_FOUND` if the
   * Space has been hard-deleted or never existed. Restoring a Space
   * that wasn't soft-deleted is idempotent and returns the current row.
   */
  undeleteSpace(id: string): Promise<Space>;
}

// ─── Default uninitialized implementation ──────────────────────────────

/**
 * The default backing implementation. Wired by `lite/spaces/main.ts`
 * via `_setSpacesApiForTesting()` once the BrowserWindow factory + neon
 * client are initialized at boot.
 *
 * Until `initSpaces({...})` runs:
 *   - `open()` logs a warning and no-ops
 *   - every async data method rejects with `SPACES_NOT_INITIALIZED`
 */
class UninitializedSpacesApi implements SpacesApi {
  readonly items: SpacesItemsApi = {
    async list(_scope: SpaceScope, _opts?: ListOpts): Promise<ItemSummary[]> {
      throw notInitialized('items.list');
    },
    async get(_id: string): Promise<Item | null> {
      throw notInitialized('items.get');
    },
    async resolveFileUrl(_key: string): Promise<string | null> {
      // Soft contract: the resolver never throws even in the uninit
      // state -- it just returns null so the detail pane degrades to
      // "no preview" instead of an error banner.
      return null;
    },
    async getFileExpiry(
      _key: string
    ): Promise<{ expiresAt: string | null; source: 'bucket' } | null> {
      // Soft API — null, not a throw, matching the initialized impl.
      return null;
    },
    async readSpreadsheet(
      _key: string
    ): Promise<import('./spreadsheet-preview.js').SpreadsheetPreviewModel | null> {
      throw notInitialized('items.readSpreadsheet');
    },
    async readFileData(_key: string): Promise<{ dataUrl: string } | null> {
      // Same soft contract as resolveFileUrl.
      return null;
    },
    async update(_id: string, _patch: ItemUpdatePatch): Promise<Item> {
      throw notInitialized('items.update');
    },
    async addTag(_id: string, _tag: string): Promise<string[]> {
      throw notInitialized('items.addTag');
    },
    async removeTag(_id: string, _tag: string): Promise<string[]> {
      throw notInitialized('items.removeTag');
    },
    async recentCommits(_id: string, _opts?: RecentCommitsOpts): Promise<Event[]> {
      throw notInitialized('items.recentCommits');
    },
    async recordView(_id: string): Promise<void> {
      throw notInitialized('items.recordView');
    },
    async viewers(_id: string): Promise<AssetViewer[]> {
      throw notInitialized('items.viewers');
    },
    async create(_input: CreateAssetInput): Promise<Item> {
      throw notInitialized('items.create');
    },
    async createBinary(_input: CreateBinaryAssetInput): Promise<Item> {
      throw notInitialized('items.createBinary');
    },
    async createAgent(_input: CreateAgentInput): Promise<Item> {
      throw notInitialized('items.createAgent');
    },
    async searchAgentLibrary(_q: string, _limit?: number): Promise<AgentLibraryEntry[]> {
      throw notInitialized('items.searchAgentLibrary');
    },
    async createAgentFromLibrary(_input: CreateAgentFromLibraryInput): Promise<Item> {
      throw notInitialized('items.createAgentFromLibrary');
    },
    async delete(_id: string, _opts?: DeleteAssetOpts): Promise<void> {
      throw notInitialized('items.delete');
    },
    async restore(_id: string): Promise<Item> {
      throw notInitialized('items.restore');
    },
    async moveToSpace(_id: string, _fromSpaceId: string | null, _toSpaceId: string): Promise<Item> {
      throw notInitialized('items.moveToSpace');
    },
    async addToSpace(_id: string, _toSpaceId: string): Promise<Item> {
      throw notInitialized('items.addToSpace');
    },
    async removeFromSpace(_id: string, _spaceId: string): Promise<Item> {
      throw notInitialized('items.removeFromSpace');
    },
    async search(_opts: SearchItemsOpts): Promise<ItemSummary[]> {
      throw notInitialized('items.search');
    },
    async versions(_id: string, _limit?: number): Promise<AssetVersionSummary[]> {
      throw notInitialized('items.versions');
    },
    async getVersion(_id: string, _seq: number): Promise<AssetVersion | null> {
      throw notInitialized('items.getVersion');
    },
    async restoreVersion(_id: string, _seq: number, _editorId?: string): Promise<Item> {
      throw notInitialized('items.restoreVersion');
    },
    async setMetadata(_id: string, _metadata: ItemMetadata): Promise<Item> {
      throw notInitialized('items.setMetadata');
    },
    async patchMetadata(_id: string, _patch: ItemMetadata): Promise<Item> {
      throw notInitialized('items.patchMetadata');
    },
    async removeMetadataKey(_id: string, _key: string): Promise<Item> {
      throw notInitialized('items.removeMetadataKey');
    },
  };

  readonly tickets: SpacesTicketsApi = {
    async list(_spaceId: string, _opts?: ListTicketsOpts): Promise<Item[]> {
      throw notInitialized('tickets.list');
    },
    async create(_spaceId: string, _input: CreateTicketInput): Promise<Item> {
      throw notInitialized('tickets.create');
    },
    async update(_id: string, _patch: UpdateTicketPatch): Promise<Item> {
      throw notInitialized('tickets.update');
    },
  };

  readonly playbooks: SpacesPlaybooksApi = {
    async current(_spaceId: string): Promise<Item | null> {
      throw notInitialized('playbooks.current');
    },
    async set(_spaceId: string, _playbookId: string): Promise<SetPlaybookResult> {
      throw notInitialized('playbooks.set');
    },
  };

  readonly identity: SpacesIdentityApi = {
    async attributionEmailGet(): Promise<string | null> {
      throw notInitialized('identity.attributionEmailGet');
    },

    async attributionEmailSet(): Promise<string | null> {
      throw notInitialized('identity.attributionEmailSet');
    },

    async getOrCreatePerson(_input: PersonUpsertInput): Promise<Person> {
      throw notInitialized('identity.getOrCreatePerson');
    },

    async findSpaceByNameInternal(_name: string): Promise<{ id: string; name: string } | null> {
      throw notInitialized('identity.findSpaceByNameInternal');
    },

    async grantSelfAccessInternal(_spaceId: string): Promise<boolean> {
      throw notInitialized('identity.grantSelfAccessInternal');
    },
  };

  readonly journeys: SpacesJourneysApi = {
    async draft(_prompt: string): Promise<JourneyDraft> {
      throw notInitialized('journeys.draft');
    },
    async create(_spaceId: string, _draft: JourneyDraft): Promise<Item> {
      throw notInitialized('journeys.create');
    },
    async suggest(_spaceId: string): Promise<JourneySuggestions> {
      throw notInitialized('journeys.suggest');
    },
  };

  readonly checklists: SpacesChecklistsApi = {
    async create(_input: CreateChecklistInput): Promise<Checklist> {
      throw notInitialized('checklists.create');
    },
    async list(_spaceId: string): Promise<Checklist[]> {
      throw notInitialized('checklists.list');
    },

    async draft(_prompt: string): Promise<ChecklistDraft> {
      throw notInitialized('checklists.draft');
    },

    async update(_input: UpdateChecklistInput): Promise<{ id: string; version: number }> {
      throw notInitialized('checklists.update');
    },

    async remove(_id: string): Promise<void> {
      throw notInitialized('checklists.remove');
    },
    async attach(_input: AttachChecklistInput): Promise<void> {
      throw notInitialized('checklists.attach');
    },
    async forTicket(_ticketId: string): Promise<TicketChecklist[]> {
      throw notInitialized('checklists.forTicket');
    },
    async setItem(
      _input: SetChecklistItemInput
    ): Promise<{ checkedIndexes: number[]; complete: boolean }> {
      throw notInitialized('checklists.setItem');
    },
    async detach(
      _ticketId: string,
      _checklistId: string,
      _phase: ChecklistPhase
    ): Promise<void> {
      throw notInitialized('checklists.detach');
    },
  };

  readonly members: SpacesMembersApi = {
    async list(_spaceId: string): Promise<SpaceMember[]> {
      throw notInitialized('members.list');
    },
    async add(_spaceId: string, _memberId: string): Promise<SpaceMember> {
      throw notInitialized('members.add');
    },
    async remove(_spaceId: string, _memberId: string): Promise<void> {
      throw notInitialized('members.remove');
    },
    async searchLibrary(_q: string, _limit?: number): Promise<MemberLibraryEntry[]> {
      throw notInitialized('members.searchLibrary');
    },
  };

  async setSpaceKind(_id: string, _kind: SpaceKind): Promise<SpaceKind> {
    throw notInitialized('setSpaceKind');
  }

  open(): void {
    // The `.catch()` keeps this fire-and-forget from ever surfacing as
    // an unhandledRejection -- notably the Vite module-runner teardown
    // race in unit tests ("Closing rpc while fetch was pending"), where
    // a worker can tear down before this cold import resolves.
    void import('../logging/api.js')
      .then((m) => {
        m.getLoggingApi().warn('spaces', 'open() called before initSpaces()');
      })
      .catch(() => undefined);
  }

  async listSpaces(): Promise<Space[]> {
    throw notInitialized('listSpaces');
  }

  async refresh(): Promise<void> {
    throw notInitialized('refresh');
  }

  async learnSignals(): Promise<import('./learn-content.js').LearnSignals> {
    throw notInitialized('learnSignals');
  }

  async presenceInSpace(): Promise<import('./types.js').SpacePresenceEntry[]> {
    throw notInitialized('presenceInSpace');
  }

  presenceScope(): void {
    /* uninitialized: presence is garnish — silently inert */
  }

  async learnProgressGet(): Promise<import('./learn-content.js').LearnProgress> {
    throw notInitialized('learnProgressGet');
  }

  async learnProgressSave(): Promise<import('./learn-content.js').LearnProgress> {
    throw notInitialized('learnProgressSave');
  }

  async getUncategorizedCount(): Promise<number> {
    throw notInitialized('getUncategorizedCount');
  }

  async getEntityCounts(): Promise<EntityCounts> {
    throw notInitialized('getEntityCounts');
  }

  async listRecentItems(_opts?: RecentItemsOpts): Promise<ItemSummary[]> {
    throw notInitialized('listRecentItems');
  }

  async topContributors(_opts?: TopContributorsOpts): Promise<Contributor[]> {
    throw notInitialized('topContributors');
  }

  async listRecentEvents(_opts?: RecentEventsOpts): Promise<Event[]> {
    throw notInitialized('listRecentEvents');
  }

  async listAgentsSample(_opts?: AgentsSampleOpts): Promise<AgentSummary[]> {
    throw notInitialized('listAgentsSample');
  }

  async getPermissionSummary(): Promise<PermissionSummary> {
    throw notInitialized('getPermissionSummary');
  }

  async createSpace(_input: CreateSpaceInput): Promise<Space> {
    throw notInitialized('createSpace');
  }

  async renameSpace(_id: string, _name: string): Promise<Space> {
    throw notInitialized('renameSpace');
  }

  async updateSpace(_id: string, _patch: UpdateSpaceInput): Promise<Space> {
    throw notInitialized('updateSpace');
  }

  async pinSpace(_id: string, _pinned: boolean): Promise<void> {
    throw notInitialized('pinSpace');
  }

  async deleteSpace(_id: string, _opts?: DeleteSpaceOpts): Promise<void> {
    throw notInitialized('deleteSpace');
  }

  async undeleteSpace(_id: string): Promise<Space> {
    throw notInitialized('undeleteSpace');
  }
}

function notInitialized(method: string): SpacesError {
  return new SpacesError({
    code: 'SPACES_NOT_INITIALIZED',
    message: `spaces.${method}() called before initSpaces()`,
    remediation:
      'Call initSpaces({...}) from main-lite.ts at boot. In tests, use _setSpacesApiForTesting() to inject a stub.',
    context: { method },
  });
}

let _instance: SpacesApi = new UninitializedSpacesApi();

/**
 * Get the singleton Spaces API. Lazily initialized -- `initSpaces` in
 * `main.ts` swaps in the real implementation at boot. Until then, the
 * stub no-ops `open()` and rejects data methods with
 * `SPACES_NOT_INITIALIZED`.
 */
export function getSpacesApi(): SpacesApi {
  return _instance;
}

/** Reset the singleton (for tests). */
export function _resetSpacesApiForTesting(): void {
  _instance = new UninitializedSpacesApi();
}

/**
 * Override the singleton with a custom implementation. Used by
 * `initSpaces()` at boot to install the real BrowserWindow + neon-
 * backed implementation, and by tests to inject stubs.
 */
export function _setSpacesApiForTesting(api: SpacesApi): void {
  _instance = api;
}
