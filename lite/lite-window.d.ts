/**
 * Renderer-side global type declarations for `window.lite` and friends.
 *
 * Both renderer entry points (`lite/placeholder.ts` and
 * `lite/bug-report/modal.ts`) share these declarations -- TypeScript
 * declaration-merging requires identical types across multiple
 * `interface Window` blocks, so they must live in one place.
 *
 * The actual runtime shapes are defined and exposed in
 * `lite/preload-lite.ts` via `contextBridge.exposeInMainWorld(...)`.
 */

// ---------------------------------------------------------------------------
// Auth bridge -- mirrors lite/auth/api.ts AuthApi MINUS getToken().
// Per ADR-026, the raw mult cookie value never crosses IPC.
// ---------------------------------------------------------------------------

type LiteAuthEnvironment = 'edison' | 'staging' | 'dev' | 'production';

interface LiteAuthSessionRendererView {
  environment: LiteAuthEnvironment;
  accountId: string;
  email?: string;
  capturedAt: number;
  expiresAt?: number;
}

interface LiteAuthTokenBundle {
  multToken: string;
  accountToken: string;
  capturedAt: number;
  multExpiresAt?: number;
  accountExpiresAt?: number;
}

interface LiteAuthErrorJSON {
  name: string;
  code: string;
  message: string;
  context: Record<string, unknown>;
  remediation: string;
  cause?: string;
}

interface LiteAuthTwoFactorNeedsSetupPayload {
  source: string;
  frameUrl: string;
  reason?: string;
  inputCount?: number;
  timestamp: string;
}

interface LiteAuthBridge {
  signIn(
    env: LiteAuthEnvironment,
    opts?: { timeoutMs?: number }
  ): Promise<{ session: LiteAuthSessionRendererView }>;
  signOut(env: LiteAuthEnvironment): Promise<{ ok: true }>;
  getSession(env: LiteAuthEnvironment): Promise<{ session: LiteAuthSessionRendererView | null }>;
  /**
   * Read the in-memory token bundle (mult + or cookie values)
   * captured by the most recent `signIn(env)`. Returns null when no
   * fresh sign-in has happened since the app started.
   */
  getTokenBundle(env: LiteAuthEnvironment): Promise<{ bundle: LiteAuthTokenBundle | null }>;
  hasValidSession(env: LiteAuthEnvironment): Promise<{ valid: boolean }>;
  onSessionChanged(
    listener: (payload: {
      env: LiteAuthEnvironment;
      session: LiteAuthSessionRendererView | null;
    }) => void
  ): () => void;
  /**
   * Subscribe to 2FA-needs-setup broadcasts. Fires when the autofill
   * watcher sees a OneReach 2FA prompt during sign-in but Lite has
   * no TOTP secret saved (the user needs to open Settings ->
   * Two-Factor and paste their authenticator setup secret).
   */
  on2FANeedsSetup(
    listener: (payload: LiteAuthTwoFactorNeedsSetupPayload) => void
  ): () => void;
  parseError(err: unknown): LiteAuthErrorJSON | null;
}

// ---------------------------------------------------------------------------
// TOTP bridge -- mirrors lite/totp/api.ts TotpApi.
// Per ADR-027:
//   - Secret bytes are write-only (saveSecret / scan paths). NO getSecret.
//   - The live code IS exposed (it's ephemeral, 30s lifetime).
// ---------------------------------------------------------------------------

interface LiteTotpSecretMetadata {
  issuer?: string;
  account?: string;
  savedAt: string;
  secretLength: number;
}

interface LiteTotpCodeInfo {
  code: string;
  formattedCode: string;
  timeRemaining: number;
  expiresAt: number;
}

interface LiteTotpQrScanResult {
  saved: boolean;
  issuer?: string;
  account?: string;
  reason?: 'no-qr-found' | 'not-authenticator-qr' | 'invalid-secret' | 'keychain-failed';
}

interface LiteTotpSaveResult {
  saved: boolean;
  metadata?: LiteTotpSecretMetadata;
}

interface LiteTotpErrorJSON {
  name: string;
  code: string;
  message: string;
  context: Record<string, unknown>;
  remediation: string;
  cause?: string;
}

interface LiteTotpBridge {
  hasSecret(): Promise<{ hasSecret: boolean }>;
  getMetadata(): Promise<{ metadata: LiteTotpSecretMetadata | null }>;
  saveSecret(secret: string, extra?: { issuer?: string; account?: string }): Promise<LiteTotpSaveResult>;
  scanQrFromScreen(): Promise<LiteTotpQrScanResult>;
  scanQrFromClipboard(): Promise<LiteTotpQrScanResult>;
  getCurrentCode(): Promise<LiteTotpCodeInfo>;
  deleteSecret(): Promise<{ ok: true }>;
  parseError(err: unknown): LiteTotpErrorJSON | null;
}

// ---------------------------------------------------------------------------
// Settings bridge -- mirrors lite/settings/api.ts SettingsApi.
// open() takes an optional sectionId for deep-linking.
// (Defined alongside LiteIdwBridge below.)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Neon bridge -- mirrors lite/neon/api.ts NeonApi MINUS configure().
// `configure` lives on the bridge but accepts only a NeonConfig from
// the renderer; renderers MAY persist credentials only via the
// Settings -> Neon section, which goes through this bridge.
//
// The password value is write-only: status() returns hasPassword:
// boolean, never the value itself.
// ---------------------------------------------------------------------------

