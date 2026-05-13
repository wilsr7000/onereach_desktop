/**
 * Onereach Lite preload bridge -- minimal contextBridge surface.
 *
 * Per ADR-011 (slim kernel) and lite/LITE-RULES.md, the kernel exposes
 * only:
 *   - window.lite       : version + platform metadata
 *   - window.logging    : structured logging into lite's log server
 *   - window.bugReport  : capture / save / close for the bug-report modal
 *
 * window.ai, window.spaces, window.idw, etc. are NOT exposed in the
 * kernel. Each is added when its respective menu-item port lands.
 *
 * Borrowed pattern: contextBridge.exposeInMainWorld + ipcRenderer.invoke
 *   shape from preload.js + preload-spaces.js (full app, not imported,
 *   only studied).
 */

import { contextBridge, ipcRenderer } from 'electron';

const BUG_REPORT_CAPTURE = 'lite:bug-report:capture';
const BUG_REPORT_SAVE = 'lite:bug-report:save';
const BUG_REPORT_CLOSE = 'lite:bug-report:close';
const BUG_REPORT_LIST = 'lite:bug-report:list';
const BUG_REPORT_READ = 'lite:bug-report:read';
const BUG_REPORT_UPDATE = 'lite:bug-report:update';
const BUG_REPORT_DELETE = 'lite:bug-report:delete';
const BUG_REPORT_ATTACH = 'lite:bug-report:attach';
const BUG_REPORT_DOWNLOAD_ATTACHMENT = 'lite:bug-report:download-attachment';

const LOGGING_ENQUEUE = 'lite:logging:enqueue';
const LOGGING_EVENT = 'lite:logging:event';
const LOGGING_RECENT = 'lite:logging:recent';

const UPDATER_CHECK = 'lite:updater:check';
const UPDATER_INSTALL = 'lite:updater:install';
const UPDATER_GET_STATE = 'lite:updater:get-state';
const UPDATER_STATUS_EVENT = 'lite:updater:status';

const AUTH_SIGN_IN = 'lite:auth:sign-in';
const AUTH_SIGN_OUT = 'lite:auth:sign-out';
const AUTH_GET_SESSION = 'lite:auth:get-session';
const AUTH_GET_TOKEN_BUNDLE = 'lite:auth:get-token-bundle';
const AUTH_HAS_VALID_SESSION = 'lite:auth:has-valid-session';
const AUTH_SESSION_CHANGED = 'lite:auth:session-changed';
const AUTH_TWO_FACTOR_NEEDS_SETUP = 'lite:auth:2fa-needs-setup';

const TOTP_HAS_SECRET = 'lite:totp:has-secret';
const TOTP_GET_METADATA = 'lite:totp:get-metadata';
const TOTP_SAVE_SECRET = 'lite:totp:save-secret';
const TOTP_SCAN_QR_SCREEN = 'lite:totp:scan-qr-screen';
const TOTP_SCAN_QR_CLIPBOARD = 'lite:totp:scan-qr-clipboard';
const TOTP_GET_CURRENT_CODE = 'lite:totp:get-current-code';
const TOTP_DELETE_SECRET = 'lite:totp:delete-secret';

const SETTINGS_OPEN = 'lite:settings:open';
const API_DOCS_OPEN = 'lite:api-docs:open';
const HEALTH_SNAPSHOT = 'lite:health:snapshot';

// Spaces (Phase 0): only OPEN is bridged for the renderer today. The
// data methods (LIST_SPACES, UNCATEGORIZED_COUNT, ITEMS_LIST, ITEMS_GET)
// are registered main-side now so the Phase 1 wiring is a pure
// renderer-bridge addition with no main-process churn. The renderer
// surface is bridged once Phase 1 lands real fetches.
const SPACES_OPEN = 'lite:spaces:open';
const SPACES_LIST_SPACES = 'lite:spaces:listSpaces';
const SPACES_UNCATEGORIZED_COUNT = 'lite:spaces:uncategorizedCount';
const SPACES_ITEMS_LIST = 'lite:spaces:items:list';
const SPACES_ITEMS_GET = 'lite:spaces:items:get';
const SPACES_DISCOVERY_RUN = 'lite:spaces:discovery:run';

const NEON_QUERY = 'lite:neon:query';
const NEON_STATUS = 'lite:neon:status';
const NEON_TEST_CONNECTION = 'lite:neon:test-connection';
const NEON_CONFIGURE = 'lite:neon:configure';

const EVENT_BUS_RECENT = 'lite:event-bus:recent';
const EVENT_BUS_SIZE = 'lite:event-bus:size';
const EVENT_BUS_EMIT = 'lite:event-bus:emit';
const EVENT_BUS_EVENT = 'lite:event-bus:event';

const MAIN_WINDOW_OPEN_TAB = 'lite:main-window:open-tab';
const MAIN_WINDOW_CLOSE_TAB = 'lite:main-window:close-tab';
const MAIN_WINDOW_ACTIVATE_TAB = 'lite:main-window:activate-tab';
const MAIN_WINDOW_LIST_TABS = 'lite:main-window:list-tabs';
const MAIN_WINDOW_GET_ACTIVE = 'lite:main-window:get-active';
const MAIN_WINDOW_GO_HOME = 'lite:main-window:go-home';
const MAIN_WINDOW_CHANGED = 'lite:main-window:changed';

const IDW_LIST = 'lite:idw:list';
const IDW_LIST_BY_KIND = 'lite:idw:list-by-kind';
const IDW_GET = 'lite:idw:get';
const IDW_ADD = 'lite:idw:add';
const IDW_UPDATE = 'lite:idw:update';
const IDW_REMOVE = 'lite:idw:remove';
// Note: `lite:idw:open` is registered main-side for future renderer
// consumers (e.g. a launcher window) but is intentionally NOT bridged
// here -- agents are opened by the IDW menu's click handlers, which
// run in main process.
const IDW_OPEN_STORE = 'lite:idw:open-store';
const IDW_CHANGED = 'lite:idw:changed';

const TOOLS_LIST = 'lite:tools:list';
const TOOLS_GET = 'lite:tools:get';
const TOOLS_ADD = 'lite:tools:add';
const TOOLS_UPDATE = 'lite:tools:update';
const TOOLS_REMOVE = 'lite:tools:remove';
const TOOLS_OPEN_MANAGER = 'lite:tools:open-manager';
const TOOLS_CHANGED = 'lite:tools:changed';

const UNIVERSITY_LIST = 'lite:university:list';
const UNIVERSITY_LIST_BY_KIND = 'lite:university:list-by-kind';
const UNIVERSITY_GET = 'lite:university:get';
const UNIVERSITY_OPEN = 'lite:university:open';
const UNIVERSITY_OPEN_TUTORIALS = 'lite:university:open-tutorials';

// Lite AI service IPC channels
// AI service IPC channels removed -- the lite/ai/ module was pulled
// in the first-run UX hardening pass along with TTS. Re-introducing
// them is a separate chunk.

// Onboarding IPC channels
const ONBOARDING_LOAD = 'lite:onboarding:load';
const ONBOARDING_MARK_COMPLETE = 'lite:onboarding:mark-complete';
const ONBOARDING_DISMISS = 'lite:onboarding:dismiss';

// AI Run Times IPC channels
const ART_LIST_ARTICLES = 'lite:ai-run-times:list-articles';
const ART_REFRESH_FEED = 'lite:ai-run-times:refresh-feed';
const ART_GET_ARTICLE = 'lite:ai-run-times:get-article';
const ART_FETCH_ARTICLE_BODY = 'lite:ai-run-times:fetch-article-body';
const ART_LIST_PREFERENCES = 'lite:ai-run-times:list-preferences';
const ART_SAVE_PREFERENCES = 'lite:ai-run-times:save-preferences';
const ART_LIST_FEED_SOURCES = 'lite:ai-run-times:list-feed-sources';
const ART_ADD_FEED_SOURCE = 'lite:ai-run-times:add-feed-source';
const ART_REMOVE_FEED_SOURCE = 'lite:ai-run-times:remove-feed-source';
const ART_TOGGLE_FEED_SOURCE = 'lite:ai-run-times:toggle-feed-source';
const ART_LIST_READING_LOG = 'lite:ai-run-times:list-reading-log';
const ART_RECORD_READ = 'lite:ai-run-times:record-read';
const ART_CLEAR_READING_LOG = 'lite:ai-run-times:clear-reading-log';
const ART_EXPORT_READING_LOG = 'lite:ai-run-times:export-reading-log';
const ART_OPEN_WINDOW = 'lite:ai-run-times:open-window';
// ART_CACHED_TTS removed alongside the AI module.

interface LiteMetadata {
  version: string;
  platform: NodeJS.Platform;
  appTag: 'lite';
}

interface LoggingEventRecord {
  id: string;
  timestamp: string;
  name: string;
  category: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  data?: unknown;
  spanId?: string;
  parentSpanId?: string;
  durationMs?: number;
  error?: {
    code: string;
    message: string;
    remediation: string;
    context?: Record<string, unknown>;
    name?: string;
  };
}

interface LoggingBridge {
  /** Log lines flow into the lite log queue at port 47392. Renderer-side. */
  debug(category: string, message: string, data?: unknown): void;
  info(category: string, message: string, data?: unknown): void;
  warn(category: string, message: string, data?: unknown): void;
  error(category: string, message: string, data?: unknown): void;
  /**
   * Emit a structured event from the renderer. Spans stay main-process
   * only (cross-IPC span lifecycle is too risky); renderer code emits
   * paired `<name>.start` / `<name>.finish` instant events instead.
   */
  event(name: string, data?: unknown, level?: 'debug' | 'info' | 'warn' | 'error'): void;
  /**
   * Get the last N events matching a glob pattern (e.g. `kv.*`,
   * `*.fail`). Returns newest-first.
   */
  recent(pattern: string, limit?: number): Promise<LoggingEventRecord[]>;
}

interface BugReportSummary {
  filePath: string;
  filename: string;
  timestamp: string;
  version: string;
  descriptionPreview: string;
  redactionBucket: 'none' | 'low' | 'medium' | 'high';
  redactionTotalCount: number;
  bytes: number;
  status: 'open' | 'resolved';
  hasNotes: boolean;
}

interface BugReportUpdateResult {
  payload: unknown;
  kvUpdated: boolean;
  kvError: string | null;
}

interface BugReportDeleteResult {
  kvDeleted: boolean;
  kvError: string | null;
}

interface BugReportSaveResult {
  kvWritten: boolean;
  kvError: string | null;
}

interface UpdaterState {
  failedAttempts: number;
  lastAttemptVersion: string | null;
  lastAttemptTime: string | null;
}

type UpdaterStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'progress'
  | 'downloaded'
  | 'installing'
  | 'error';

interface UpdaterStatusPayload {
  status: UpdaterStatus;
  info?: unknown;
}

interface UpdaterBridge {
  /** Trigger a check for updates. `manual` controls whether "no updates" dialogs are shown. */
  check(opts?: { manual?: boolean }): Promise<{ inFlight: boolean; timedOut: boolean; manual: boolean }>;
  /** Install the most recently downloaded update (no-op if none downloaded yet). */
  install(): Promise<{ attempted: boolean; targetVersion: string | null }>;
  /** Read the persisted update-state.json contents. */
  getState(): Promise<UpdaterState>;
  /** Subscribe to status events. Returns an unsubscribe function. */
  onStatus(listener: (event: UpdaterStatusPayload) => void): () => void;
}

// ---------------------------------------------------------------------------
// Auth bridge -- mirrors lite/auth/api.ts AuthApi MINUS getToken().
// Per ADR-026, the raw mult cookie value never crosses IPC. Renderers
// see only metadata (accountId, email, expiresAt, capturedAt).
// ---------------------------------------------------------------------------

type AuthEnvironment = 'edison' | 'staging' | 'dev' | 'production';

interface AuthSessionRendererView {
  environment: AuthEnvironment;
  accountId: string;
  email?: string;
  capturedAt: number;
  expiresAt?: number;
}

interface AuthTokenBundleView {
  multToken: string;
  accountToken: string;
  capturedAt: number;
  multExpiresAt?: number;
  accountExpiresAt?: number;
}

interface AuthErrorJSON {
  name: string;
  code: string;
  message: string;
  context: Record<string, unknown>;
  remediation: string;
  cause?: string;
}

interface AuthBridge {
  /**
   * Open the GSX sign-in window for the given environment. Resolves
   * with the captured session, or throws if the user cancels, the
   * cookies don't arrive in time, or KV persistence fails.
   *
   * On rejection, the thrown error's `.message` is JSON containing
   * `{__authError: AuthErrorJSON}` -- callers parse to get the stable
   * error code for branching, or just show the human-friendly message.
   */
  signIn(env: AuthEnvironment, opts?: { timeoutMs?: number }): Promise<{ session: AuthSessionRendererView }>;
  /** Sign out of an environment. Never throws. */
  signOut(env: AuthEnvironment): Promise<{ ok: true }>;
  /** Synchronously read the captured session, or null. */
  getSession(env: AuthEnvironment): Promise<{ session: AuthSessionRendererView | null }>;
  /**
   * Read the in-memory token bundle (`mult` + `or` cookie values)
   * captured during the last successful `signIn(env)`. Returns null
   * when no fresh sign-in has happened since the app started --
   * tokens are deliberately ephemeral across restarts.
   *
   * Surfaced for the Settings -> Account verification UI.
   */
  getTokenBundle(env: AuthEnvironment): Promise<{ bundle: AuthTokenBundleView | null }>;
  /** Quick "is the user signed in" check. */
  hasValidSession(env: AuthEnvironment): Promise<{ valid: boolean }>;
  /**
   * Subscribe to session-changed events. Fires when sign-in completes
   * or sign-out happens. Returns an unsubscribe function.
   */
  onSessionChanged(
    listener: (payload: { env: AuthEnvironment; session: AuthSessionRendererView | null }) => void
  ): () => void;
  /**
   * Subscribe to 2FA-needs-setup broadcasts. Fires when the autofill
   * watcher detects a OneReach 2FA prompt during sign-in but Lite has
   * no TOTP secret saved (i.e. the user needs to open Settings ->
   * Two-Factor and paste their authenticator setup secret).
   */
  on2FANeedsSetup(
    listener: (payload: AuthTwoFactorNeedsSetupPayload) => void
  ): () => void;
  /**
   * Convenience: parse a thrown signIn error to get the structured
   * code + remediation. Returns null if the message wasn't an AuthError.
   */
  parseError(err: unknown): AuthErrorJSON | null;
}

/**
 * Payload of the `lite:auth:2fa-needs-setup` broadcast.
 */