type LiteNeonValue =
  | null
  | string
  | number
  | boolean
  | LiteNeonNode
  | LiteNeonRelationship
  | LiteNeonValue[]
  | { [key: string]: LiteNeonValue };

interface LiteNeonNode {
  id: string;
  labels: string[];
  properties: { [key: string]: LiteNeonValue };
}

interface LiteNeonRelationship {
  id: string;
  type: string;
  start: string;
  end: string;
  properties: { [key: string]: LiteNeonValue };
}

interface LiteNeonRecord {
  [alias: string]: LiteNeonValue;
}

interface LiteNeonStatus {
  endpoint: string | null;
  uri: string | null;
  user: string;
  database: string;
  hasPassword: boolean;
  ready: boolean;
}

interface LiteNeonConfig {
  endpoint?: string;
  uri?: string;
  user?: string;
  password?: string;
  database?: string;
}

interface LiteNeonErrorJSON {
  name: string;
  code: string;
  message: string;
  context: Record<string, unknown>;
  remediation: string;
  cause?: string;
}

interface LiteNeonTestResult {
  ok: boolean;
  error?: string;
  code?: string;
}

interface LiteNeonBridge {
  /**
   * Run a Cypher query. Returns records keyed by RETURN aliases.
   * Throws an Error whose `.message` is JSON containing
   * `{__neonError: LiteNeonErrorJSON}` -- use `parseError(err)` to
   * recover the structure.
   */
  query(cypher: string, parameters?: Record<string, unknown>): Promise<{ records: LiteNeonRecord[] }>;
  /** Read the current Neon configuration status (no secrets). */
  status(): Promise<LiteNeonStatus>;
  /** Cheap connectivity probe -- runs `RETURN 1 AS ok`. */
  testConnection(): Promise<LiteNeonTestResult>;
  /**
   * Persist a partial configuration update via the Settings flow.
   * Pass `password: ''` to clear the password explicitly. Omit the
   * field to leave it unchanged.
   */
  configure(config: LiteNeonConfig): Promise<{ ok: true; status: LiteNeonStatus }>;
  /** Parse a thrown error to recover the structured NeonError. */
  parseError(err: unknown): LiteNeonErrorJSON | null;
}

// ---------------------------------------------------------------------------
// Lite kernel metadata -- exposed alongside auth + totp + settings on
// `window.lite`.
// ---------------------------------------------------------------------------

interface LiteApiDocsBridge {
  /**
   * Open (or focus) the API Reference window. Idempotent: a second
   * call while the window is open focuses it instead of opening a
   * duplicate. ADR-035.
   */
  open(): Promise<{ ok: true }>;
}

// ---------------------------------------------------------------------------
// Health bridge -- mirrors lite/health/api.ts HealthApi.
//
// The snapshot answers "what is true right now?" across documented
// lite modules. The shape contains presence booleans / metadata only;
// secrets (tokens, TOTP code/secret, Neon password) cannot be
// expressed in the type and are not produced by the default store.
// ---------------------------------------------------------------------------

interface LiteHealthAppSnapshotView {
  version: string;
  platform: string;
  arch: string;
  uptimeMs: number;
  userDataPath: string;
  startedAt: number;
}

interface LiteHealthWindowSnapshotView {
  id: number;
  title: string;
  url: string;
  type: 'main' | 'settings' | 'auth' | 'bug-report' | 'about' | 'api-docs' | 'unknown';
  focused: boolean;
  visible: boolean;
  destroyed: boolean;
}

interface LiteHealthAuthSnapshotView {
  signedIn: boolean;
  environment: 'edison';
  accountId?: string;
  email?: string;
  hasMultToken: boolean;
  hasAccountToken: boolean;
  expiresAt?: number;
}

interface LiteHealthTotpSnapshotView {
  configured: boolean;
  metadata?: {
    issuer?: string;
    account?: string;
    secretLength?: number;
  };
  hasCurrentCode: boolean;
  secondsRemaining?: number;
}

interface LiteHealthNeonSnapshotView {
  configured: boolean;
  ready: boolean;
  endpoint?: string;
  uri?: string;
  user?: string;
  database?: string;
  hasPassword: boolean;
}

interface LiteHealthUpdaterSnapshotView {
  failedAttempts: number;
  lastAttemptVersion: string | null;
  lastAttemptTime: string | null;
}

interface LiteHealthDiagnosticsSnapshotView {
  recentErrorCount: number;
  recentWarnCount: number;
  lastError?: string;
}

interface LiteAppHealthSnapshotView {
  schemaVersion: 1;
  capturedAt: string;
  app: LiteHealthAppSnapshotView;
  windows: LiteHealthWindowSnapshotView[];
  auth: LiteHealthAuthSnapshotView;
  totp: LiteHealthTotpSnapshotView;
  neon: LiteHealthNeonSnapshotView;
  updater: LiteHealthUpdaterSnapshotView;
  diagnostics: LiteHealthDiagnosticsSnapshotView;
}

interface LiteHealthBridge {
  /**
   * Build a fresh snapshot of "what is true right now" across
   * documented lite modules. Best-effort: missing or failing
   * sections produce safe fallbacks rather than throwing.
   *
   * Always resolves; never rejects. The returned object has no
   * fields for secrets -- token values, TOTP code/secret, and Neon
   * passwords cannot appear here by construction.
   */
  snapshot(): Promise<LiteAppHealthSnapshotView>;
}

// ---------------------------------------------------------------------------
// IDW bridge -- mirrors lite/idw/api.ts IdwApi.
//
// Hosts the top-level "IDW" menu (a multi-category roster of
// agents). One discriminated `LiteIdwEntry` shape covers six kinds:
// IDWs, External Bots, Image Creators, Video Creators, Audio
// Generators, UI Design Tools. The Settings -> IDWs section + the
// OAGI Store catalog window both consume this bridge.
// ---------------------------------------------------------------------------

type LiteAgentKind =
  | 'idw'
  | 'external-bot'
  | 'image-creator'
  | 'video-creator'
  | 'audio-generator'
  | 'ui-design-tool';

type LiteAudioSubCategory = 'music' | 'effects' | 'narration' | 'custom';

type LiteBotType = 'chatgpt' | 'claude' | 'gemini' | 'perplexity' | 'grok' | 'custom';

interface LiteIdwStoreMetadata {
  catalogId: string;
  developer?: string;
  version?: string;
  installedAt: string;
  updatedAt?: string;
}

interface LiteIdwEntry {
  id: string;
  kind: LiteAgentKind;
  label: string;
  url: string;
  apiUrl?: string;
  source: 'manual' | 'store';
  description?: string;
  category?: string;
  iconName?: string;
  thumbnailUrl?: string;
  environment?: string;
  audio?: { subCategory: LiteAudioSubCategory };
  /** Present iff `kind === 'external-bot'`. Records the user's preset choice. */
  botType?: LiteBotType;
  storeMetadata?: LiteIdwStoreMetadata;
  createdAt: string;
  updatedAt: string;
}

/**
 * Add-payload shape -- kind/label/url required, everything else
 * optional. Mirrors `Partial<IdwEntry> & Pick<IdwEntry, 'kind' |
 * 'label' | 'url'>` from the main-process api.
 */
interface LiteIdwAddInput {
  id?: string;
  kind: LiteAgentKind;
  label: string;
  url: string;
  apiUrl?: string;
  source?: 'manual' | 'store';
  description?: string;
  category?: string;
  iconName?: string;
  thumbnailUrl?: string;
  environment?: string;
  audio?: { subCategory: LiteAudioSubCategory };
  /** Optional preset choice; only meaningful when `kind === 'external-bot'`. */
  botType?: LiteBotType;
  storeMetadata?: LiteIdwStoreMetadata;
}

interface LiteIdwAddResult {
  entry: LiteIdwEntry;
  /** True when an existing Store entry was updated (matched by catalogId). */
  wasUpdate: boolean;
}

interface LiteIdwErrorJSON {
  name: string;
  code: string;
  message: string;
  context: Record<string, unknown>;
  remediation: string;
  cause?: string;
}

// ---------------------------------------------------------------------------
// Lite Tools bridge -- mirrors lite/tools/api.ts ToolsApi.
// ---------------------------------------------------------------------------

interface LiteToolEntry {
  id: string;
  label: string;
  url: string;
  createdAt: string;
  updatedAt: string;
}

interface LiteToolAddInput {
  id?: string;
  label: string;
  url: string;
}

interface LiteToolsErrorJSON {
  name: string;
  code: string;
  message: string;
  context: Record<string, unknown>;
  remediation: string;
  cause?: string;
}

interface LiteToolsBridge {
  list(): Promise<LiteToolEntry[]>;
  get(id: string): Promise<LiteToolEntry | null>;
  /**
   * Add a new tool. Throws an Error whose `.message` is JSON containing
   * `{__toolsError: LiteToolsErrorJSON}` -- use `parseError(err)`.
   */
  add(entry: LiteToolAddInput): Promise<LiteToolEntry>;
  /** Update label/url. Throws on TOOLS_NOT_FOUND / TOOLS_INVALID_*. */
  update(id: string, patch: Partial<LiteToolEntry>): Promise<LiteToolEntry>;
  /** Remove a tool. */
  remove(id: string): Promise<{ ok: true }>;
  /** Open (or focus) the Tools manager window. */
  openManager(): Promise<{ ok: true }>;
  /** Subscribe to mutations broadcast from the main process. */
  onChange(handler: (entries: LiteToolEntry[]) => void): () => void;
  /** Parse a thrown error to recover the structured ToolsError. */
  parseError(err: unknown): LiteToolsErrorJSON | null;
}