interface AuthTwoFactorNeedsSetupPayload {
  source: string;
  frameUrl: string;
  reason?: string;
  inputCount?: number;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// TOTP bridge -- mirrors lite/totp/api.ts TotpApi.
// Per ADR-027:
//   - Secret bytes are write-only (saveSecret + scan paths). NO getSecret.
//   - The live code IS exposed (it's ephemeral, 30s lifetime).
// ---------------------------------------------------------------------------

interface TotpSecretMetadataView {
  issuer?: string;
  account?: string;
  savedAt: string;
  secretLength: number;
}

interface TotpCodeInfoView {
  code: string;
  formattedCode: string;
  timeRemaining: number;
  expiresAt: number;
}

interface TotpQrScanResultView {
  saved: boolean;
  issuer?: string;
  account?: string;
  reason?: 'no-qr-found' | 'not-authenticator-qr' | 'invalid-secret' | 'keychain-failed';
}

interface TotpSaveResultView {
  saved: boolean;
  metadata?: TotpSecretMetadataView;
}

interface TotpErrorJSON {
  name: string;
  code: string;
  message: string;
  context: Record<string, unknown>;
  remediation: string;
  cause?: string;
}

interface TotpBridge {
  hasSecret(): Promise<{ hasSecret: boolean }>;
  getMetadata(): Promise<{ metadata: TotpSecretMetadataView | null }>;
  saveSecret(
    secret: string,
    extra?: { issuer?: string; account?: string }
  ): Promise<TotpSaveResultView>;
  scanQrFromScreen(): Promise<TotpQrScanResultView>;
  scanQrFromClipboard(): Promise<TotpQrScanResultView>;
  getCurrentCode(): Promise<TotpCodeInfoView>;
  deleteSecret(): Promise<{ ok: true }>;
  parseError(err: unknown): TotpErrorJSON | null;
}

// ---------------------------------------------------------------------------
// Settings bridge -- one method that opens or focuses the Settings
// window. Per ADR-031, the Settings shell hosts sections (Two-Factor in
// v1) that consume other modules' bridges (e.g. window.lite.totp.*).
//
// Optional sectionId deep-links to a section (e.g. 'idws', 'oagi').
// ---------------------------------------------------------------------------

interface SettingsBridge {
  open(sectionId?: string): Promise<{ ok: true }>;
}

interface ApiDocsBridge {
  /**
   * Open (or focus) the API Reference window. Idempotent: a second
   * call while the window is open focuses it instead of opening a
   * duplicate. ADR-035.
   */
  open(): Promise<{ ok: true }>;
}

// ---------------------------------------------------------------------------
// Spaces bridge (Phase 0 surface).
//
// Per the Spaces plan ("Spaces as Platform Primitive"), the Lite UI is
// the first consumer of the SpacesApi -- the SDK shape is the platform
// contract. The bridge mirrors `SpacesApi` from `lite/spaces/api.ts`.
//
// Phase 0 ships only `open()` calls that actually hit the wire. The
// data methods are stubbed wire-side: every call resolves with a
// `SpacesIpcResult` envelope where `ok === false` and the error code is
// `SPACES_NOT_INITIALIZED`. The renderer can already use the same call
// pattern -- Phase 1 just replaces the SDK implementation.
// ---------------------------------------------------------------------------

interface SpacesIpcErrorView {
  code: string;
  message: string;
  remediation?: string;
  context?: Record<string, unknown>;
}

type SpacesIpcResultView<T> =
  | { ok: true; value: T }
  | { ok: false; error: SpacesIpcErrorView };

interface SpacesItemsBridge {
  list(
    scopeId: string,
    opts?: { limit?: number; offset?: number }
  ): Promise<SpacesIpcResultView<unknown[]>>;
  get(id: string): Promise<SpacesIpcResultView<unknown | null>>;
}

// Phase 0.5 discovery: result shape mirrors lite/spaces/discovery.ts.
// Wide-typed at the bridge boundary so the renderer can evolve without
// preload changes; the source-of-truth type lives in
// lite/spaces/discovery.ts and is re-imported there.
interface SpacesDiscoveryQueryResultView {
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

interface SpacesDiscoveryResultsView {
  startedAt: string;
  finishedAt: string;
  anyFailures: boolean;
  gatingFailures: boolean;
  results: SpacesDiscoveryQueryResultView[];
}

interface SpacesBridge {
  /** Open (or focus) the Spaces window. */
  open(): Promise<{ ok: true }>;
  listSpaces(): Promise<SpacesIpcResultView<unknown[]>>;
  getUncategorizedCount(): Promise<SpacesIpcResultView<number>>;
  items: SpacesItemsBridge;
  /**
   * Phase 0.5 discovery -- run Q1-Q4 verification queries against the
   * configured Neon endpoint. Never throws; per-query failures land in
   * the envelope's `results[i].error`.
   */
  runDiscovery(): Promise<SpacesIpcResultView<SpacesDiscoveryResultsView>>;
}

interface HealthBridge {
  /**
   * Build a fresh "what is true right now?" snapshot across
   * documented lite modules. Best-effort -- missing or failing
   * sections produce safe fallbacks. Never rejects.
   *
   * The returned object has no fields for secrets by type
   * construction (see lite/health/types.ts).
   */
  snapshot(): Promise<LiteAppHealthSnapshotView>;
}

// ---------------------------------------------------------------------------
// Neon bridge -- mirrors lite/neon/api.ts NeonApi.
//
// configure() IS bridged here (the Settings -> Neon section needs it),
// but is namespaced under `window.lite.neon` -- only the Settings
// renderer is expected to call it. Status() never returns the
// password value; the renderer sees only `hasPassword: boolean`.
// ---------------------------------------------------------------------------

type NeonRecord = Record<string, unknown>;

interface NeonStatusView {
  endpoint: string | null;
  uri: string | null;
  user: string;
  database: string;
  hasPassword: boolean;
  ready: boolean;
}

interface NeonConfigPayload {
  endpoint?: string;
  uri?: string;
  user?: string;
  password?: string;
  database?: string;
}

interface NeonTestResult {
  ok: boolean;
  error?: string;
  code?: string;
}

interface NeonErrorJSON {
  name: string;
  code: string;
  message: string;
  context: Record<string, unknown>;
  remediation: string;
  cause?: string;
}

interface NeonBridge {
  query(
    cypher: string,
    parameters?: Record<string, unknown>
  ): Promise<{ records: NeonRecord[] }>;
  status(): Promise<NeonStatusView>;
  testConnection(): Promise<NeonTestResult>;
  configure(config: NeonConfigPayload): Promise<{ ok: true; status: NeonStatusView }>;
  parseError(err: unknown): NeonErrorJSON | null;
}

// ---------------------------------------------------------------------------
// IDW bridge -- mirrors lite/idw/api.ts IdwApi.
//
// Hosts the top-level "IDW" menu (multi-category roster of agents).
// All CRUD methods are bridged. `onChange` is bridged via the
// `lite:idw:changed` broadcast.
// ---------------------------------------------------------------------------

type IdwAgentKind =
  | 'idw'
  | 'external-bot'
  | 'image-creator'
  | 'video-creator'
  | 'audio-generator'
  | 'ui-design-tool';

type IdwAudioSubCategory = 'music' | 'effects' | 'narration' | 'custom';

interface IdwStoreMetadataView {
  catalogId: string;
  developer?: string;
  version?: string;
  installedAt: string;
  updatedAt?: string;
}

interface IdwEntryView {
  id: string;
  kind: IdwAgentKind;
  label: string;
  url: string;
  apiUrl?: string;
  source: 'manual' | 'store';
  description?: string;
  category?: string;
  iconName?: string;
  thumbnailUrl?: string;
  environment?: string;
  audio?: { subCategory: IdwAudioSubCategory };
  storeMetadata?: IdwStoreMetadataView;
  createdAt: string;
  updatedAt: string;
}

interface IdwAddPayload {
  id?: string;
  kind: IdwAgentKind;
  label: string;
  url: string;
  apiUrl?: string;
  source?: 'manual' | 'store';
  description?: string;
  category?: string;
  iconName?: string;
  thumbnailUrl?: string;
  environment?: string;
  audio?: { subCategory: IdwAudioSubCategory };
  storeMetadata?: IdwStoreMetadataView;
}

interface IdwAddResultView {
  entry: IdwEntryView;
  wasUpdate: boolean;
}

interface IdwErrorJSON {
  name: string;
  code: string;
  message: string;
  context: Record<string, unknown>;
  remediation: string;
  cause?: string;
}

interface IdwBridge {
  list(): Promise<IdwEntryView[]>;
  listByKind(kind: IdwAgentKind): Promise<IdwEntryView[]>;
  get(id: string): Promise<IdwEntryView | null>;
  add(entry: IdwAddPayload): Promise<IdwAddResultView>;
  update(id: string, patch: Partial<IdwEntryView>): Promise<IdwEntryView>;
  remove(id: string): Promise<{ ok: true }>;
  openStore(): Promise<{ ok: true }>;
  /**
   * Subscribe to `lite:idw:changed` broadcasts. Returns an
   * unsubscribe function. Receives the latest entries on each
   * mutation (from this window or any other).
   */
  onChange(handler: (entries: IdwEntryView[]) => void): () => void;
  parseError(err: unknown): IdwErrorJSON | null;
}

// ---------------------------------------------------------------------------
// Tools bridge -- mirrors lite/tools/api.ts ToolsApi.
//
// Hosts the top-level "Tools" menu (user-curated label+url shortcuts).
// All CRUD methods are bridged. `onChange` is bridged via the
// `lite:tools:changed` broadcast.
// ---------------------------------------------------------------------------

interface ToolEntryView {
  id: string;
  label: string;
  url: string;
  createdAt: string;
  updatedAt: string;
}

interface ToolAddPayload {
  id?: string;
  label: string;
  url: string;
}

interface ToolsErrorJSON {
  name: string;
  code: string;
  message: string;
  context: Record<string, unknown>;
  remediation: string;
  cause?: string;
}

interface ToolsBridge {
  list(): Promise<ToolEntryView[]>;
  get(id: string): Promise<ToolEntryView | null>;
  add(entry: ToolAddPayload): Promise<ToolEntryView>;
  update(id: string, patch: Partial<ToolEntryView>): Promise<ToolEntryView>;
  remove(id: string): Promise<{ ok: true }>;
  openManager(): Promise<{ ok: true }>;
  /** Subscribe to `lite:tools:changed` broadcasts. Returns an unsubscribe fn. */
  onChange(handler: (entries: ToolEntryView[]) => void): () => void;
  parseError(err: unknown): ToolsErrorJSON | null;
}

// ---------------------------------------------------------------------------
// University bridge -- mirrors lite/university/api.ts UniversityApi.
// ---------------------------------------------------------------------------

type UniversityKind = 'lms' | 'course' | 'tutorial' | 'feed' | 'method';

interface LearningEntryView {
  id: string;
  kind: UniversityKind;
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

interface UniversityErrorJSON {
  name: string;
  code: string;
  message: string;
  context: Record<string, unknown>;
  remediation: string;
  cause?: string;
}

interface UniversityBridge {
  list(): Promise<LearningEntryView[]>;
  listByKind(kind: UniversityKind): Promise<LearningEntryView[]>;
  get(id: string): Promise<LearningEntryView | null>;
  open(id: string): Promise<{ ok: true }>;
  openTutorials(): Promise<{ ok: true }>;
  parseError(err: unknown): UniversityErrorJSON | null;
}

// ---------------------------------------------------------------------------
// Lite AI service bridge -- removed in the first-run UX hardening
// pass along with TTS. Re-introducing it is a separate chunk.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// AI Run Times bridge
// ---------------------------------------------------------------------------

type ArtPreferenceId =
  | 'conv-design'
  | 'ai-analytics'
  | 'enterprise-ai'
  | 'implementation'
  | 'ai-trends'
  | 'llm-tech'
  | 'platform-updates';

interface ArtArticleView {
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

interface ArtFeedSourceView {
  id: string;
  label: string;
  url: string;
  enabled: boolean;
  addedAt: string;
  lastFetchedAt: string | null;
}

interface ArtPreferenceView {
  id: ArtPreferenceId;
  label: string;
  description: string;
  enabled: boolean;
}

interface ArtReadingLogEntryView {
  articleId: string;
  title: string;
  link: string;
  openedAt: string;
  finishedAt: string | null;
  wordCount: number;
  listenedToCompletion: boolean;
}

interface ArtRefreshResultView {
  fetchedCount: number;
  newArticles: number;
  perFeed: Array<
    | { feedId: string; ok: true; articleCount: number; newArticles: number }
    | { feedId: string; ok: false; code: string; message: string }
  >;
}

interface ArtErrorJSON {
  name: string;
  code: string;
  message: string;
  context: Record<string, unknown>;
  remediation: string;
  cause?: string;
}

interface AiRunTimesBridge {
  listArticles(): Promise<ArtArticleView[]>;
  getArticle(id: string): Promise<ArtArticleView | null>;
  refreshFeed(): Promise<ArtRefreshResultView>;
  fetchArticleBody(id: string): Promise<ArtArticleView>;
  listPreferences(): Promise<ArtPreferenceView[]>;
  savePreferences(enabledIds: ArtPreferenceId[]): Promise<ArtPreferenceView[]>;
  listFeedSources(): Promise<ArtFeedSourceView[]>;
  addFeedSource(input: { label: string; url: string }): Promise<ArtFeedSourceView>;
  removeFeedSource(id: string): Promise<{ ok: true }>;
  toggleFeedSource(id: string, enabled: boolean): Promise<ArtFeedSourceView>;
  listReadingLog(): Promise<ArtReadingLogEntryView[]>;
  recordRead(entry: {
    articleId: string;
    title: string;
    link: string;
    wordCount: number;
    finishedAt?: string | null;
    listenedToCompletion?: boolean;
  }): Promise<ArtReadingLogEntryView>;
  clearReadingLog(): Promise<{ ok: true }>;
  exportReadingLog(): Promise<string>;
  openWindow(): Promise<{ ok: true }>;
  // cachedTts removed alongside the AI module (TTS pulled).
  parseError(err: unknown): ArtErrorJSON | null;
}

// ---------------------------------------------------------------------------
// Onboarding bridge
// ---------------------------------------------------------------------------

type OnboardingStepIdView =
  | 'signed-in'
  | 'two-factor-saved'
  | 'first-agent-opened';

interface OnboardingStateView {
  schemaVersion: 1;
  completedAt: Partial<Record<OnboardingStepIdView, string>>;
  dismissedAt: string | null;
}

interface OnboardingBridge {
  load(): Promise<OnboardingStateView>;
  markComplete(stepId: OnboardingStepIdView): Promise<OnboardingStateView>;
  dismiss(): Promise<OnboardingStateView>;
}

interface BugReportAttachmentView {
  key: string;
  name: string;
  contentType: string;
  size: number;
  uploadedAt: string;
}

interface BugReportBridge {
  capture(userDescription: string): Promise<{
    payload: unknown;
    payloadJson: string;
    redactionStatus: 'none' | 'low' | 'medium' | 'high';
    redactionTotalCount: number;
  }>;
  /**
   * Save the report. Optional `attachments` are file references already
   * uploaded via `attach()`; the main process forwards them onto the
   * payload so the saved report carries the file keys (not the bytes).
   */
  save(
    userDescription: string,
    attachments?: BugReportAttachmentView[]
  ): Promise<BugReportSaveResult>;
  close(): void;
  list(): Promise<BugReportSummary[]>;
  read(idOrPath: string): Promise<unknown>;
  update(timestamp: string, updates: { status?: 'open' | 'resolved'; notes?: string }): Promise<BugReportUpdateResult>;
  delete(timestamp: string): Promise<BugReportDeleteResult>;
  /**
   * Upload a file as a bug-report attachment. Returns metadata that
   * the renderer collects and passes to `save()`. Backed by
   * `lite/files/` (ADR-045) -- the bytes go into the user's
   * authenticated Files bucket at a per-report staging prefix; the
   * payload only references the file key.
   */
  attach(input: {
    name: string;
    contentType: string;
    /** Base64-encoded file bytes. The renderer encodes; main decodes. */
    base64: string;
  }): Promise<BugReportAttachmentView>;
  /**
   * Resolve a fresh signed download URL for an existing attachment
   * by its file key. The URL is good for ~15 min; re-resolve on
   * each user click. Server-side ACL: only the signed-in user who
   * owns the bucket can fetch.
   */
  downloadAttachment(key: string): Promise<string>;
}

// Read app metadata from additionalArguments (passed via webPreferences in
// main-lite.ts createMainWindow). Sandboxed preloads can read process.argv
// reliably; env vars are less consistent across Electron versions.
function readVersionFromArgs(): string {
  const arg = process.argv.find((a) => a.startsWith('--lite-app-version='));
  if (arg !== undefined) return arg.slice('--lite-app-version='.length);
  return process.env.LITE_APP_VERSION ?? '0.0.0';
}

const liteMetadata: LiteMetadata = {
  version: readVersionFromArgs(),
  platform: process.platform,
  appTag: 'lite',
};

const logging: LoggingBridge = {
  debug: (category: string, message: string, data?: unknown): void => {
    ipcRenderer.send(LOGGING_ENQUEUE, { level: 'debug', category, message, data });
  },
  info: (category: string, message: string, data?: unknown): void => {
    ipcRenderer.send(LOGGING_ENQUEUE, { level: 'info', category, message, data });
  },
  warn: (category: string, message: string, data?: unknown): void => {
    ipcRenderer.send(LOGGING_ENQUEUE, { level: 'warn', category, message, data });
  },
  error: (category: string, message: string, data?: unknown): void => {
    ipcRenderer.send(LOGGING_ENQUEUE, { level: 'error', category, message, data });
  },
  event: (name: string, data?: unknown, level?: 'debug' | 'info' | 'warn' | 'error'): void => {
    ipcRenderer.send(LOGGING_EVENT, { name, data, level });
  },
  recent: (pattern: string, limit?: number): Promise<LoggingEventRecord[]> =>
    ipcRenderer.invoke(LOGGING_RECENT, { pattern, limit }) as Promise<LoggingEventRecord[]>,
};

const bugReport: BugReportBridge = {
  capture: (userDescription: string) => ipcRenderer.invoke(BUG_REPORT_CAPTURE, userDescription),
  save: (userDescription: string, attachments?: BugReportAttachmentView[]) =>
    ipcRenderer.invoke(BUG_REPORT_SAVE, userDescription, attachments) as Promise<BugReportSaveResult>,
  close: () => ipcRenderer.send(BUG_REPORT_CLOSE),
  list: () => ipcRenderer.invoke(BUG_REPORT_LIST),
  read: (idOrPath: string) => ipcRenderer.invoke(BUG_REPORT_READ, idOrPath),
  update: (timestamp: string, updates: { status?: 'open' | 'resolved'; notes?: string }) =>
    ipcRenderer.invoke(BUG_REPORT_UPDATE, timestamp, updates),
  delete: (timestamp: string) => ipcRenderer.invoke(BUG_REPORT_DELETE, timestamp),
  attach: (input) =>
    ipcRenderer.invoke(BUG_REPORT_ATTACH, input) as Promise<BugReportAttachmentView>,
  downloadAttachment: (key: string) =>
    ipcRenderer.invoke(BUG_REPORT_DOWNLOAD_ATTACHMENT, key) as Promise<string>,
};

const updater: UpdaterBridge = {
  check: (opts = {}) => ipcRenderer.invoke(UPDATER_CHECK, opts) as Promise<{ inFlight: boolean; timedOut: boolean; manual: boolean }>,
  install: () => ipcRenderer.invoke(UPDATER_INSTALL) as Promise<{ attempted: boolean; targetVersion: string | null }>,
  getState: () => ipcRenderer.invoke(UPDATER_GET_STATE) as Promise<UpdaterState>,
  onStatus: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: UpdaterStatusPayload): void => listener(payload);
    ipcRenderer.on(UPDATER_STATUS_EVENT, handler);
    return (): void => {
      ipcRenderer.removeListener(UPDATER_STATUS_EVENT, handler);
    };
  },
};

const totp: TotpBridge = {
  hasSecret: () => ipcRenderer.invoke(TOTP_HAS_SECRET) as Promise<{ hasSecret: boolean }>,
  getMetadata: () =>
    ipcRenderer.invoke(TOTP_GET_METADATA) as Promise<{ metadata: TotpSecretMetadataView | null }>,
  saveSecret: (secret, extra) =>
    ipcRenderer.invoke(TOTP_SAVE_SECRET, { secret, ...(extra ?? {}) }) as Promise<TotpSaveResultView>,
  scanQrFromScreen: () => ipcRenderer.invoke(TOTP_SCAN_QR_SCREEN) as Promise<TotpQrScanResultView>,
  scanQrFromClipboard: () =>
    ipcRenderer.invoke(TOTP_SCAN_QR_CLIPBOARD) as Promise<TotpQrScanResultView>,
  getCurrentCode: () => ipcRenderer.invoke(TOTP_GET_CURRENT_CODE) as Promise<TotpCodeInfoView>,
  deleteSecret: () => ipcRenderer.invoke(TOTP_DELETE_SECRET) as Promise<{ ok: true }>,
  parseError: (err) => {
    if (err === null || typeof err !== 'object') return null;
    // Electron prefixes IPC error messages with "Error invoking
    // remote method '<channel>': Error: " before our JSON wire
    // payload. Skip to the first `{` to start parsing from our JSON.
    const message = (err as { message?: unknown }).message;
    if (typeof message !== 'string') return null;
    const jsonStart = message.indexOf('{');
    if (jsonStart < 0) return null;
    try {
      const parsed = JSON.parse(message.slice(jsonStart)) as { __totpError?: TotpErrorJSON };
      if (parsed.__totpError !== undefined) return parsed.__totpError;
    } catch {
      return null;
    }
    return null;
  },
};

const auth: AuthBridge = {
  signIn: (env, opts) =>
    ipcRenderer.invoke(AUTH_SIGN_IN, { env, ...(opts ?? {}) }) as Promise<{
      session: AuthSessionRendererView;
    }>,
  signOut: (env) => ipcRenderer.invoke(AUTH_SIGN_OUT, { env }) as Promise<{ ok: true }>,
  getSession: (env) =>
    ipcRenderer.invoke(AUTH_GET_SESSION, { env }) as Promise<{ session: AuthSessionRendererView | null }>,
  getTokenBundle: (env) =>
    ipcRenderer.invoke(AUTH_GET_TOKEN_BUNDLE, { env }) as Promise<{ bundle: AuthTokenBundleView | null }>,
  hasValidSession: (env) =>
    ipcRenderer.invoke(AUTH_HAS_VALID_SESSION, { env }) as Promise<{ valid: boolean }>,
  onSessionChanged: (listener) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      payload: { env: AuthEnvironment; session: AuthSessionRendererView | null }
    ): void => listener(payload);
    ipcRenderer.on(AUTH_SESSION_CHANGED, handler);
    return (): void => {
      ipcRenderer.removeListener(AUTH_SESSION_CHANGED, handler);
    };
  },
  on2FANeedsSetup: (listener) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      payload: AuthTwoFactorNeedsSetupPayload
    ): void => listener(payload);
    ipcRenderer.on(AUTH_TWO_FACTOR_NEEDS_SETUP, handler);
    return (): void => {
      ipcRenderer.removeListener(AUTH_TWO_FACTOR_NEEDS_SETUP, handler);
    };
  },
  parseError: (err) => {
    if (err === null || typeof err !== 'object') return null;
    // Electron rethrows IPC handler errors with `.message` PREFIXED by
    // "Error invoking remote method '<channel>': Error: " before our
    // JSON wire payload. Strip the prefix by jumping to the first `{`,
    // which is where our JSON starts.
    const message = (err as { message?: unknown }).message;
    if (typeof message !== 'string') return null;
    const jsonStart = message.indexOf('{');
    if (jsonStart < 0) return null;
    try {
      const parsed = JSON.parse(message.slice(jsonStart)) as { __authError?: AuthErrorJSON };
      if (parsed.__authError !== undefined) {
        return parsed.__authError;
      }
    } catch {
      return null;
    }
    return null;
  },
};

const settings: SettingsBridge = {
  open: (sectionId?: string) =>
    ipcRenderer.invoke(
      SETTINGS_OPEN,
      sectionId !== undefined ? { sectionId } : undefined
    ) as Promise<{ ok: true }>,
};

const apiDocs: ApiDocsBridge = {
  open: () => ipcRenderer.invoke(API_DOCS_OPEN) as Promise<{ ok: true }>,
};

const spaces: SpacesBridge = {
  open: () => ipcRenderer.invoke(SPACES_OPEN) as Promise<{ ok: true }>,
  listSpaces: () =>
    ipcRenderer.invoke(SPACES_LIST_SPACES) as Promise<SpacesIpcResultView<unknown[]>>,
  getUncategorizedCount: () =>
    ipcRenderer.invoke(SPACES_UNCATEGORIZED_COUNT) as Promise<SpacesIpcResultView<number>>,
  items: {
    list: (scopeId, opts) =>
      ipcRenderer.invoke(SPACES_ITEMS_LIST, {
        scopeId,
        ...(opts !== undefined ? { opts } : {}),
      }) as Promise<SpacesIpcResultView<unknown[]>>,
    get: (id) =>
      ipcRenderer.invoke(SPACES_ITEMS_GET, { id }) as Promise<
        SpacesIpcResultView<unknown | null>
      >,
  },
  runDiscovery: () =>
    ipcRenderer.invoke(SPACES_DISCOVERY_RUN) as Promise<
      SpacesIpcResultView<SpacesDiscoveryResultsView>
    >,
};