interface LiteIdwBridge {
  list(): Promise<LiteIdwEntry[]>;
  listByKind(kind: LiteAgentKind): Promise<LiteIdwEntry[]>;
  get(id: string): Promise<LiteIdwEntry | null>;
  /**
   * Add a new entry, OR (for `source='store'` entries with a matching
   * `storeMetadata.catalogId`) update the existing one in place.
   * Throws an Error whose `.message` is JSON containing
   * `{__idwError: LiteIdwErrorJSON}` -- use `parseError(err)`.
   */
  add(entry: LiteIdwAddInput): Promise<LiteIdwAddResult>;
  /** Update mutable fields. `kind` cannot change. */
  update(id: string, patch: Partial<LiteIdwEntry>): Promise<LiteIdwEntry>;
  /** Remove an entry. */
  remove(id: string): Promise<{ ok: true }>;
  /** Open the OAGI Store catalog window. */
  openStore(): Promise<{ ok: true }>;
  /**
   * Subscribe to mutations broadcast from the main process. Returns
   * an unsubscribe function. Receives the latest entries on each
   * change.
   */
  onChange(handler: (entries: LiteIdwEntry[]) => void): () => void;
  /** Parse a thrown error to recover the structured IdwError. */
  parseError(err: unknown): LiteIdwErrorJSON | null;
}

interface LiteSettingsBridge {
  /**
   * Open (or focus) the Settings window. Optional `sectionId`
   * deep-links to a specific section (e.g. 'idws', 'oagi',
   * 'two-factor').
   */
  open(sectionId?: string): Promise<{ ok: true }>;
}

// ---------------------------------------------------------------------------
// Spaces bridge -- mirrors lite/spaces/api.ts SpacesApi (Phase 0+).
// Phase 0 ships `open()` + structured-envelope data methods; the data
// methods return `SPACES_NOT_INITIALIZED` envelopes until Phase 1.
// Phase 0.5 adds `runDiscovery()` for the verification queries.
// ---------------------------------------------------------------------------

interface LiteSpacesIpcError {
  code: string;
  message: string;
  remediation?: string;
  context?: Record<string, unknown>;
}

type LiteSpacesIpcResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: LiteSpacesIpcError };

interface LiteSpacesDiscoveryQueryResultView {
  id: 'Q1' | 'Q2' | 'Q3' | 'Q4';
  title: string;
  gating: 'GATING' | 'INFORMATIONAL';
  rationale: string;
  ok: boolean;
  durationMs: number;
  cypher: string;
  rows: Array<Record<string, unknown>>;
  summary?: string;
  error?: { code: string; message: string };
  notes: string[];
}

interface LiteSpacesDiscoveryResultsView {
  startedAt: string;
  finishedAt: string;
  anyFailures: boolean;
  gatingFailures: boolean;
  results: LiteSpacesDiscoveryQueryResultView[];
}

type LiteSpaceItemKind =
  | 'document'
  | 'image'
  | 'url'
  | 'text'
  | 'audio'
  | 'video'
  | 'playbook'
  | 'ticket'
  | 'other';

type LiteSpaceKind = 'user' | 'shared';

type LiteTicketStatus = 'open' | 'in_progress' | 'done' | 'blocked';

interface LiteTicketDetails {
  status: LiteTicketStatus;
  priority?: 'low' | 'med' | 'high';
  assignee: LiteSpaceItemProvenance | null;
  playbookId?: string;
}

interface LiteSpace {
  id: string;
  name: string;
  description?: string;
  color?: string;
  iconKey?: string;
  itemCount?: number;
  createdAt?: string;
  updatedAt?: string;
  /** 'user' (default) or 'shared' (AI-managed). */
  kind?: LiteSpaceKind;
}

interface LiteSpaceChipRef {
  id: string;
  name: string;
  color?: string;
  iconKey?: string;
}

interface LiteSpaceItemProvenance {
  kind: string;
  name: string;
  id: string;
}

interface LiteSpaceItemSummary {
  id: string;
  title: string;
  kind: LiteSpaceItemKind;
  fileKey?: string;
  sourceUrl?: string;
  createdAt: string;
  updatedAt: string;
  excerpt?: string;
  otherSpaces: LiteSpaceChipRef[];
  producedBy: LiteSpaceItemProvenance | null;
}

interface LiteSpaceItem extends LiteSpaceItemSummary {
  content?: string;
  metadata?: Record<string, unknown>;
  /** Byte size for binary kinds. Floored non-negative integer. */
  size?: number;
  /** MIME type ('image/png' etc.) — refines preview for `other`-kind binaries. */
  mimeType?: string;
  /** Plain-text tag list (canonical or [:TAGGED_AS] projection). */
  tags?: string[];
  /** Last edit attribution; null when the schema has no [:LAST_EDITED] edge yet. */
  lastEditedBy?: LiteSpaceItemProvenance | null;
  /** Ticket-specific details (only populated when kind === 'ticket'). */
  ticket?: LiteTicketDetails;
}