const health: HealthBridge = {
  snapshot: () => ipcRenderer.invoke(HEALTH_SNAPSHOT) as Promise<LiteAppHealthSnapshotView>,
};

const neon: NeonBridge = {
  query: (cypher, parameters) =>
    ipcRenderer.invoke(NEON_QUERY, { cypher, parameters }) as Promise<{ records: NeonRecord[] }>,
  status: () => ipcRenderer.invoke(NEON_STATUS) as Promise<NeonStatusView>,
  testConnection: () => ipcRenderer.invoke(NEON_TEST_CONNECTION) as Promise<NeonTestResult>,
  configure: (config) =>
    ipcRenderer.invoke(NEON_CONFIGURE, config) as Promise<{ ok: true; status: NeonStatusView }>,
  parseError: (err) => {
    if (err === null || typeof err !== 'object') return null;
    // Electron prefixes IPC error messages with "Error invoking
    // remote method '<channel>': Error: " before our JSON wire
    // payload. Skip to the first `{` to start parsing from our JSON.
    const message = (err as { message?: unknown }).message;
    if (typeof message !== 'string') return null;
    const jsonStart = message.indexOf('{');
    if (jsonStart < 0) return null;
    try {
      const parsed = JSON.parse(message.slice(jsonStart)) as { __neonError?: NeonErrorJSON };
      if (parsed.__neonError !== undefined) return parsed.__neonError;
    } catch {
      return null;
    }
    return null;
  },
};

const idw: IdwBridge = {
  list: () => ipcRenderer.invoke(IDW_LIST) as Promise<IdwEntryView[]>,
  listByKind: (kind) =>
    ipcRenderer.invoke(IDW_LIST_BY_KIND, { kind }) as Promise<IdwEntryView[]>,
  get: (id) => ipcRenderer.invoke(IDW_GET, { id }) as Promise<IdwEntryView | null>,
  add: (entry) => ipcRenderer.invoke(IDW_ADD, entry) as Promise<IdwAddResultView>,
  update: (id, patch) =>
    ipcRenderer.invoke(IDW_UPDATE, { id, patch }) as Promise<IdwEntryView>,
  remove: (id) => ipcRenderer.invoke(IDW_REMOVE, { id }) as Promise<{ ok: true }>,
  openStore: () => ipcRenderer.invoke(IDW_OPEN_STORE) as Promise<{ ok: true }>,
  onChange: (handler) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      payload: { entries: IdwEntryView[] }
    ): void => {
      try {
        handler(payload?.entries ?? []);
      } catch {
        // best-effort: never let a buggy handler crash IPC
      }
    };
    ipcRenderer.on(IDW_CHANGED, listener);
    return (): void => {
      ipcRenderer.removeListener(IDW_CHANGED, listener);
    };
  },
  parseError: (err) => {
    if (err === null || typeof err !== 'object') return null;
    const message = (err as { message?: unknown }).message;
    if (typeof message !== 'string') return null;
    const jsonStart = message.indexOf('{');
    if (jsonStart < 0) return null;
    try {
      const parsed = JSON.parse(message.slice(jsonStart)) as { __idwError?: IdwErrorJSON };
      if (parsed.__idwError !== undefined) return parsed.__idwError;
    } catch {
      return null;
    }
    return null;
  },
};