interface LiteSpacesItemsBridge {
  list(
    scopeId: string,
    opts?: { limit?: number; offset?: number }
  ): Promise<LiteSpacesIpcResult<LiteSpaceItemSummary[]>>;
  get(id: string): Promise<LiteSpacesIpcResult<LiteSpaceItem | null>>;
  /**
   * Resolve a binary `fileKey` (from `LiteSpaceItem.fileKey`) into a
   * short-TTL signed URL via the Files module. Returns `null` in the
   * envelope when the item has no fileKey or the resolver could not
   * mint a URL. Used by the detail panel to render image previews +
   * binary download links.
   */
  resolveFileUrl(key: string): Promise<LiteSpacesIpcResult<string | null>>;
  /**
   * Phase 3b item mutations. Each returns the updated server state
   * (the full Item for `update`, the post-mutation tag list for
   * `addTag` / `removeTag`) so the renderer can refresh without
   * issuing a follow-up `get`.
   */
  update(
    id: string,
    patch: {
      title?: string;
      description?: string;
      type?: LiteSpaceItemKind;
      editorId?: string;
    }
  ): Promise<LiteSpacesIpcResult<LiteSpaceItem>>;
  addTag(id: string, tag: string): Promise<LiteSpacesIpcResult<string[]>>;
  removeTag(id: string, tag: string): Promise<LiteSpacesIpcResult<string[]>>;
  /**
   * Phase 3c — per-asset activity log. Returns recent `:Commit` rows
   * referencing this asset, ordered newest first. Same row shape as
   * the home-feed event view so the detail-pane timeline can reuse the
   * existing event-row renderer.
   *
   * Defaults: 20 rows. Cap: 100.
   */
  recentCommits(
    id: string,
    opts?: { limit?: number; since?: number }
  ): Promise<LiteSpacesIpcResult<LiteSpacesEventView[]>>;
}

// ─── Home view (chunk 3k + 3o) ───────────────────────────────────────────
//
// Bridge-safe view types mirroring the Home types in
// `lite/spaces/types.ts`. Documented in `lite/spaces/HOME-V1.md`.

interface LiteSpacesEntityCountsView {
  spaces: number;
  assets: number;
  people: number;
  agents: number;
}

interface LiteSpacesContributorView {
  author: string;
  displayName: string;
  events: number;
  lastEventAt: string;
}

interface LiteSpacesEventView {
  id: string;
  author: string;
  kind: string;
  timestamp: string;
  spaceId?: string;
  spaceName?: string;
}

interface LiteSpacesAgentSummaryView {
  id: string;
  name: string;
  description: string;
}

interface LiteSpacesPermissionSummaryView {
  visibleSpaceCount: number;
  totalSpaceCount?: number;
}

type LiteSpacesContributorWindow = 'day' | 'week' | 'month';

interface LiteSpacesHomeBridge {
  entityCounts(): Promise<LiteSpacesIpcResult<LiteSpacesEntityCountsView>>;
  recentItems(opts?: {
    limit?: number;
  }): Promise<LiteSpacesIpcResult<LiteSpaceItemSummary[]>>;
  topContributors(opts?: {
    window?: LiteSpacesContributorWindow;
    limit?: number;
  }): Promise<LiteSpacesIpcResult<LiteSpacesContributorView[]>>;
  recentEvents(opts?: {
    limit?: number;
    since?: number;
    /**
     * Optional Space scope. When set, only commits with the matching
     * `:Commit.spaceId` are returned. Powers the per-Space timeline.
     */
    spaceId?: string;
  }): Promise<LiteSpacesIpcResult<LiteSpacesEventView[]>>;
  agentsSample(opts?: {
    limit?: number;
  }): Promise<LiteSpacesIpcResult<LiteSpacesAgentSummaryView[]>>;
  permissionSummary(): Promise<
    LiteSpacesIpcResult<LiteSpacesPermissionSummaryView>
  >;
}

// ─── Mutation inputs (Phase 3a) ─────────────────────────────────────────

interface LiteSpacesCreateSpaceInput {
  name: string;
  description?: string;
  color?: string;
  iconKey?: string;
}

interface LiteSpacesDeleteSpaceOpts {
  /** Default true (soft delete). Set to false to hard-remove. */
  soft?: boolean;
}

interface LiteSpacesBridge {
  /** Open (or focus) the Spaces window. */
  open(): Promise<{ ok: true }>;
  listSpaces(): Promise<LiteSpacesIpcResult<LiteSpace[]>>;
  getUncategorizedCount(): Promise<LiteSpacesIpcResult<number>>;
  items: LiteSpacesItemsBridge;
  /** Phase 0.5 -- run Q1-Q4 verification queries. */
  runDiscovery(): Promise<LiteSpacesIpcResult<LiteSpacesDiscoveryResultsView>>;
  /** Home view (chunk 3k + 3o). See lite/spaces/HOME-V1.md. */
  home: LiteSpacesHomeBridge;
  /**
   * Mutations (Phase 3a). All four can fail with
   * `SPACES_INVALID_INPUT`, `SPACES_DUPLICATE_NAME`,
   * `SPACES_NOT_FOUND`, `SPACES_DELETE_NON_EMPTY`,
   * `SPACES_NOT_AUTHENTICATED`, `SPACES_CYPHER`, or `SPACES_NETWORK`.
   */
  createSpace(input: LiteSpacesCreateSpaceInput): Promise<LiteSpacesIpcResult<LiteSpace>>;
  renameSpace(id: string, name: string): Promise<LiteSpacesIpcResult<LiteSpace>>;
  deleteSpace(
    id: string,
    opts?: LiteSpacesDeleteSpaceOpts
  ): Promise<LiteSpacesIpcResult<{ ok: true }>>;
  undeleteSpace(id: string): Promise<LiteSpacesIpcResult<LiteSpace>>;
  /**
   * Phase 4 — shared spaces. Toggles a Space between 'user' (default,
   * user-managed) and 'shared' (AI-managed dashboard layout).
   */
  setSpaceKind(
    id: string,
    kind: LiteSpaceKind
  ): Promise<LiteSpacesIpcResult<LiteSpaceKind>>;
  /** Playbooks sub-surface. */
  playbooks: LiteSpacesPlaybooksBridge;
  /** Tickets sub-surface. */
  tickets: LiteSpacesTicketsBridge;
  /** Phase 4 v2 — identity + sharing. */
  identity: LiteSpacesIdentityBridge;
  members: LiteSpacesMembersBridge;
}