const tools: ToolsBridge = {
  list: () => ipcRenderer.invoke(TOOLS_LIST) as Promise<ToolEntryView[]>,
  get: (id) => ipcRenderer.invoke(TOOLS_GET, { id }) as Promise<ToolEntryView | null>,
  add: (entry) => ipcRenderer.invoke(TOOLS_ADD, entry) as Promise<ToolEntryView>,
  update: (id, patch) =>
    ipcRenderer.invoke(TOOLS_UPDATE, { id, patch }) as Promise<ToolEntryView>,
  remove: (id) => ipcRenderer.invoke(TOOLS_REMOVE, { id }) as Promise<{ ok: true }>,
  openManager: () => ipcRenderer.invoke(TOOLS_OPEN_MANAGER) as Promise<{ ok: true }>,
  onChange: (handler) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      payload: { entries: ToolEntryView[] }
    ): void => {
      try {
        handler(payload?.entries ?? []);
      } catch {
        // best-effort: never let a buggy handler crash IPC
      }
    };
    ipcRenderer.on(TOOLS_CHANGED, listener);
    return (): void => {
      ipcRenderer.removeListener(TOOLS_CHANGED, listener);
    };
  },
  parseError: (err) => {
    if (err === null || typeof err !== 'object') return null;
    const message = (err as { message?: unknown }).message;
    if (typeof message !== 'string') return null;
    const jsonStart = message.indexOf('{');
    if (jsonStart < 0) return null;
    try {
      const parsed = JSON.parse(message.slice(jsonStart)) as { __toolsError?: ToolsErrorJSON };
      if (parsed.__toolsError !== undefined) return parsed.__toolsError;
    } catch {
      return null;
    }
    return null;
  },
};

// ---------------------------------------------------------------------------
// Main window (tabbed agent browser) bridge -- mirrors lite/main-window/api.ts.
// Available only on the chrome (tab bar) webContents; agent tab views
// have NO preload, so they cannot reach this surface. ADR-038.
// ---------------------------------------------------------------------------

interface MainWindowTabView {
  id: string;
  label: string;
  url: string;
  idwId?: string;
  partition: string;
  iconName?: string;
  createdAt: string;
  updatedAt: string;
}

interface MainWindowOpenTabInputView {
  url: string;
  label: string;
  idwId?: string;
  iconName?: string;
}

interface MainWindowOpenTabResultView {
  tab: MainWindowTabView;
  wasFocus: boolean;
}

interface MainWindowErrorJSON {
  name: string;
  code: string;
  message: string;
  context: Record<string, unknown>;
  remediation: string;
  cause?: string;
}

interface MainWindowBridge {
  listTabs(): Promise<MainWindowTabView[]>;
  getActiveTabId(): Promise<{ activeId: string | null }>;
  openTab(input: MainWindowOpenTabInputView): Promise<MainWindowOpenTabResultView>;
  closeTab(id: string): Promise<{ ok: true }>;
  activateTab(id: string): Promise<{ ok: true }>;
  goHome(): Promise<{ ok: true }>;
  onTabsChanged(
    handler: (payload: { tabs: MainWindowTabView[]; activeId: string | null }) => void
  ): () => void;
  parseError(err: unknown): MainWindowErrorJSON | null;
}

const mainWindow: MainWindowBridge = {
  listTabs: () => ipcRenderer.invoke(MAIN_WINDOW_LIST_TABS) as Promise<MainWindowTabView[]>,
  getActiveTabId: () =>
    ipcRenderer.invoke(MAIN_WINDOW_GET_ACTIVE) as Promise<{ activeId: string | null }>,
  openTab: (input) =>
    ipcRenderer.invoke(MAIN_WINDOW_OPEN_TAB, input) as Promise<MainWindowOpenTabResultView>,
  closeTab: (id) =>
    ipcRenderer.invoke(MAIN_WINDOW_CLOSE_TAB, { id }) as Promise<{ ok: true }>,
  activateTab: (id) =>
    ipcRenderer.invoke(MAIN_WINDOW_ACTIVATE_TAB, { id }) as Promise<{ ok: true }>,
  goHome: () => ipcRenderer.invoke(MAIN_WINDOW_GO_HOME) as Promise<{ ok: true }>,
  onTabsChanged: (handler) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      payload: { tabs: MainWindowTabView[]; activeId: string | null }
    ): void => {
      try {
        handler({
          tabs: payload?.tabs ?? [],
          activeId: payload?.activeId ?? null,
        });
      } catch {
        // best-effort: never let a buggy handler crash IPC
      }
    };
    ipcRenderer.on(MAIN_WINDOW_CHANGED, listener);
    return (): void => {
      ipcRenderer.removeListener(MAIN_WINDOW_CHANGED, listener);
    };
  },
  parseError: (err) => {
    if (err === null || typeof err !== 'object') return null;
    const message = (err as { message?: unknown }).message;
    if (typeof message !== 'string') return null;
    const jsonStart = message.indexOf('{');
    if (jsonStart < 0) return null;
    try {
      const parsed = JSON.parse(message.slice(jsonStart)) as {
        __mainWindowError?: MainWindowErrorJSON;
      };
      if (parsed.__mainWindowError !== undefined) return parsed.__mainWindowError;
    } catch {
      return null;
    }
    return null;
  },
};

// ---------------------------------------------------------------------------
// Event bus bridge -- mirrors lite/event-bus/api.ts EventBusApi.
//
// Exposes the subscription surface to the renderer (`on` / `onPattern` /
// `recent` / `emit`) so any window can listen for domain events
// without needing to re-implement glob matching or replay logic.
// ADR-043.
// ---------------------------------------------------------------------------

interface EventBusDomainEventView {
  name: string;
  id: string;
  ts: string;
  data: unknown;
}

interface EventBusBridge {
  /** Subscribe to a single domain event by name. Returns unsubscribe. */
  on(
    name: string,
    handler: (event: EventBusDomainEventView) => void,
    opts?: { replay?: boolean }
  ): () => void;
  /** Subscribe via glob pattern. Returns unsubscribe. */
  onPattern(
    pattern: string,
    handler: (event: EventBusDomainEventView) => void,
    opts?: { replay?: boolean }
  ): () => void;
  /** Snapshot read of recent events. */
  recent(name?: string | null, limit?: number): Promise<EventBusDomainEventView[]>;
  /** Total events currently held in the ring buffer. */
  size(): Promise<{ size: number }>;
  /** Manually emit a domain event. */
  emit(payload: { name: string; data?: unknown }): Promise<EventBusDomainEventView>;
}

const eventBusListenersByPattern = new Map<
  string,
  Set<(event: EventBusDomainEventView) => void>
>();
let eventBusGlobalListenerAttached = false;

function ensureEventBusGlobalListener(): void {
  if (eventBusGlobalListenerAttached) return;
  eventBusGlobalListenerAttached = true;
  ipcRenderer.on(EVENT_BUS_EVENT, (_event, payload: EventBusDomainEventView) => {
    if (payload === null || typeof payload !== 'object' || typeof payload.name !== 'string') {
      return;
    }
    // Fan out to every registered pattern that matches.
    for (const [pattern, listeners] of eventBusListenersByPattern.entries()) {
      if (!matchesGlob(pattern, payload.name)) continue;
      // Snapshot listeners so an unsubscribe during dispatch doesn't
      // trip the iterator.
      for (const l of [...listeners]) {
        try {
          l(payload);
        } catch {
          // best-effort -- never let a buggy renderer subscriber bring down IPC
        }
      }
    }
  });
}

function matchesGlob(pattern: string, name: string): boolean {
  // Same anchor + escape rules as the main-process compileGlob in
  // lite/event-bus/store.ts. Kept inline here so the preload bundle
  // stays self-contained.
  const escaped = pattern
    .replace(/[-/\\^$+?.()|[\]{}]/g, '\\$&')
    .replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(name);
}