interface LiteSpacesIdentityBridge {
  /** Upsert a Person by id. Idempotent. */
  getOrCreatePerson(input: {
    id: string;
    name?: string;
    email?: string;
  }): Promise<LiteSpacesIpcResult<{ id: string; name: string; email?: string }>>;
}

interface LiteSpacesMemberView {
  /** 'Person' or 'Agent'. */
  kind: string;
  id: string;
  name: string;
}

interface LiteSpacesMembersBridge {
  /** List every Person + Agent with HAS_ACCESS to a Space. */
  list(spaceId: string): Promise<LiteSpacesIpcResult<LiteSpacesMemberView[]>>;
  /** Grant a Person or Agent access. Idempotent. */
  add(
    spaceId: string,
    memberId: string
  ): Promise<LiteSpacesIpcResult<LiteSpacesMemberView>>;
  /** Revoke access. No-op when already absent. */
  remove(spaceId: string, memberId: string): Promise<LiteSpacesIpcResult<{ ok: true }>>;
}

interface LiteSpacesPlaybooksBridge {
  /** Return the current playbook for a Space, or null when none is set. */
  current(spaceId: string): Promise<LiteSpacesIpcResult<LiteSpaceItem | null>>;
  /**
   * Promote an Asset to current playbook. Drops any previous edge.
   * The returned ticketCount is the number of tickets already linked.
   */
  set(
    spaceId: string,
    playbookId: string
  ): Promise<LiteSpacesIpcResult<{ playbook: LiteSpaceItem; ticketCount: number }>>;
}

interface LiteSpacesTicketsBridge {
  /** List tickets in a Space, ordered by status (open first). */
  list(
    spaceId: string,
    opts?: { status?: LiteTicketStatus; limit?: number; offset?: number }
  ): Promise<LiteSpacesIpcResult<LiteSpaceItem[]>>;
  /** Create a new ticket. */
  create(
    spaceId: string,
    input: {
      title: string;
      description?: string;
      status?: LiteTicketStatus;
      priority?: 'low' | 'med' | 'high';
      playbookId?: string;
      assigneeId?: string;
    }
  ): Promise<LiteSpacesIpcResult<LiteSpaceItem>>;
  /** Update an existing ticket. Pass assigneeId: null to clear it. */
  update(
    id: string,
    patch: {
      title?: string;
      description?: string;
      status?: LiteTicketStatus;
      priority?: 'low' | 'med' | 'high';
      assigneeId?: string | null;
    }
  ): Promise<LiteSpacesIpcResult<LiteSpaceItem>>;
}

// ---------------------------------------------------------------------------
// University bridge -- mirrors lite/university/api.ts UniversityApi.
//
// Hosts the top-level "Agentic University" menu (Open LMS, Quick
// Starts -> View All Tutorials + 4 courses, AI Run Times, Wiser
// Method) plus the polished tutorials catalog window. All link
// items open in a Lite-internal Learning Browser (separate
// persistent partition from the IDW placeholder browser).
// ---------------------------------------------------------------------------

type LiteUniversityKind =
  | 'lms'
  | 'course'
  | 'tutorial'
  | 'feed'
  | 'method';

interface LiteLearningEntry {
  id: string;
  kind: LiteUniversityKind;
  title: string;
  description: string;
  url: string;
  category?: string;
  duration?: string;
  iconEmoji?: string;
  thumbnailUrl?: string;
  inTopLevelMenu?: boolean;
  featured?: boolean;
}

interface LiteUniversityErrorJSON {
  name: string;
  code: string;
  message: string;
  context: Record<string, unknown>;
  remediation: string;
  cause?: string;
}

interface LiteUniversityBridge {
  /** All curated entries, in catalog display order. */
  list(): Promise<LiteLearningEntry[]>;
  /** Filter the curated catalog by kind. */
  listByKind(kind: LiteUniversityKind): Promise<LiteLearningEntry[]>;
  /** Single curated entry by id, or null if absent. */
  get(id: string): Promise<LiteLearningEntry | null>;
  /**
   * Open the entry in the shared Learning Browser. Throws an Error
   * whose `.message` is JSON containing
   * `{__universityError: LiteUniversityErrorJSON}` -- use
   * `parseError(err)` to recover the structure.
   */
  open(id: string): Promise<{ ok: true }>;
  /** Open (or focus) the polished tutorials catalog window. */
  openTutorials(): Promise<{ ok: true }>;
  /** Parse a thrown error to recover the structured UniversityError. */
  parseError(err: unknown): LiteUniversityErrorJSON | null;
}

// ---------------------------------------------------------------------------
// Main window (tabbed agent browser) bridge -- mirrors lite/main-window/api.ts.
// Available only on the chrome (tab bar) webContents; agent tab views
// have NO preload so they cannot reach this surface. ADR-038.
// ---------------------------------------------------------------------------

interface LiteMainWindowTab {
  id: string;
  label: string;
  url: string;
  idwId?: string;
  partition: string;
  iconName?: string;
  createdAt: string;
  updatedAt: string;
}

interface LiteMainWindowOpenTabInput {
  url: string;
  label: string;
  idwId?: string;
  iconName?: string;
}

interface LiteMainWindowOpenTabResult {
  tab: LiteMainWindowTab;
  wasFocus: boolean;
}

interface LiteMainWindowErrorJSON {
  name: string;
  code: string;
  message: string;
  context: Record<string, unknown>;
  remediation: string;
  cause?: string;
}

interface LiteMainWindowBridge {
  listTabs(): Promise<LiteMainWindowTab[]>;
  getActiveTabId(): Promise<{ activeId: string | null }>;
  openTab(input: LiteMainWindowOpenTabInput): Promise<LiteMainWindowOpenTabResult>;
  closeTab(id: string): Promise<{ ok: true }>;
  activateTab(id: string): Promise<{ ok: true }>;
  goHome(): Promise<{ ok: true }>;
  /**
   * Subscribe to tab-list mutations broadcast from the main process.
   * Returns an unsubscribe. Receives the full latest tab list +
   * activeId on each change.
   */
  onTabsChanged(
    handler: (payload: { tabs: LiteMainWindowTab[]; activeId: string | null }) => void
  ): () => void;
  parseError(err: unknown): LiteMainWindowErrorJSON | null;
}

// ---------------------------------------------------------------------------
// Event bus bridge -- mirrors lite/event-bus/api.ts EventBusApi.
// Exposes the subscription surface to renderers per ADR-043.
// ---------------------------------------------------------------------------

interface LiteEventBusEvent {
  /** Domain event name, e.g. `user.signed-in`, `agent.tab.opened`. */
  name: string;
  /** Unique event id (UUID). */
  id: string;
  /** ISO 8601 timestamp. */
  ts: string;
  /** Typed payload -- shape determined by `name`. Renderers branch and
   *  cast as needed; the union lives in `lite/event-bus/types.ts`. */
  data: unknown;
}

interface LiteEventBusBridge {
  /**
   * Subscribe to a single domain event by exact name (e.g.
   * `user.signed-in`). Returns an unsubscribe function. Default is
   * future-only; pass `{ replay: true }` to receive the recent
   * matching events from the bus's ring buffer first.
   */
  on(
    name: string,
    handler: (event: LiteEventBusEvent) => void,
    opts?: { replay?: boolean }
  ): () => void;
  /**
   * Subscribe via glob pattern (e.g. `agent.tab.*`, `*.signed-in`,
   * `*` for everything). Returns unsubscribe. Same `replay` option
   * as `on`.
   */
  onPattern(
    pattern: string,
    handler: (event: LiteEventBusEvent) => void,
    opts?: { replay?: boolean }
  ): () => void;
  /** Snapshot read of recent events. */
  recent(name?: string | null, limit?: number): Promise<LiteEventBusEvent[]>;
  /** Total events currently held in the ring buffer. */
  size(): Promise<{ size: number }>;
  /** Manually emit a domain event (publish without waiting for the
   *  raw-event translator). */
  emit(payload: { name: string; data?: unknown }): Promise<LiteEventBusEvent>;
}

interface LiteWindowBridge {
  version?: string;
  platform?: string;
  appTag?: 'lite';
  auth?: LiteAuthBridge;
  totp?: LiteTotpBridge;
  settings?: LiteSettingsBridge;
  spaces?: LiteSpacesBridge;
  apiDocs?: LiteApiDocsBridge;
  health?: LiteHealthBridge;
  neon?: LiteNeonBridge;
  idw?: LiteIdwBridge;
  tools?: LiteToolsBridge;
  mainWindow?: LiteMainWindowBridge;
  events?: LiteEventBusBridge;
  university?: LiteUniversityBridge;
  // ai bridge removed -- TTS + lite/ai/ pulled.
  aiRunTimes?: LiteAiRunTimesBridge;
  onboarding?: LiteOnboardingBridge;
}

// ---------------------------------------------------------------------------
// Lite AI service bridge -- removed in the first-run UX hardening
// pass (TTS pulled). Re-introducing it is a separate chunk.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// AI Run Times bridge -- mirrors lite/ai-run-times/api.ts AiRunTimesApi.
// ---------------------------------------------------------------------------

type LiteAiRunTimesPreferenceId =
  | 'conv-design'
  | 'ai-analytics'
  | 'enterprise-ai'
  | 'implementation'
  | 'ai-trends'
  | 'llm-tech'
  | 'platform-updates';