function eventBusReplay(
  pattern: string,
  handler: (event: EventBusDomainEventView) => void
): void {
  // Replay walks recent() via IPC. Fire-and-forget so register
  // remains synchronous from the caller's perspective; the handler
  // sees historical events as soon as the IPC roundtrip resolves.
  void ipcRenderer
    .invoke(EVENT_BUS_RECENT, { name: null, limit: 200 })
    .then((events: EventBusDomainEventView[]) => {
      for (const ev of events) {
        if (!matchesGlob(pattern, ev.name)) continue;
        try {
          handler(ev);
        } catch {
          // best-effort
        }
      }
    })
    .catch(() => {
      /* best-effort -- replay is informative, not load-bearing */
    });
}

function subscribeEventBus(
  pattern: string,
  handler: (event: EventBusDomainEventView) => void,
  opts: { replay?: boolean } = {}
): () => void {
  ensureEventBusGlobalListener();
  let set = eventBusListenersByPattern.get(pattern);
  if (set === undefined) {
    set = new Set();
    eventBusListenersByPattern.set(pattern, set);
  }
  set.add(handler);
  if (opts.replay === true) {
    eventBusReplay(pattern, handler);
  }
  return (): void => {
    const s = eventBusListenersByPattern.get(pattern);
    if (s === undefined) return;
    s.delete(handler);
    if (s.size === 0) eventBusListenersByPattern.delete(pattern);
  };
}

const events: EventBusBridge = {
  on: (name, handler, opts) => subscribeEventBus(name, handler, opts),
  onPattern: (pattern, handler, opts) => subscribeEventBus(pattern, handler, opts),
  recent: (name, limit) =>
    ipcRenderer.invoke(EVENT_BUS_RECENT, {
      name: name ?? null,
      limit: limit ?? 50,
    }) as Promise<EventBusDomainEventView[]>,
  size: () => ipcRenderer.invoke(EVENT_BUS_SIZE) as Promise<{ size: number }>,
  emit: (payload) =>
    ipcRenderer.invoke(EVENT_BUS_EMIT, payload) as Promise<EventBusDomainEventView>,
};

const university: UniversityBridge = {
  list: () => ipcRenderer.invoke(UNIVERSITY_LIST) as Promise<LearningEntryView[]>,
  listByKind: (kind) =>
    ipcRenderer.invoke(UNIVERSITY_LIST_BY_KIND, { kind }) as Promise<LearningEntryView[]>,
  get: (id) => ipcRenderer.invoke(UNIVERSITY_GET, { id }) as Promise<LearningEntryView | null>,
  open: (id) => ipcRenderer.invoke(UNIVERSITY_OPEN, { id }) as Promise<{ ok: true }>,
  openTutorials: () => ipcRenderer.invoke(UNIVERSITY_OPEN_TUTORIALS) as Promise<{ ok: true }>,
  parseError: (err) => {
    if (err === null || typeof err !== 'object') return null;
    const message = (err as { message?: unknown }).message;
    if (typeof message !== 'string') return null;
    const jsonStart = message.indexOf('{');
    if (jsonStart < 0) return null;
    try {
      const parsed = JSON.parse(message.slice(jsonStart)) as { __universityError?: UniversityErrorJSON };
      if (parsed.__universityError !== undefined) return parsed.__universityError;
    } catch {
      return null;
    }
    return null;
  },
};

function parseStructuredErrorWith<T>(err: unknown, key: string): T | null {
  if (err === null || typeof err !== 'object') return null;
  const message = (err as { message?: unknown }).message;
  if (typeof message !== 'string') return null;
  const jsonStart = message.indexOf('{');
  if (jsonStart < 0) return null;
  try {
    const parsed = JSON.parse(message.slice(jsonStart)) as Record<string, T>;
    if (parsed[key] !== undefined) return parsed[key] as T;
  } catch {
    return null;
  }
  return null;
}

// `ai` bridge removed alongside the lite/ai/ module (TTS pulled).

const aiRunTimes: AiRunTimesBridge = {
  listArticles: () => ipcRenderer.invoke(ART_LIST_ARTICLES) as Promise<ArtArticleView[]>,
  getArticle: (id) => ipcRenderer.invoke(ART_GET_ARTICLE, { id }) as Promise<ArtArticleView | null>,
  refreshFeed: () => ipcRenderer.invoke(ART_REFRESH_FEED) as Promise<ArtRefreshResultView>,
  fetchArticleBody: (id) =>
    ipcRenderer.invoke(ART_FETCH_ARTICLE_BODY, { id }) as Promise<ArtArticleView>,
  listPreferences: () =>
    ipcRenderer.invoke(ART_LIST_PREFERENCES) as Promise<ArtPreferenceView[]>,
  savePreferences: (enabledIds) =>
    ipcRenderer.invoke(ART_SAVE_PREFERENCES, { enabledIds }) as Promise<ArtPreferenceView[]>,
  listFeedSources: () =>
    ipcRenderer.invoke(ART_LIST_FEED_SOURCES) as Promise<ArtFeedSourceView[]>,
  addFeedSource: (input) =>
    ipcRenderer.invoke(ART_ADD_FEED_SOURCE, input) as Promise<ArtFeedSourceView>,
  removeFeedSource: (id) =>
    ipcRenderer.invoke(ART_REMOVE_FEED_SOURCE, { id }) as Promise<{ ok: true }>,
  toggleFeedSource: (id, enabled) =>
    ipcRenderer.invoke(ART_TOGGLE_FEED_SOURCE, { id, enabled }) as Promise<ArtFeedSourceView>,
  listReadingLog: () =>
    ipcRenderer.invoke(ART_LIST_READING_LOG) as Promise<ArtReadingLogEntryView[]>,
  recordRead: (entry) =>
    ipcRenderer.invoke(ART_RECORD_READ, entry) as Promise<ArtReadingLogEntryView>,
  clearReadingLog: () =>
    ipcRenderer.invoke(ART_CLEAR_READING_LOG) as Promise<{ ok: true }>,
  exportReadingLog: () => ipcRenderer.invoke(ART_EXPORT_READING_LOG) as Promise<string>,
  openWindow: () => ipcRenderer.invoke(ART_OPEN_WINDOW) as Promise<{ ok: true }>,
  // cachedTts removed alongside the AI module.
  parseError: (err) => parseStructuredErrorWith<ArtErrorJSON>(err, '__aiRunTimesError'),
};

const onboarding: OnboardingBridge = {
  load: () => ipcRenderer.invoke(ONBOARDING_LOAD) as Promise<OnboardingStateView>,
  markComplete: (stepId) =>
    ipcRenderer.invoke(ONBOARDING_MARK_COMPLETE, { stepId }) as Promise<OnboardingStateView>,
  dismiss: () => ipcRenderer.invoke(ONBOARDING_DISMISS) as Promise<OnboardingStateView>,
};

contextBridge.exposeInMainWorld('lite', {
  ...liteMetadata,
  auth,
  totp,
  settings,
  apiDocs,
  spaces,
  health,
  neon,
  idw,
  tools,
  mainWindow,
  events,
  university,
  aiRunTimes,
  onboarding,
});
contextBridge.exposeInMainWorld('logging', logging);
contextBridge.exposeInMainWorld('bugReport', bugReport);
contextBridge.exposeInMainWorld('updater', updater);