interface LiteAiRunTimesArticle {
  id: string;
  feedId: string;
  title: string;
  link: string;
  description: string;
  thumbnailUrl: string | null;
  author: string | null;
  publishedAt: string | null;
  categories: string[];
  contentHtml: string | null;
  contentFetchedAt: string | null;
  wordCount: number;
  readingTimeMinutes: number;
}

interface LiteAiRunTimesFeedSource {
  id: string;
  label: string;
  url: string;
  enabled: boolean;
  addedAt: string;
  lastFetchedAt: string | null;
}

interface LiteAiRunTimesPreference {
  id: LiteAiRunTimesPreferenceId;
  label: string;
  description: string;
  enabled: boolean;
}

interface LiteAiRunTimesReadingLogEntry {
  articleId: string;
  title: string;
  link: string;
  openedAt: string;
  finishedAt: string | null;
  wordCount: number;
  listenedToCompletion: boolean;
}

interface LiteAiRunTimesRefreshResult {
  fetchedCount: number;
  newArticles: number;
  perFeed: Array<
    | { feedId: string; ok: true; articleCount: number; newArticles: number }
    | { feedId: string; ok: false; code: string; message: string }
  >;
}

interface LiteAiRunTimesErrorJSON {
  name: string;
  code: string;
  message: string;
  context: Record<string, unknown>;
  remediation: string;
  cause?: string;
}

interface LiteAiRunTimesBridge {
  listArticles(): Promise<LiteAiRunTimesArticle[]>;
  getArticle(id: string): Promise<LiteAiRunTimesArticle | null>;
  refreshFeed(): Promise<LiteAiRunTimesRefreshResult>;
  fetchArticleBody(id: string): Promise<LiteAiRunTimesArticle>;
  listPreferences(): Promise<LiteAiRunTimesPreference[]>;
  savePreferences(enabledIds: LiteAiRunTimesPreferenceId[]): Promise<LiteAiRunTimesPreference[]>;
  listFeedSources(): Promise<LiteAiRunTimesFeedSource[]>;
  addFeedSource(input: { label: string; url: string }): Promise<LiteAiRunTimesFeedSource>;
  removeFeedSource(id: string): Promise<{ ok: true }>;
  toggleFeedSource(id: string, enabled: boolean): Promise<LiteAiRunTimesFeedSource>;
  listReadingLog(): Promise<LiteAiRunTimesReadingLogEntry[]>;
  recordRead(entry: {
    articleId: string;
    title: string;
    link: string;
    wordCount: number;
    finishedAt?: string | null;
    listenedToCompletion?: boolean;
  }): Promise<LiteAiRunTimesReadingLogEntry>;
  clearReadingLog(): Promise<{ ok: true }>;
  exportReadingLog(): Promise<string>;
  openWindow(): Promise<{ ok: true }>;
  // cachedTts removed alongside the AI module (TTS pulled).
  parseError(err: unknown): LiteAiRunTimesErrorJSON | null;
}

// ---------------------------------------------------------------------------
// Onboarding bridge -- mirrors lite/onboarding/api.ts OnboardingApi.
// ---------------------------------------------------------------------------

type LiteOnboardingStepId =
  | 'signed-in'
  | 'two-factor-saved'
  | 'first-agent-opened';

interface LiteOnboardingState {
  schemaVersion: 1;
  completedAt: Partial<Record<LiteOnboardingStepId, string>>;
  dismissedAt: string | null;
}

interface LiteOnboardingBridge {
  load(): Promise<LiteOnboardingState>;
  markComplete(stepId: LiteOnboardingStepId): Promise<LiteOnboardingState>;
  dismiss(): Promise<LiteOnboardingState>;
}

// ---------------------------------------------------------------------------
// Global Window augmentation. Only `window.lite` is declared here
// (shared between renderer entry points). `window.bugReport` lives in
// lite/bug-report/modal.ts because only that file uses it.
// ---------------------------------------------------------------------------

// NOTE: this file has NO `export {}` -- it's intentionally an ambient
// script, so every type/interface above is in the global namespace
// (consumers can refer to `LiteAuthBridge`, `LiteAuthEnvironment`,
// etc. without importing). All identifiers are prefixed `Lite` to
// keep the global namespace pollution scoped.

/**
 * Renderer-side structured logging surface, mirrors `LoggingBridge`
 * in `preload-lite.ts`. `event` is the primary lever for emitting
 * named events into the central log; `info/warn/error/debug` log
 * free-form messages with a `category`. Spans (`start()`) stay
 * main-process only -- see ADR-025.
 */
interface LiteLoggingBridge {
  debug(category: string, message: string, data?: unknown): void;
  info(category: string, message: string, data?: unknown): void;
  warn(category: string, message: string, data?: unknown): void;
  error(category: string, message: string, data?: unknown): void;
  event(
    name: string,
    data?: unknown,
    level?: 'debug' | 'info' | 'warn' | 'error'
  ): void;
  recent(
    pattern: string,
    limit?: number
  ): Promise<
    Array<{
      timestamp: string;
      name: string;
      data?: unknown;
      level?: 'debug' | 'info' | 'warn' | 'error';
    }>
  >;
}

interface Window {
  lite?: LiteWindowBridge;
  logging?: LiteLoggingBridge;
}
