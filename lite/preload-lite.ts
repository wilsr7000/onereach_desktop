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

const HEALTH_PULSE_EVENT = 'lite:health:pulse';
const HEALTH_PULSE_GET = 'lite:health:pulse-get';
const BUG_REPORT_OPEN = 'lite:bug-report:open';
const BUG_REPORT_CAPTURE = 'lite:bug-report:capture';
const BUG_REPORT_GET_PREFILL = 'lite:bug-report:get-prefill';
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
const AUTH_IDW_LOGIN_STUCK = 'lite:auth:idw-login-stuck';

const TOTP_HAS_SECRET = 'lite:totp:has-secret';
const TOTP_GET_METADATA = 'lite:totp:get-metadata';
const TOTP_SAVE_SECRET = 'lite:totp:save-secret';
const TOTP_SCAN_QR_SCREEN = 'lite:totp:scan-qr-screen';
const TOTP_SCAN_QR_CLIPBOARD = 'lite:totp:scan-qr-clipboard';
const TOTP_GET_CURRENT_CODE = 'lite:totp:get-current-code';
const TOTP_DELETE_SECRET = 'lite:totp:delete-secret';

const SETTINGS_OPEN = 'lite:settings:open';
// Memory-ingest channels (ADR-079) -- mirror lite/memory-ingest/ipc.ts.
const MEMORY_LIST_SERVERS = 'lite:memory:listServers';
const MEMORY_ADD_SERVER = 'lite:memory:addServer';
const MEMORY_REMOVE_SERVER = 'lite:memory:removeServer';
const MEMORY_TEST_SERVER = 'lite:memory:testServer';
const MEMORY_INGEST_SPACE = 'lite:memory:ingestSpace';
const MEMORY_INGEST_PROGRESS = 'lite:memory:ingestProgress';
const HOME_URL_GET = 'lite:main-window:homeUrl:get';
const HOME_URL_SET = 'lite:main-window:homeUrl:set';
// Appearance -- mirror lite/theme/main.ts THEME_IPC.
const THEME_GET = 'lite:theme:get';
const THEME_SET = 'lite:theme:set';
const API_DOCS_OPEN = 'lite:api-docs:open';
const HEALTH_SNAPSHOT = 'lite:health:snapshot';
const TELEMETRY_GET_STATUS = 'lite:telemetry:getStatus';
const TELEMETRY_SET_CONSENT = 'lite:telemetry:setConsent';

// Spaces (Phase 0): only OPEN is bridged for the renderer today. The
// data methods (LIST_SPACES, UNCATEGORIZED_COUNT, ITEMS_LIST, ITEMS_GET)
// are registered main-side now so the Phase 1 wiring is a pure
// renderer-bridge addition with no main-process churn. The renderer
// surface is bridged once Phase 1 lands real fetches.
const SPACES_OPEN = 'lite:spaces:open';
const SPACES_OPEN_WISER = 'lite:spaces:openWiser';
const SPACES_OPEN_JOURNEY_MAP = 'lite:spaces:openJourneyMap';
const SPACES_LIST_SPACES = 'lite:spaces:listSpaces';
const SPACES_REFRESH = 'lite:spaces:refresh';
const SPACES_ITEMS_READ_FILE_DATA = 'lite:spaces:items:readFileData';
const SPACES_ITEMS_READ_SPREADSHEET = 'lite:spaces:items:readSpreadsheet';
const SPACES_UNCATEGORIZED_COUNT = 'lite:spaces:uncategorizedCount';
const SPACES_LEARN_SIGNALS = 'lite:spaces:learn:signals';
const SPACES_PRESENCE_IN_SPACE = 'lite:spaces:presence:inSpace';
const SPACES_PRESENCE_SCOPE = 'lite:spaces:presence:scope';
const SPACES_LEARN_PROGRESS_GET = 'lite:spaces:learn:progressGet';
const SPACES_LEARN_PROGRESS_SAVE = 'lite:spaces:learn:progressSave';
const SPACES_ITEMS_LIST = 'lite:spaces:items:list';
const SPACES_ITEMS_GET = 'lite:spaces:items:get';
const SPACES_ITEMS_RESOLVE_FILE_URL = 'lite:spaces:items:resolveFileUrl';
const SPACES_ITEMS_UPDATE = 'lite:spaces:items:update';
const SPACES_ITEMS_ADD_TAG = 'lite:spaces:items:addTag';
const SPACES_ITEMS_REMOVE_TAG = 'lite:spaces:items:removeTag';
const SPACES_ITEMS_RECENT_COMMITS = 'lite:spaces:items:recentCommits';
const SPACES_JOURNEYS_DRAFT = 'lite:spaces:journeys:draft';
const SPACES_JOURNEYS_SUGGEST = 'lite:spaces:journeys:suggest';
const SPACES_JOURNEYS_CREATE = 'lite:spaces:journeys:create';
const SPACES_ITEMS_RECORD_VIEW = 'lite:spaces:items:recordView';
const SPACES_ITEMS_VIEWERS = 'lite:spaces:items:viewers';
const SPACES_SET_SPACE_KIND = 'lite:spaces:setKind';
const SPACES_PLAYBOOKS_CURRENT = 'lite:spaces:playbooks:current';
const SPACES_PLAYBOOKS_SET = 'lite:spaces:playbooks:set';
const SPACES_TICKETS_LIST = 'lite:spaces:tickets:list';
const SPACES_TICKETS_CREATE = 'lite:spaces:tickets:create';
const SPACES_TICKETS_UPDATE = 'lite:spaces:tickets:update';
const SPACES_IDENTITY_GET_OR_CREATE_PERSON = 'lite:spaces:identity:getOrCreatePerson';
const SPACES_IDENTITY_ATTR_EMAIL_GET = 'lite:spaces:identity:attributionEmail:get';
const SPACES_IDENTITY_ATTR_EMAIL_SET = 'lite:spaces:identity:attributionEmail:set';
const SPACES_AUTH_SIGN_IN = 'lite:spaces:auth:signIn';
const SPACES_MEMBERS_LIST = 'lite:spaces:members:list';
const SPACES_MEMBERS_ADD = 'lite:spaces:members:add';
const SPACES_MEMBERS_SEARCH_LIBRARY = 'lite:spaces:members:searchLibrary';
const SPACES_MEMBERS_REMOVE = 'lite:spaces:members:remove';
const SPACES_CHECKLISTS_CREATE = 'lite:spaces:checklists:create';
const SPACES_CHECKLISTS_UPDATE = 'lite:spaces:checklists:update';
const SPACES_CHECKLISTS_DRAFT = 'lite:spaces:checklists:draft';
const SPACES_CHECKLISTS_REMOVE = 'lite:spaces:checklists:remove';
const SPACES_CHECKLISTS_LIST = 'lite:spaces:checklists:list';
const SPACES_CHECKLISTS_ATTACH = 'lite:spaces:checklists:attach';
const SPACES_CHECKLISTS_FOR_TICKET = 'lite:spaces:checklists:forTicket';
const SPACES_CHECKLISTS_SET_ITEM = 'lite:spaces:checklists:setItem';
const SPACES_CHECKLISTS_DETACH = 'lite:spaces:checklists:detach';

const SPACES_ITEMS_GET_FILE_EXPIRY = 'lite:spaces:items:getFileExpiry';
const SPACES_ITEMS_CREATE = 'lite:spaces:items:create';
const SPACES_ITEMS_CREATE_BINARY = 'lite:spaces:items:createBinary';
const SPACES_ITEMS_CREATE_AGENT = 'lite:spaces:items:createAgent';
const SPACES_ITEMS_AGENT_LIBRARY_SEARCH = 'lite:spaces:items:agentLibrarySearch';
const SPACES_ITEMS_CREATE_AGENT_FROM_LIBRARY = 'lite:spaces:items:createAgentFromLibrary';
const SPACES_ITEMS_DELETE = 'lite:spaces:items:delete';
const SPACES_ITEMS_RESTORE = 'lite:spaces:items:restore';
const SPACES_ITEMS_MOVE_TO_SPACE = 'lite:spaces:items:moveToSpace';
const SPACES_ITEMS_ADD_TO_SPACE = 'lite:spaces:items:addToSpace';
const SPACES_ITEMS_REMOVE_FROM_SPACE = 'lite:spaces:items:removeFromSpace';
const SPACES_ITEMS_SEARCH = 'lite:spaces:items:search';
const SPACES_ITEMS_SEARCH_AGENTIC = 'lite:spaces:items:search-agentic';
const SPACES_ITEMS_SEARCH_AGENTIC_PROGRESS = 'lite:spaces:items:search-agentic-progress';
const SPACES_ITEMS_VERSIONS = 'lite:spaces:items:versions';
const SPACES_ITEMS_VERSION_GET = 'lite:spaces:items:versionGet';
const SPACES_ITEMS_VERSION_RESTORE = 'lite:spaces:items:versionRestore';
const SPACES_ITEMS_SET_METADATA = 'lite:spaces:items:setMetadata';
const SPACES_ITEMS_PATCH_METADATA = 'lite:spaces:items:patchMetadata';
const SPACES_ITEMS_REMOVE_METADATA_KEY = 'lite:spaces:items:removeMetadataKey';
const SPACES_DISCOVERY_RUN = 'lite:spaces:discovery:run';
// Home view (chunk 3k + 3o). See lite/spaces/HOME-V1.md.
const SPACES_HOME_ENTITY_COUNTS = 'lite:spaces:home:entityCounts';
const SPACES_HOME_RECENT_ITEMS = 'lite:spaces:home:recentItems';
const SPACES_HOME_TOP_CONTRIBUTORS = 'lite:spaces:home:topContributors';
const SPACES_HOME_RECENT_EVENTS = 'lite:spaces:home:recentEvents';
const SPACES_HOME_AGENTS_SAMPLE = 'lite:spaces:home:agentsSample';
const SPACES_HOME_PERMISSION_SUMMARY = 'lite:spaces:home:permissionSummary';
// Mutations (Phase 3a). ADR-048.
const SPACES_CREATE_SPACE = 'lite:spaces:create';
const SPACES_RENAME_SPACE = 'lite:spaces:rename';
const SPACES_UPDATE_SPACE = 'lite:spaces:update';
const SPACES_PIN_SPACE = 'lite:spaces:pin';
const SPACES_DELETE_SPACE = 'lite:spaces:delete';
const SPACES_UNDELETE_SPACE = 'lite:spaces:undelete';
// Cache refresh broadcast: fires when an entry in the main-process
// Spaces cache refreshes (from background timer, on-demand
// revalidation, or post-mutation invalidation). Renderer subscribes
// via window.lite.spaces.onCacheUpdate(handler) and triggers a local
// re-fetch; the next bridge call returns the already-refreshed value.
const SPACES_CACHE_UPDATED = 'lite:spaces:cache-updated';

const NEON_QUERY_NAMED = 'lite:neon:query-named';
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
const MAIN_WINDOW_RELOAD_ACTIVE = 'lite:main-window:reload-active';
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
const IDW_OPEN = 'lite:idw:open';
const IDW_MEMORY_EXPORT = 'lite:idw:memory-export';
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

// AI module IPC channels (Claude metadata extraction + key management).
// The Anthropic API key is write-only across this bridge: the renderer
// can save / check / clear it but never read the value back.
const AI_STATUS = 'lite:ai:status';
const AI_SPACE_ASSIST = 'lite:ai:space-assist';
const AI_ENRICH_ASSET = 'lite:ai:enrich-asset';
const AI_CONVERT_OKF = 'lite:ai:convert-okf';
const AI_SUGGEST_SPACES = 'lite:ai:suggest-spaces';
const AI_KEY_SAVE = 'lite:ai:key-save';
const AI_KEY_HAS = 'lite:ai:key-has';
const AI_KEY_DELETE = 'lite:ai:key-delete';
const AI_KEY_TEST = 'lite:ai:key-test';

// Boot-chat → host IPC channel. Fired when the chat (now inline inside
// chrome.html's home view) reaches its settled resting state — either
// after a verified session or a successful in-chat sign-in. Main-lite
// listens once to un-suspend the re-sign-in prompter so background
// dialogs can fire again. There is no longer a separate boot-chat
// HTML to swap from; the channel name is kept for backward IPC compat.
const BOOT_CHAT_FINISH = 'lite:boot-chat:finish';

// Download → Save to Space picker IPC channels. Consumed only by the
// picker window's renderer (lite/downloads/picker.ts). The main process
// stashes the bootstrap payload under the per-download id at open
// time; the renderer reads it back here, then resolves with either
// `{spaceId, spaceName}` or null on cancel.
const DOWNLOAD_PICKER_BOOTSTRAP = 'lite:download-picker:bootstrap';
const DOWNLOAD_PICKER_RESOLVE = 'lite:download-picker:resolve';

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
  /** ADR-078: mutation landed on a spooled (not-yet-synced) report. */
  spooled: boolean;
}

interface BugReportDeleteResult {
  kvDeleted: boolean;
  kvError: string | null;
  /** ADR-078: deletion removed a spooled (not-yet-synced) report. */
  spooled: boolean;
}

interface BugReportSaveResult {
  kvWritten: boolean;
  kvError: string | null;
  /** ADR-078: report saved to the local spool, awaiting sync to KV. */
  spooled: boolean;
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
  /** ADR-068 — GSX identity forwarded from the session for Person logging. */
  gsxMultiUserId?: string;
  gsxUserId?: string;
  gsxEmail?: string;
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
   * Subscribe to "an IDW tab's auto-login gave up" broadcasts. The
   * chrome uses this to flag the stuck tab's pill with a ⚠ + the
   * instruction as its tooltip. Returns an unsubscribe fn.
   */
  onIdwLoginStuck(listener: (payload: AuthIdwLoginStuckPayload) => void): () => void;
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

/**
 * Payload of the `lite:auth:idw-login-stuck` broadcast.
 */
interface AuthIdwLoginStuckPayload {
  tabId: string;
  label: string;
  env?: string;
  likelyCause: string;
  instruction: string;
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
  resolveFileUrl(key: string): Promise<SpacesIpcResultView<string | null>>;
  /** The bucket's authoritative scheduled deletion for this key. */
  getFileExpiry(
    key: string
  ): Promise<SpacesIpcResultView<{ expiresAt: string | null; source: 'bucket' } | null>>;
  /** Read stored bytes as a data: URL for inline preview (null on failure). */
  readFileData(key: string): Promise<SpacesIpcResultView<{ dataUrl: string } | null>>;
  /** .xlsx → capped preview table parsed in main; null = no preview (2026-08-20). */
  readSpreadsheet(key: string): Promise<SpacesIpcResultView<unknown>>;
  createBinary(input: {
    spaceId: string;
    title: string;
    kind?: string;
    fileName: string;
    mimeType?: string;
    bytes: ArrayBuffer;
    description?: string;
    creatorId?: string;
    creatorName?: string;
    metadata?: Record<string, unknown>;
    /** Public bucket. Omit or false (the default) keeps the file private. */
    isPublic?: boolean;
    /** ISO-8601 auto-delete time. Omit for no expiry (the default). */
    expiresAt?: string;
  }): Promise<SpacesIpcResultView<unknown>>;
  update(
    id: string,
    patch: {
      title?: string;
      description?: string;
      type?: string;
      editorId?: string;
    }
  ): Promise<SpacesIpcResultView<unknown>>;
  addTag(id: string, tag: string): Promise<SpacesIpcResultView<string[]>>;
  removeTag(id: string, tag: string): Promise<SpacesIpcResultView<string[]>>;
  recentCommits(
    id: string,
    opts?: { limit?: number; since?: number }
  ): Promise<SpacesIpcResultView<unknown[]>>;
  /** Audit trail — record that the viewer opened this asset. */
  recordView(id: string): Promise<SpacesIpcResultView<{ ok: true }>>;
  /** Audit trail — who has viewed this asset (most recent first). */
  viewers(id: string): Promise<SpacesIpcResultView<unknown[]>>;
  create(input: {
    spaceId: string;
    title: string;
    kind?: string;
    content?: string;
    fileKey?: string;
    mimeType?: string;
    size?: number;
    description?: string;
    sourceUrl?: string;
    creatorId?: string;
    creatorName?: string;
  }): Promise<SpacesIpcResultView<unknown>>;
  /** Add an agent asset (OKF text stored as content; per-type graph node). */
  createAgent(input: {
    spaceId: string;
    name: string;
    okf: string;
    agentType: string;
    /** Reachability endpoints (MCP/API/Skill) + the channels each serves. */
    endpoints?: Array<{ kind: 'mcp' | 'api' | 'skill'; url: string; channels: string[] }>;
    sourceUrl?: string;
    description?: string;
    creatorId?: string;
    creatorName?: string;
  }): Promise<SpacesIpcResultView<unknown>>;
  /** Search the account's agent library (graph :Agent nodes). */
  agentLibrarySearch(
    q: string,
    limit?: number
  ): Promise<SpacesIpcResultView<Array<{ id: string; name: string; description: string; agentType: string }>>>;
  /** Add a LIBRARY agent to the Space (references the existing :Agent). */
  createAgentFromLibrary(input: {
    spaceId: string;
    agentId: string;
    endpoints?: Array<{ kind: 'mcp' | 'api' | 'skill'; url: string; channels: string[] }>;
    creatorId?: string;
    creatorName?: string;
  }): Promise<SpacesIpcResultView<unknown>>;
  delete(
    id: string,
    opts?: { soft?: boolean }
  ): Promise<SpacesIpcResultView<{ ok: true }>>;
  restore(id: string): Promise<SpacesIpcResultView<unknown>>;
  moveToSpace(
    id: string,
    fromSpaceId: string | null,
    toSpaceId: string
  ): Promise<SpacesIpcResultView<unknown>>;
  addToSpace(id: string, toSpaceId: string): Promise<SpacesIpcResultView<unknown>>;
  removeFromSpace(
    id: string,
    spaceId: string
  ): Promise<SpacesIpcResultView<unknown>>;
  searchAgentic(payload: {
    query: string;
    spaceId?: string;
  }): Promise<SpacesIpcResultView<unknown>>;
  onSearchAgenticProgress(listener: (p: unknown) => void): () => void;
  search(opts: {
    query: string;
    spaceId?: string;
    limit?: number;
  }): Promise<SpacesIpcResultView<unknown[]>>;
  /** Asset versioning (ADR-057). */
  versions(id: string, limit?: number): Promise<SpacesIpcResultView<unknown[]>>;
  getVersion(id: string, seq: number): Promise<SpacesIpcResultView<unknown>>;
  restoreVersion(
    id: string,
    seq: number,
    editorId?: string
  ): Promise<SpacesIpcResultView<unknown>>;
  setMetadata(
    id: string,
    metadata: Record<string, unknown>
  ): Promise<SpacesIpcResultView<unknown>>;
  patchMetadata(
    id: string,
    patch: Record<string, unknown>
  ): Promise<SpacesIpcResultView<unknown>>;
  removeMetadataKey(id: string, key: string): Promise<SpacesIpcResultView<unknown>>;
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

// ─── Home view (chunk 3k + 3o) ───────────────────────────────────────────
//
// Local bridge-level views mirroring the Home types in
// `lite/spaces/types.ts`. Renderer-facing aliases live in
// `lite/lite-window.d.ts`. Detail in `lite/spaces/HOME-V1.md`.

interface SpacesEntityCountsView {
  spaces: number;
  assets: number;
  people: number;
  agents: number;
}

interface SpacesContributorView {
  author: string;
  displayName: string;
  events: number;
  lastEventAt: string;
}

interface SpacesEventView {
  id: string;
  author: string;
  kind: string;
  timestamp: string;
  spaceId?: string;
  spaceName?: string;
}

interface SpacesAgentSummaryView {
  id: string;
  name: string;
  description: string;
}

interface SpacesPermissionSummaryView {
  visibleSpaceCount: number;
  totalSpaceCount?: number;
}

type SpacesContributorWindow = 'day' | 'week' | 'month';

interface SpacesHomeBridge {
  entityCounts(): Promise<SpacesIpcResultView<SpacesEntityCountsView>>;
  recentItems(opts?: {
    limit?: number;
  }): Promise<SpacesIpcResultView<unknown[]>>;
  topContributors(opts?: {
    window?: SpacesContributorWindow;
    limit?: number;
  }): Promise<SpacesIpcResultView<SpacesContributorView[]>>;
  recentEvents(opts?: {
    limit?: number;
    since?: number;
    spaceId?: string;
  }): Promise<SpacesIpcResultView<SpacesEventView[]>>;
  agentsSample(opts?: {
    limit?: number;
  }): Promise<SpacesIpcResultView<SpacesAgentSummaryView[]>>;
  permissionSummary(): Promise<SpacesIpcResultView<SpacesPermissionSummaryView>>;
}

// ─── Mutation inputs (Phase 3a) ─────────────────────────────────────────

interface SpacesCreateSpaceInputView {
  name: string;
  description?: string;
  color?: string;
  iconKey?: string;
}

interface SpacesDeleteSpaceOptsView {
  /** Default true (soft delete). Set to false to hard-remove. */
  soft?: boolean;
}

interface SpacesUpdateSpaceInputView {
  description?: string;
  color?: string;
  iconKey?: string;
}

interface SpacesTicketsBridge {
  list(
    spaceId: string,
    opts?: { status?: string; limit?: number; offset?: number }
  ): Promise<SpacesIpcResultView<unknown[]>>;
  create(
    spaceId: string,
    input: {
      title: string;
      description?: string;
      status?: string;
      priority?: string;
      playbookId?: string;
      assigneeId?: string;
    }
  ): Promise<SpacesIpcResultView<unknown>>;
  update(
    id: string,
    patch: {
      title?: string;
      description?: string;
      status?: string;
      priority?: string;
      assigneeId?: string | null;
    }
  ): Promise<SpacesIpcResultView<unknown>>;
}

interface SpacesPlaybooksBridge {
  current(spaceId: string): Promise<SpacesIpcResultView<unknown | null>>;
  set(
    spaceId: string,
    playbookId: string
  ): Promise<SpacesIpcResultView<{ playbook: unknown; ticketCount: number }>>;
}

interface SpacesIdentityBridge {
  attributionEmailGet(): Promise<SpacesIpcResultView<string | null>>;
  attributionEmailSet(email: string | null): Promise<SpacesIpcResultView<string | null>>;
  getOrCreatePerson(input: {
    id: string;
    name?: string;
    email?: string;
  }): Promise<SpacesIpcResultView<{ id: string; name: string; email?: string }>>;
  /** Identity gate — main runs the interactive GSX sign-in; resolves
   * once the session lands (or fails). Renderer never sees tokens. */
  requestSignIn(): Promise<
    SpacesIpcResultView<{ email: string | null; accountId: string | null }>
  >;
}

/** A member row. `accessExpiresAt` absent means permanent access. */
interface SpacesMemberView {
  kind: string;
  id: string;
  name: string;
  /** ADR-052 — ISO instant the grant lapses. Absent = permanent. */
  accessExpiresAt?: string;
}

interface SpacesChecklistsBridge {
  draft(prompt: string): Promise<SpacesIpcResultView<unknown>>;
  update(input: unknown): Promise<SpacesIpcResultView<{ id: string; version: number }>>;
  remove(id: string): Promise<SpacesIpcResultView<{ ok: true }>>;
  create(input: {
    spaceId: string;
    name: string;
    mode: 'DO-CONFIRM' | 'READ-DO';
    pausePoint: string;
    items: Array<{ text: string; killer?: boolean }>;
  }): Promise<SpacesIpcResultView<unknown>>;
  list(spaceId: string): Promise<SpacesIpcResultView<unknown[]>>;
  attach(input: {
    ticketId: string;
    checklistId: string;
    phase: 'preflight' | 'postflight';
    obligation: 'required' | 'recommended' | 'optional';
  }): Promise<SpacesIpcResultView<{ ok: true }>>;
  forTicket(ticketId: string): Promise<SpacesIpcResultView<unknown[]>>;
  setItem(input: {
    ticketId: string;
    checklistId: string;
    phase: 'preflight' | 'postflight';
    itemIndex: number;
    checked: boolean;
  }): Promise<SpacesIpcResultView<{ checkedIndexes: number[]; complete: boolean }>>;
  detach(
    ticketId: string,
    checklistId: string,
    phase: 'preflight' | 'postflight'
  ): Promise<SpacesIpcResultView<{ ok: true }>>;
}

interface SpacesMembersBridge {
  list(spaceId: string): Promise<SpacesIpcResultView<SpacesMemberView[]>>;
  add(
    spaceId: string,
    memberId: string,
    /**
     * Omit to leave an existing grant's expiry alone; `null` for
     * permanent; an ISO instant to time-limit it.
     */
    opts?: { expiresAt?: string | null; role?: 'reader' | 'writer' }
  ): Promise<SpacesIpcResultView<SpacesMemberView>>;
  /** Search the account's people + agents for the add-member picker. */
  searchLibrary(
    q: string,
    limit?: number
  ): Promise<SpacesIpcResultView<Array<{ kind: 'Person' | 'Agent'; id: string; name: string; email: string }>>>;
  remove(spaceId: string, memberId: string): Promise<SpacesIpcResultView<{ ok: true }>>;
}

/** Payload of the cache-updated event broadcast by the main process. */
interface SpacesCacheUpdateView {
  changed?: boolean;
  /** Cache key whose value just refreshed (e.g. 'spaces.listSpaces'). */
  key: string;
  /** Epoch ms when the refresh landed. */
  at: number;
}

interface SpacesBridge {
  /** ADR-072 — journey maps (Planning). */
  journeys: {
    /** Menu → composer trigger (ADR-072). Returns unsubscribe. */
    onNewJourney(cb: () => void): () => void;
    draft(prompt: string): Promise<SpacesIpcResultView<unknown>>;
    suggest(spaceId: string): Promise<SpacesIpcResultView<unknown>>;
    create(spaceId: string, draft: unknown): Promise<SpacesIpcResultView<unknown>>;
  };
  /** Open (or focus) the Spaces window. */
  open(): Promise<{ ok: true }>;
  /**
   * Open (or focus) the WISER Playbooks window; with a riffId, deep-link
   * straight to that playbook (the hosted app consumes ?riff= on load).
   */
  openWiser(riffId: string | null): Promise<{ ok: true }>;
  /**
   * Open (or focus) the Journey Map Builder; with an itemId, target
   * that journey asset (the Builder reads it back over its own bridge).
   */
  openJourneyMap(itemId: string | null): Promise<{ ok: true }>;
  listSpaces(): Promise<SpacesIpcResultView<unknown[]>>;
  /**
   * Drop cached reads and refetch, so Spaces created OUTSIDE this app
   * (e.g. in WISER Playbooks) appear on demand.
   */
  refresh(): Promise<SpacesIpcResultView<{ ok: true }>>;
  getUncategorizedCount(): Promise<SpacesIpcResultView<number>>;
  presence: {
    inSpace(spaceId: string): Promise<SpacesIpcResultView<LiteSpacePresenceEntryView[]>>;
    scope(spaceId: string | null, spaceName: string | null): Promise<SpacesIpcResultView<{ ok: true }>>;
  };
  learn: {
    signals(): Promise<SpacesIpcResultView<LiteLearnSignalsView>>;
    progressGet(): Promise<SpacesIpcResultView<LiteLearnProgressView>>;
    progressSave(
      progress: LiteLearnProgressView
    ): Promise<SpacesIpcResultView<LiteLearnProgressView>>;
  };
  items: SpacesItemsBridge;
  /**
   * Phase 0.5 discovery -- run Q1-Q4 verification queries against the
   * configured Neon endpoint. Never throws; per-query failures land in
   * the envelope's `results[i].error`.
   */
  runDiscovery(): Promise<SpacesIpcResultView<SpacesDiscoveryResultsView>>;
  /** Home view (chunk 3k + 3o). See lite/spaces/HOME-V1.md. */
  home: SpacesHomeBridge;
  /** Mutations (Phase 3a). ADR-048. Mirror `SpacesApi` write methods. */
  createSpace(input: SpacesCreateSpaceInputView): Promise<SpacesIpcResultView<unknown>>;
  renameSpace(id: string, name: string): Promise<SpacesIpcResultView<unknown>>;
  updateSpace(
    id: string,
    patch: SpacesUpdateSpaceInputView
  ): Promise<SpacesIpcResultView<unknown>>;
  deleteSpace(
    id: string,
    opts?: SpacesDeleteSpaceOptsView
  ): Promise<SpacesIpcResultView<{ ok: true }>>;
  undeleteSpace(id: string): Promise<SpacesIpcResultView<unknown>>;
  /** ADR-069 — toggle the viewer's pin mark on a Space. */
  pinSpace(id: string, pinned: boolean): Promise<SpacesIpcResultView<{ ok: true }>>;
  /** Phase 4 — shared spaces (playbooks + tickets). */
  setSpaceKind(
    id: string,
    kind: 'user' | 'shared'
  ): Promise<SpacesIpcResultView<'user' | 'shared'>>;
  playbooks: SpacesPlaybooksBridge;
  tickets: SpacesTicketsBridge;
  /** Phase 4 v2 — identity + sharing. */
  identity: SpacesIdentityBridge;
  members: SpacesMembersBridge;
  checklists: SpacesChecklistsBridge;
  /**
   * Subscribe to cache-refresh events from the main process. Fires
   * whenever a cached read (listSpaces, home view queries,
   * items.list, items.get) refreshes -- pre-warm at launch,
   * background timer, or post-mutation invalidation. Returns an
   * unsubscribe function. The renderer uses this to trigger local
   * re-fetches; the bridge call then returns the already-refreshed
   * cached value, so the re-paint is free.
   */
  onCacheUpdate(handler: (update: SpacesCacheUpdateView) => void): () => void;
}

/** Renderer view of telemetry status (ADR-052-adjacent; no secrets). */
interface LiteTelemetryStatusView {
  installId: string;
  consent: {
    state: 'unset' | 'granted' | 'denied';
    decidedAt?: string;
    decidedInVersion?: string;
  };
  /** UTC day currently accumulating. */
  day: string;
  /** The per-install Space id once ensured, else null. */
  spaceId: string | null;
}

interface TelemetryBridge {
  getStatus(): Promise<LiteTelemetryStatusView>;
  /** Only 'granted' | 'denied' are accepted; anything else is a no-op. */
  setConsent(state: 'granted' | 'denied'): Promise<LiteTelemetryStatusView>;
}

interface HealthBridge {
  /** Service pulse (2026-08-17) — the calm-outage-banner signal. */
  getPulse(): Promise<unknown>;
  onPulse(cb: (pulse: unknown) => void): () => void;
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
  /** N4: fixed queries only, invoked by registered name — see d.ts. */
  queryNamed(
    name: string,
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
  /** Open an agent entry as a main-window tab (2026-08-07). */
  open(id: string): Promise<{ ok: true }>;
  /** Export a provider's memory page into its Space (2026-09-01). */
  exportMemory(id: string): Promise<{ ok: boolean; provider: string; itemId?: string; chars?: number; reason?: string }>;
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
  open(prefill?: string): Promise<{ ok: true }>;
  capture(userDescription: string): Promise<{
    payload: unknown;
    payloadJson: string;
    redactionStatus: 'none' | 'low' | 'medium' | 'high';
    redactionTotalCount: number;
  }>;
  /** One-shot pre-filled description (updater install trail). */
  getPrefill(): Promise<{ prefill: string | null }>;
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
  /** Open the modal from any lite renderer (outage banner's Report). */
  open: (prefill?: string) => ipcRenderer.invoke(BUG_REPORT_OPEN, prefill),
  capture: (userDescription: string) => ipcRenderer.invoke(BUG_REPORT_CAPTURE, userDescription),
  getPrefill: () =>
    ipcRenderer.invoke(BUG_REPORT_GET_PREFILL) as Promise<{ prefill: string | null }>,
  save: (
    userDescription: string,
    attachments?: BugReportAttachmentView[],
    feedbackType?: 'bug' | 'feature'
  ) =>
    ipcRenderer.invoke(
      BUG_REPORT_SAVE,
      userDescription,
      attachments,
      feedbackType
    ) as Promise<BugReportSaveResult>,
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
  onIdwLoginStuck: (listener) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      payload: AuthIdwLoginStuckPayload
    ): void => listener(payload);
    ipcRenderer.on(AUTH_IDW_LOGIN_STUCK, handler);
    return (): void => {
      ipcRenderer.removeListener(AUTH_IDW_LOGIN_STUCK, handler);
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
  openWiser: (riffId: string | null) =>
    ipcRenderer.invoke(SPACES_OPEN_WISER, { riffId }) as Promise<{ ok: true }>,
  openJourneyMap: (itemId: string | null) =>
    ipcRenderer.invoke(SPACES_OPEN_JOURNEY_MAP, { itemId }) as Promise<{ ok: true }>,
  listSpaces: () =>
    ipcRenderer.invoke(SPACES_LIST_SPACES) as Promise<SpacesIpcResultView<unknown[]>>,
  refresh: () =>
    ipcRenderer.invoke(SPACES_REFRESH) as Promise<SpacesIpcResultView<{ ok: true }>>,
  getUncategorizedCount: () =>
    ipcRenderer.invoke(SPACES_UNCATEGORIZED_COUNT) as Promise<SpacesIpcResultView<number>>,
  presence: {
    inSpace: (spaceId: string) =>
      ipcRenderer.invoke(SPACES_PRESENCE_IN_SPACE, { spaceId }) as Promise<
        SpacesIpcResultView<LiteSpacePresenceEntryView[]>
      >,
    scope: (spaceId: string | null, spaceName: string | null) =>
      ipcRenderer.invoke(SPACES_PRESENCE_SCOPE, { spaceId, spaceName }) as Promise<
        SpacesIpcResultView<{ ok: true }>
      >,
  },
  learn: {
    signals: () =>
      ipcRenderer.invoke(SPACES_LEARN_SIGNALS) as Promise<
        SpacesIpcResultView<LiteLearnSignalsView>
      >,
    progressGet: () =>
      ipcRenderer.invoke(SPACES_LEARN_PROGRESS_GET) as Promise<
        SpacesIpcResultView<LiteLearnProgressView>
      >,
    progressSave: (progress: LiteLearnProgressView) =>
      ipcRenderer.invoke(SPACES_LEARN_PROGRESS_SAVE, progress) as Promise<
        SpacesIpcResultView<LiteLearnProgressView>
      >,
  },
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
    resolveFileUrl: (key) =>
      ipcRenderer.invoke(SPACES_ITEMS_RESOLVE_FILE_URL, { key }) as Promise<
        SpacesIpcResultView<string | null>
      >,
    getFileExpiry: (key) =>
      ipcRenderer.invoke(SPACES_ITEMS_GET_FILE_EXPIRY, { key }) as Promise<
        SpacesIpcResultView<{ expiresAt: string | null; source: 'bucket' } | null>
      >,
    readFileData: (key) =>
      ipcRenderer.invoke(SPACES_ITEMS_READ_FILE_DATA, { key }) as Promise<
        SpacesIpcResultView<{ dataUrl: string } | null>
      >,
    readSpreadsheet: (key) =>
      ipcRenderer.invoke(SPACES_ITEMS_READ_SPREADSHEET, { key }) as Promise<
        SpacesIpcResultView<unknown>
      >,
    update: (id, patch) =>
      ipcRenderer.invoke(SPACES_ITEMS_UPDATE, { id, patch }) as Promise<
        SpacesIpcResultView<unknown>
      >,
    addTag: (id, tag) =>
      ipcRenderer.invoke(SPACES_ITEMS_ADD_TAG, { id, tag }) as Promise<
        SpacesIpcResultView<string[]>
      >,
    removeTag: (id, tag) =>
      ipcRenderer.invoke(SPACES_ITEMS_REMOVE_TAG, { id, tag }) as Promise<
        SpacesIpcResultView<string[]>
      >,
    recentCommits: (id, opts) =>
      ipcRenderer.invoke(SPACES_ITEMS_RECENT_COMMITS, {
        id,
        ...(opts?.limit !== undefined ? { limit: opts.limit } : {}),
        ...(opts?.since !== undefined ? { since: opts.since } : {}),
      }) as Promise<SpacesIpcResultView<unknown[]>>,
    recordView: (id) =>
      ipcRenderer.invoke(SPACES_ITEMS_RECORD_VIEW, { id }) as Promise<
        SpacesIpcResultView<{ ok: true }>
      >,
    viewers: (id) =>
      ipcRenderer.invoke(SPACES_ITEMS_VIEWERS, { id }) as Promise<
        SpacesIpcResultView<unknown[]>
      >,
    create: (input) =>
      ipcRenderer.invoke(SPACES_ITEMS_CREATE, { input }) as Promise<
        SpacesIpcResultView<unknown>
      >,
    createBinary: (input) =>
      ipcRenderer.invoke(SPACES_ITEMS_CREATE_BINARY, { input }) as Promise<
        SpacesIpcResultView<unknown>
      >,
    createAgent: (input) =>
      ipcRenderer.invoke(SPACES_ITEMS_CREATE_AGENT, { input }) as Promise<
        SpacesIpcResultView<unknown>
      >,
    agentLibrarySearch: (q, limit) =>
      ipcRenderer.invoke(SPACES_ITEMS_AGENT_LIBRARY_SEARCH, {
        q,
        ...(limit !== undefined ? { limit } : {}),
      }) as Promise<
        SpacesIpcResultView<
          Array<{ id: string; name: string; description: string; agentType: string }>
        >
      >,
    createAgentFromLibrary: (input) =>
      ipcRenderer.invoke(SPACES_ITEMS_CREATE_AGENT_FROM_LIBRARY, { input }) as Promise<
        SpacesIpcResultView<unknown>
      >,
    delete: (id, opts) =>
      ipcRenderer.invoke(SPACES_ITEMS_DELETE, {
        id,
        ...(opts !== undefined ? { opts } : {}),
      }) as Promise<SpacesIpcResultView<{ ok: true }>>,
    restore: (id) =>
      ipcRenderer.invoke(SPACES_ITEMS_RESTORE, { id }) as Promise<
        SpacesIpcResultView<unknown>
      >,
    moveToSpace: (id, fromSpaceId, toSpaceId) =>
      ipcRenderer.invoke(SPACES_ITEMS_MOVE_TO_SPACE, {
        id,
        ...(fromSpaceId !== null ? { fromSpaceId } : {}),
        toSpaceId,
      }) as Promise<SpacesIpcResultView<unknown>>,
    addToSpace: (id, toSpaceId) =>
      ipcRenderer.invoke(SPACES_ITEMS_ADD_TO_SPACE, { id, toSpaceId }) as Promise<
        SpacesIpcResultView<unknown>
      >,
    removeFromSpace: (id, spaceId) =>
      ipcRenderer.invoke(SPACES_ITEMS_REMOVE_FROM_SPACE, { id, spaceId }) as Promise<
        SpacesIpcResultView<unknown>
      >,
    search: (opts) =>
      ipcRenderer.invoke(SPACES_ITEMS_SEARCH, { opts }) as Promise<
        SpacesIpcResultView<unknown[]>
      >,
    searchAgentic: (payload: { query: string; spaceId?: string }) =>
      ipcRenderer.invoke(SPACES_ITEMS_SEARCH_AGENTIC, payload) as Promise<
        SpacesIpcResultView<unknown>
      >,
    onSearchAgenticProgress: (listener: (p: unknown) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, p: unknown): void => listener(p);
      ipcRenderer.on(SPACES_ITEMS_SEARCH_AGENTIC_PROGRESS, handler);
      return (): void => {
        ipcRenderer.removeListener(SPACES_ITEMS_SEARCH_AGENTIC_PROGRESS, handler);
      };
    },
    versions: (id: string, limit?: number) =>
      ipcRenderer.invoke(SPACES_ITEMS_VERSIONS, { id, limit }) as Promise<
        SpacesIpcResultView<unknown[]>
      >,
    getVersion: (id: string, seq: number) =>
      ipcRenderer.invoke(SPACES_ITEMS_VERSION_GET, { id, seq }) as Promise<
        SpacesIpcResultView<unknown>
      >,
    restoreVersion: (id: string, seq: number, editorId?: string) =>
      ipcRenderer.invoke(SPACES_ITEMS_VERSION_RESTORE, { id, seq, editorId }) as Promise<
        SpacesIpcResultView<unknown>
      >,
    setMetadata: (id, metadata) =>
      ipcRenderer.invoke(SPACES_ITEMS_SET_METADATA, { id, metadata }) as Promise<
        SpacesIpcResultView<unknown>
      >,
    patchMetadata: (id, patch) =>
      ipcRenderer.invoke(SPACES_ITEMS_PATCH_METADATA, { id, patch }) as Promise<
        SpacesIpcResultView<unknown>
      >,
    removeMetadataKey: (id, key) =>
      ipcRenderer.invoke(SPACES_ITEMS_REMOVE_METADATA_KEY, { id, key }) as Promise<
        SpacesIpcResultView<unknown>
      >,
  },
  runDiscovery: () =>
    ipcRenderer.invoke(SPACES_DISCOVERY_RUN) as Promise<
      SpacesIpcResultView<SpacesDiscoveryResultsView>
    >,
  // Home view (chunk 3k + 3o)
  home: {
    entityCounts: () =>
      ipcRenderer.invoke(SPACES_HOME_ENTITY_COUNTS) as Promise<
        SpacesIpcResultView<SpacesEntityCountsView>
      >,
    recentItems: (opts) =>
      ipcRenderer.invoke(
        SPACES_HOME_RECENT_ITEMS,
        opts !== undefined ? opts : {}
      ) as Promise<SpacesIpcResultView<unknown[]>>,
    topContributors: (opts) =>
      ipcRenderer.invoke(
        SPACES_HOME_TOP_CONTRIBUTORS,
        opts !== undefined ? opts : {}
      ) as Promise<SpacesIpcResultView<SpacesContributorView[]>>,
    recentEvents: (opts) =>
      ipcRenderer.invoke(
        SPACES_HOME_RECENT_EVENTS,
        opts !== undefined ? opts : {}
      ) as Promise<SpacesIpcResultView<SpacesEventView[]>>,
    agentsSample: (opts) =>
      ipcRenderer.invoke(
        SPACES_HOME_AGENTS_SAMPLE,
        opts !== undefined ? opts : {}
      ) as Promise<SpacesIpcResultView<SpacesAgentSummaryView[]>>,
    permissionSummary: () =>
      ipcRenderer.invoke(SPACES_HOME_PERMISSION_SUMMARY) as Promise<
        SpacesIpcResultView<SpacesPermissionSummaryView>
      >,
  },
  // Mutations (Phase 3a)
  createSpace: (input) =>
    ipcRenderer.invoke(SPACES_CREATE_SPACE, { input }) as Promise<
      SpacesIpcResultView<unknown>
    >,
  renameSpace: (id, name) =>
    ipcRenderer.invoke(SPACES_RENAME_SPACE, { id, name }) as Promise<
      SpacesIpcResultView<unknown>
    >,
  updateSpace: (id, patch) =>
    ipcRenderer.invoke(SPACES_UPDATE_SPACE, { id, patch }) as Promise<
      SpacesIpcResultView<unknown>
    >,
  pinSpace: (id, pinned) =>
    ipcRenderer.invoke(SPACES_PIN_SPACE, { id, pinned }) as Promise<
      SpacesIpcResultView<{ ok: true }>
    >,
  deleteSpace: (id, opts) =>
    ipcRenderer.invoke(SPACES_DELETE_SPACE, {
      id,
      ...(opts !== undefined ? { opts } : {}),
    }) as Promise<SpacesIpcResultView<{ ok: true }>>,
  undeleteSpace: (id) =>
    ipcRenderer.invoke(SPACES_UNDELETE_SPACE, { id }) as Promise<
      SpacesIpcResultView<unknown>
    >,
  setSpaceKind: (id, kind) =>
    ipcRenderer.invoke(SPACES_SET_SPACE_KIND, { id, kind }) as Promise<
      SpacesIpcResultView<'user' | 'shared'>
    >,
  playbooks: {
    current: (spaceId) =>
      ipcRenderer.invoke(SPACES_PLAYBOOKS_CURRENT, { spaceId }) as Promise<
        SpacesIpcResultView<unknown | null>
      >,
    set: (spaceId, playbookId) =>
      ipcRenderer.invoke(SPACES_PLAYBOOKS_SET, { spaceId, playbookId }) as Promise<
        SpacesIpcResultView<{ playbook: unknown; ticketCount: number }>
      >,
  },
  tickets: {
    list: (spaceId, opts) =>
      ipcRenderer.invoke(SPACES_TICKETS_LIST, {
        spaceId,
        ...(opts?.status !== undefined ? { status: opts.status } : {}),
        ...(opts?.limit !== undefined ? { limit: opts.limit } : {}),
        ...(opts?.offset !== undefined ? { offset: opts.offset } : {}),
      }) as Promise<SpacesIpcResultView<unknown[]>>,
    create: (spaceId, input) =>
      ipcRenderer.invoke(SPACES_TICKETS_CREATE, { spaceId, input }) as Promise<
        SpacesIpcResultView<unknown>
      >,
    update: (id, patch) =>
      ipcRenderer.invoke(SPACES_TICKETS_UPDATE, { id, patch }) as Promise<
        SpacesIpcResultView<unknown>
      >,
  },
  identity: {
    attributionEmailGet: () =>
      ipcRenderer.invoke(SPACES_IDENTITY_ATTR_EMAIL_GET) as Promise<
        SpacesIpcResultView<string | null>
      >,
    attributionEmailSet: (email: string | null) =>
      ipcRenderer.invoke(SPACES_IDENTITY_ATTR_EMAIL_SET, { email }) as Promise<
        SpacesIpcResultView<string | null>
      >,
    getOrCreatePerson: (input) =>
      ipcRenderer.invoke(SPACES_IDENTITY_GET_OR_CREATE_PERSON, { input }) as Promise<
        SpacesIpcResultView<{ id: string; name: string; email?: string }>
      >,
    requestSignIn: () =>
      ipcRenderer.invoke(SPACES_AUTH_SIGN_IN) as Promise<
        SpacesIpcResultView<{ email: string | null; accountId: string | null }>
      >,
  },
  members: {
    list: (spaceId) =>
      ipcRenderer.invoke(SPACES_MEMBERS_LIST, { spaceId }) as Promise<
        SpacesIpcResultView<Array<{ kind: string; id: string; name: string }>>
      >,
    add: (spaceId, memberId, opts) =>
      ipcRenderer.invoke(SPACES_MEMBERS_ADD, {
        spaceId,
        memberId,
        // Forward the key only when the caller set it: absent, null
        // and a value are three different intents (leave / permanent
        // / expire) all the way down to the Cypher.
        ...(opts !== undefined && 'expiresAt' in opts ? { expiresAt: opts.expiresAt } : {}),
        // ADR-074 — same three-intent discipline for role.
        ...(opts !== undefined && 'role' in opts ? { role: opts.role } : {}),
      }) as Promise<SpacesIpcResultView<{ kind: string; id: string; name: string; accessExpiresAt?: string }>>,
    searchLibrary: (q, limit) =>
      ipcRenderer.invoke(SPACES_MEMBERS_SEARCH_LIBRARY, {
        q,
        ...(limit !== undefined ? { limit } : {}),
      }) as Promise<
        SpacesIpcResultView<
          Array<{ kind: 'Person' | 'Agent'; id: string; name: string; email: string }>
        >
      >,
    remove: (spaceId, memberId) =>
      ipcRenderer.invoke(SPACES_MEMBERS_REMOVE, { spaceId, memberId }) as Promise<
        SpacesIpcResultView<{ ok: true }>
      >,
  },
  /** ADR-072 — journey maps (Planning). */
  journeys: {
    onNewJourney: (cb: () => void) => {
      const listener = (): void => cb();
      ipcRenderer.on('lite:spaces:new-journey', listener);
      return () => ipcRenderer.removeListener('lite:spaces:new-journey', listener);
    },
    draft: (prompt: string) =>
      ipcRenderer.invoke(SPACES_JOURNEYS_DRAFT, { prompt }) as Promise<
        SpacesIpcResultView<unknown>
      >,
    suggest: (spaceId: string) =>
      ipcRenderer.invoke(SPACES_JOURNEYS_SUGGEST, { spaceId }) as Promise<
        SpacesIpcResultView<unknown>
      >,
    create: (spaceId: string, draft: unknown) =>
      ipcRenderer.invoke(SPACES_JOURNEYS_CREATE, { spaceId, draft }) as Promise<
        SpacesIpcResultView<unknown>
      >,
  },
  checklists: {
    create: (input) =>
      ipcRenderer.invoke(SPACES_CHECKLISTS_CREATE, { input }) as Promise<SpacesIpcResultView<unknown>>,
    draft: (prompt: string) =>
      ipcRenderer.invoke(SPACES_CHECKLISTS_DRAFT, { prompt }) as Promise<
        SpacesIpcResultView<unknown>
      >,
    update: (input: unknown) =>
      ipcRenderer.invoke(SPACES_CHECKLISTS_UPDATE, { input }) as Promise<
        SpacesIpcResultView<{ id: string; version: number }>
      >,
    remove: (id: string) =>
      ipcRenderer.invoke(SPACES_CHECKLISTS_REMOVE, { id }) as Promise<
        SpacesIpcResultView<{ ok: true }>
      >,
    list: (spaceId) =>
      ipcRenderer.invoke(SPACES_CHECKLISTS_LIST, { spaceId }) as Promise<SpacesIpcResultView<unknown[]>>,
    attach: (input) =>
      ipcRenderer.invoke(SPACES_CHECKLISTS_ATTACH, { input }) as Promise<SpacesIpcResultView<{ ok: true }>>,
    forTicket: (ticketId) =>
      ipcRenderer.invoke(SPACES_CHECKLISTS_FOR_TICKET, { ticketId }) as Promise<SpacesIpcResultView<unknown[]>>,
    setItem: (input) =>
      ipcRenderer.invoke(SPACES_CHECKLISTS_SET_ITEM, { input }) as Promise<
        SpacesIpcResultView<{ checkedIndexes: number[]; complete: boolean }>
      >,
    detach: (ticketId, checklistId, phase) =>
      ipcRenderer.invoke(SPACES_CHECKLISTS_DETACH, { ticketId, checklistId, phase }) as Promise<
        SpacesIpcResultView<{ ok: true }>
      >,
  },
  onCacheUpdate(handler) {
    const wrapped = (
      _event: Electron.IpcRendererEvent,
      update: SpacesCacheUpdateView
    ): void => {
      try {
        handler(update);
      } catch {
        /* renderer handler threw -- isolate so other listeners survive */
      }
    };
    ipcRenderer.on(SPACES_CACHE_UPDATED, wrapped);
    return () => {
      try {
        ipcRenderer.off(SPACES_CACHE_UPDATED, wrapped);
      } catch {
        /* best-effort */
      }
    };
  },
};

const health: HealthBridge = {
  getPulse: () => ipcRenderer.invoke(HEALTH_PULSE_GET),
  onPulse: (cb: (pulse: unknown) => void) => {
    const listener = (_e: unknown, pulse: unknown): void => cb(pulse);
    ipcRenderer.on(HEALTH_PULSE_EVENT, listener as never);
    return () => ipcRenderer.removeListener(HEALTH_PULSE_EVENT, listener as never);
  },
  snapshot: () => ipcRenderer.invoke(HEALTH_SNAPSHOT) as Promise<LiteAppHealthSnapshotView>,
};

/**
 * Telemetry consent + status. Read-mostly: the renderer can show the
 * install id and flip consent from Settings -> Diagnostics; everything
 * else about telemetry is main-process business.
 */
const telemetry: TelemetryBridge = {
  getStatus: () =>
    ipcRenderer.invoke(TELEMETRY_GET_STATUS) as Promise<LiteTelemetryStatusView>,
  setConsent: (state) =>
    ipcRenderer.invoke(TELEMETRY_SET_CONSENT, { state }) as Promise<LiteTelemetryStatusView>,
};

// ---------------------------------------------------------------------------
// Memory bridge (ADR-079) -- agentic-memory server CRUD + space
// ingestion. Payload shapes are opaque `unknown` here (the preload
// stays type-light, matching the spaces bridge); the renderer-facing
// types live in lite-window.d.ts. The API key flows one way: it rides
// `addServer` inward and never comes back out of `listServers`.
// ---------------------------------------------------------------------------

type MemoryIpcResultView<T> =
  | { ok: true; value: T }
  | { ok: false; error: { message: string } };

interface MemoryBridge {
  listServers(): Promise<MemoryIpcResultView<unknown[]>>;
  addServer(input: {
    name: string;
    url: string;
    apiKey?: string;
    toolName?: string;
  }): Promise<MemoryIpcResultView<unknown>>;
  removeServer(id: string): Promise<MemoryIpcResultView<null>>;
  testServer(id: string): Promise<MemoryIpcResultView<unknown>>;
  ingestSpace(spaceId: string): Promise<MemoryIpcResultView<unknown>>;
  onIngestProgress(handler: (beat: unknown) => void): () => void;
}

const memory: MemoryBridge = {
  listServers: () =>
    ipcRenderer.invoke(MEMORY_LIST_SERVERS) as Promise<
      MemoryIpcResultView<unknown[]>
    >,
  addServer: (input) =>
    ipcRenderer.invoke(MEMORY_ADD_SERVER, input) as Promise<
      MemoryIpcResultView<unknown>
    >,
  removeServer: (id) =>
    ipcRenderer.invoke(MEMORY_REMOVE_SERVER, { id }) as Promise<
      MemoryIpcResultView<null>
    >,
  testServer: (id) =>
    ipcRenderer.invoke(MEMORY_TEST_SERVER, { id }) as Promise<
      MemoryIpcResultView<unknown>
    >,
  ingestSpace: (spaceId) =>
    ipcRenderer.invoke(MEMORY_INGEST_SPACE, { spaceId }) as Promise<
      MemoryIpcResultView<unknown>
    >,
  onIngestProgress: (handler) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      beat: unknown
    ): void => {
      try {
        handler(beat);
      } catch {
        // best-effort: never let a buggy handler crash IPC
      }
    };
    ipcRenderer.on(MEMORY_INGEST_PROGRESS, listener);
    return (): void => {
      ipcRenderer.removeListener(MEMORY_INGEST_PROGRESS, listener);
    };
  },
};

const neon: NeonBridge = {
  queryNamed: (name, parameters) =>
    ipcRenderer.invoke(NEON_QUERY_NAMED, { name, parameters }) as Promise<{ records: NeonRecord[] }>,
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
  exportMemory: (id) =>
    ipcRenderer.invoke(IDW_MEMORY_EXPORT, { id }) as Promise<{
      ok: boolean;
      provider: string;
      itemId?: string;
      chars?: number;
      reason?: string;
    }>,
  openStore: () => ipcRenderer.invoke(IDW_OPEN_STORE) as Promise<{ ok: true }>,
  open: (id: string) => ipcRenderer.invoke(IDW_OPEN, { id }) as Promise<{ ok: true }>,
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
  reloadActive(): Promise<{ ok: boolean }>;
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
  reloadActive: () =>
    ipcRenderer.invoke(MAIN_WINDOW_RELOAD_ACTIVE) as Promise<{ ok: boolean }>,
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

// ---------------------------------------------------------------------------
// AI bridge -- Claude metadata extraction + Anthropic key management.
// Every method returns the `{ ok, value | error }` envelope the AI IPC
// handlers produce. The API key is write-only: `saveKey` / `hasKey` /
// `deleteKey` never return the value.
// ---------------------------------------------------------------------------

interface AiIpcErrorView {
  code: string;
  message: string;
  remediation?: string;
  context?: Record<string, unknown>;
}
type AiIpcResultView<T> = { ok: true; value: T } | { ok: false; error: AiIpcErrorView };

interface AiStatusView {
  configured: boolean;
  provider: 'claude' | 'onereach-flow' | null;
}
interface AiSpaceAssistResultView {
  description: string;
  objectives: string[];
}
interface AiEnrichResultView {
  metadata: {
    summary: string;
    suggestedTitle: string;
    tags: string[];
    topics: string[];
    entities: string[];
    contentType: string;
    language: string;
    keyPoints: string[];
  };
  written: Record<string, string | string[]>;
  modality: 'text' | 'image' | 'pdf' | 'hints';
}

/** Result of an OKF conversion (agent definition -> structured text). */
interface AiOkfResultView {
  okf: string;
  agentType: string;
  name: string;
}

interface AiBridge {
  getStatus(): Promise<AiIpcResultView<AiStatusView>>;
  /** Provider-flexible Space-creation assist (purpose -> description + objectives). */
  spaceAssist(
    purpose: string,
    name?: string
  ): Promise<AiIpcResultView<AiSpaceAssistResultView>>;
  /** Claude 4.8 metadata extraction for one asset, persisted under `ai_*` keys. */
  enrichAsset(assetId: string): Promise<AiIpcResultView<AiEnrichResultView>>;
  /**
   * Convert an agent definition into OKF via Claude. `source` is a URL
   * (when `isUrl`) or pasted text. Returns the OKF text + classified
   * agentType + suggested name. Powers "add an agent" in Spaces.
   */
  suggestSpaces(
    item: { title: string; kind?: string; text?: string },
    spaces: Array<{ id: string; name: string; description?: string }>
  ): Promise<AiIpcResultView<{ suggestions: Array<{ spaceId: string; reason: string }> }>>;
  convertToOkf(
    source: string,
    isUrl: boolean
  ): Promise<AiIpcResultView<AiOkfResultView>>;
  /** Persist the Anthropic key to the OS keychain (write-only). */
  saveKey(key: string): Promise<AiIpcResultView<{ ok: true }>>;
  /** Whether a key is configured (never returns the value). */
  hasKey(): Promise<AiIpcResultView<{ hasKey: boolean }>>;
  /** Remove the stored key. */
  deleteKey(): Promise<AiIpcResultView<{ ok: true }>>;
  /** Validate a candidate key against the live API without saving it. */
  testKey(key: string): Promise<AiIpcResultView<{ ok: true; model: string }>>;
}

const ai: AiBridge = {
  getStatus: () => ipcRenderer.invoke(AI_STATUS) as Promise<AiIpcResultView<AiStatusView>>,
  spaceAssist: (purpose, name) =>
    ipcRenderer.invoke(AI_SPACE_ASSIST, {
      purpose,
      ...(name !== undefined ? { name } : {}),
    }) as Promise<AiIpcResultView<AiSpaceAssistResultView>>,
  enrichAsset: (assetId) =>
    ipcRenderer.invoke(AI_ENRICH_ASSET, { assetId }) as Promise<
      AiIpcResultView<AiEnrichResultView>
    >,
  convertToOkf: (source, isUrl) =>
    ipcRenderer.invoke(AI_CONVERT_OKF, { source, isUrl }) as Promise<
      AiIpcResultView<AiOkfResultView>
    >,
  suggestSpaces: (item, spaces) =>
    ipcRenderer.invoke(AI_SUGGEST_SPACES, { item, spaces }) as Promise<
      AiIpcResultView<{ suggestions: Array<{ spaceId: string; reason: string }> }>
    >,
  saveKey: (key) =>
    ipcRenderer.invoke(AI_KEY_SAVE, { key }) as Promise<AiIpcResultView<{ ok: true }>>,
  hasKey: () => ipcRenderer.invoke(AI_KEY_HAS) as Promise<AiIpcResultView<{ hasKey: boolean }>>,
  deleteKey: () => ipcRenderer.invoke(AI_KEY_DELETE) as Promise<AiIpcResultView<{ ok: true }>>,
  testKey: (key) =>
    ipcRenderer.invoke(AI_KEY_TEST, { key }) as Promise<AiIpcResultView<{ ok: true; model: string }>>,
};

// ---------------------------------------------------------------------------
// GSX automation bridge — open GSX studio windows (Designer/Flows/...)
// and drive them with deterministic scripts wrapped in an eval loop.
// View types structurally mirror lite/gsx/types.ts (the bridge keeps
// its own copies per file convention -- no cross-boundary imports).
// ---------------------------------------------------------------------------

const GSX_OPEN_WINDOW = 'lite:gsx:open-window';
const GSX_CLOSE_WINDOW = 'lite:gsx:close-window';
const GSX_LIST_WINDOWS = 'lite:gsx:list-windows';
const GSX_NAVIGATE = 'lite:gsx:navigate';
const GSX_SNAPSHOT = 'lite:gsx:snapshot';
const GSX_LIST_SCRIPTS = 'lite:gsx:list-scripts';
const GSX_GET_SCRIPT = 'lite:gsx:get-script';
const GSX_SAVE_SCRIPT = 'lite:gsx:save-script';
const GSX_DELETE_SCRIPT = 'lite:gsx:delete-script';
const GSX_RUN_SCRIPT = 'lite:gsx:run-script';
const GSX_LIST_RUNS = 'lite:gsx:list-runs';
const GSX_GET_RUN = 'lite:gsx:get-run';
const GSX_GET_STATS = 'lite:gsx:get-stats';
const GSX_START_RECORDING = 'lite:gsx:start-recording';
const GSX_STOP_RECORDING = 'lite:gsx:stop-recording';
const GSX_CANCEL_RECORDING = 'lite:gsx:cancel-recording';
const GSX_GET_RECORDING = 'lite:gsx:get-recording';
const GSX_STOP_RECORDING_AS_AGENT = 'lite:gsx:stop-recording-as-agent';
const GSX_INVOKE_AGENT = 'lite:gsx:invoke-agent';
const GSX_LIST_AGENTS = 'lite:gsx:list-agents';
const GSX_GET_AGENT = 'lite:gsx:get-agent';
const GSX_DELETE_AGENT = 'lite:gsx:delete-agent';

interface GsxWindowInfoView {
  windowId: string;
  env: string;
  url: string;
  title: string;
}

interface GsxScriptView {
  id: string;
  title: string;
  description: string;
  version: number;
  source: 'seed' | 'learned';
  params?: string[];
  steps: Array<Record<string, unknown> & { kind: string }>;
}

interface GsxStepResultView {
  index: number;
  kind: string;
  ok: boolean;
  detail?: string;
  durationMs: number;
}

interface GsxRunRecordView {
  runId: string;
  scriptId: string;
  scriptVersion: number;
  source: 'seed' | 'learned';
  windowId: string;
  params: Record<string, string>;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  verdict: 'pass' | 'fail' | 'error' | 'repaired-pass' | 'repaired-fail';
  steps: GsxStepResultView[];
  failure?: string;
  repair?: {
    attempted: boolean;
    learnedVersion?: number;
    skippedReason?: string;
    steps?: GsxStepResultView[];
  };
}

interface GsxScriptStatsView {
  scriptId: string;
  runs: number;
  passes: number;
  failures: number;
  consecutiveFailures: number;
  lastVerdict?: string;
  lastRunAt?: string;
  lastInvalidatedAt?: string;
}

interface GsxSnapshotView {
  url: string;
  title: string;
  elements: Array<{
    ref: number;
    tag: string;
    text: string;
    attrs: Record<string, string>;
  }>;
}

interface GsxBridge {
  /** Open a GSX studio window (auth-injected before navigation). */
  openWindow(opts?: {
    env?: string;
    url?: string;
    title?: string;
  }): Promise<GsxWindowInfoView>;
  closeWindow(windowId: string): Promise<{ closed: boolean }>;
  listWindows(): Promise<GsxWindowInfoView[]>;
  navigate(windowId: string, url: string): Promise<GsxWindowInfoView>;
  /** Interactive-element census -- the same picture the repair LLM sees. */
  snapshot(windowId: string): Promise<GsxSnapshotView>;
  listScripts(): Promise<GsxScriptView[]>;
  getScript(id: string): Promise<GsxScriptView>;
  saveScript(script: GsxScriptView): Promise<GsxScriptView>;
  deleteScript(id: string): Promise<{ deleted: boolean }>;
  /** Run + grade a script; failing runs may be AI-repaired (see run.repair). */
  runScript(opts: {
    scriptId: string;
    windowId?: string;
    env?: string;
    params?: Record<string, string>;
    repair?: boolean;
  }): Promise<GsxRunRecordView>;
  listRuns(scriptId?: string): Promise<GsxRunRecordView[]>;
  getRun(runId: string): Promise<GsxRunRecordView>;
  getStats(scriptId?: string): Promise<GsxScriptStatsView[]>;
  /** TEACH MODE: record your own navigation, save it as a template. */
  startRecording(windowId: string): Promise<GsxRecordingStatusView>;
  /** Stop + save the recording as a learned template. The AI turns the
   *  concrete walkthrough into a parameterized script ({flowName}, ...)
   *  unless generalize is false. */
  stopRecording(
    windowId: string,
    opts: {
      scriptId: string;
      title: string;
      description: string;
      generalize?: boolean;
    }
  ): Promise<GsxScriptView>;
  cancelRecording(windowId: string): Promise<{ cancelled: boolean }>;
  getRecording(windowId: string): Promise<GsxRecordingStatusView>;
  /** Finish a recording as a NAMED agent: the system writes its title,
   *  description, and param docs; publishes to the "GSX Build" Space. */
  stopRecordingAsAgent(
    windowId: string,
    opts: { name: string; hint?: string; publish?: boolean }
  ): Promise<GsxAgentView>;
  /** Invoke an agent by name; params are extracted from free-form
   *  details (or passed structured). */
  invokeAgent(
    name: string,
    opts?: {
      details?: string;
      params?: Record<string, string>;
      windowId?: string;
      env?: string;
      repair?: boolean;
    }
  ): Promise<GsxInvokeAgentResultView>;
  listAgents(): Promise<GsxAgentView[]>;
  getAgent(name: string): Promise<GsxAgentView>;
  deleteAgent(name: string): Promise<{ deleted: boolean }>;
}

interface GsxRecordingStatusView {
  windowId: string;
  recording: boolean;
  eventCount: number;
}

interface GsxAgentView {
  name: string;
  title: string;
  description: string;
  scriptId: string;
  params: Array<{ name: string; description: string }>;
  createdAt: string;
  updatedAt: string;
  spaceItemId?: string;
}

interface GsxInvokeAgentResultView {
  agent: GsxAgentView;
  params: Record<string, string>;
  run: GsxRunRecordView;
}

const gsx: GsxBridge = {
  openWindow: (opts) =>
    ipcRenderer.invoke(GSX_OPEN_WINDOW, opts) as Promise<GsxWindowInfoView>,
  closeWindow: (windowId) =>
    ipcRenderer.invoke(GSX_CLOSE_WINDOW, windowId) as Promise<{ closed: boolean }>,
  listWindows: () => ipcRenderer.invoke(GSX_LIST_WINDOWS) as Promise<GsxWindowInfoView[]>,
  navigate: (windowId, url) =>
    ipcRenderer.invoke(GSX_NAVIGATE, windowId, url) as Promise<GsxWindowInfoView>,
  snapshot: (windowId) =>
    ipcRenderer.invoke(GSX_SNAPSHOT, windowId) as Promise<GsxSnapshotView>,
  listScripts: () => ipcRenderer.invoke(GSX_LIST_SCRIPTS) as Promise<GsxScriptView[]>,
  getScript: (id) => ipcRenderer.invoke(GSX_GET_SCRIPT, id) as Promise<GsxScriptView>,
  saveScript: (script) =>
    ipcRenderer.invoke(GSX_SAVE_SCRIPT, script) as Promise<GsxScriptView>,
  deleteScript: (id) =>
    ipcRenderer.invoke(GSX_DELETE_SCRIPT, id) as Promise<{ deleted: boolean }>,
  runScript: (opts) => ipcRenderer.invoke(GSX_RUN_SCRIPT, opts) as Promise<GsxRunRecordView>,
  listRuns: (scriptId) =>
    ipcRenderer.invoke(GSX_LIST_RUNS, scriptId) as Promise<GsxRunRecordView[]>,
  getRun: (runId) => ipcRenderer.invoke(GSX_GET_RUN, runId) as Promise<GsxRunRecordView>,
  getStats: (scriptId) =>
    ipcRenderer.invoke(GSX_GET_STATS, scriptId) as Promise<GsxScriptStatsView[]>,
  startRecording: (windowId) =>
    ipcRenderer.invoke(GSX_START_RECORDING, windowId) as Promise<GsxRecordingStatusView>,
  stopRecording: (windowId, opts) =>
    ipcRenderer.invoke(GSX_STOP_RECORDING, windowId, opts) as Promise<GsxScriptView>,
  cancelRecording: (windowId) =>
    ipcRenderer.invoke(GSX_CANCEL_RECORDING, windowId) as Promise<{ cancelled: boolean }>,
  getRecording: (windowId) =>
    ipcRenderer.invoke(GSX_GET_RECORDING, windowId) as Promise<GsxRecordingStatusView>,
  stopRecordingAsAgent: (windowId, opts) =>
    ipcRenderer.invoke(GSX_STOP_RECORDING_AS_AGENT, windowId, opts) as Promise<GsxAgentView>,
  invokeAgent: (name, opts) =>
    ipcRenderer.invoke(GSX_INVOKE_AGENT, name, opts) as Promise<GsxInvokeAgentResultView>,
  listAgents: () => ipcRenderer.invoke(GSX_LIST_AGENTS) as Promise<GsxAgentView[]>,
  getAgent: (name) => ipcRenderer.invoke(GSX_GET_AGENT, name) as Promise<GsxAgentView>,
  deleteAgent: (name) =>
    ipcRenderer.invoke(GSX_DELETE_AGENT, name) as Promise<{ deleted: boolean }>,
};

// ---------------------------------------------------------------------------
// Download picker bridge — consumed by lite/downloads/picker.ts.
// The renderer reads its bootstrap (file summary + spaces) and resolves
// with the user's pick (or null on cancel). The main process owns the
// upload + asset-create that happens once the picker resolves.
// ---------------------------------------------------------------------------

type DownloadPickerKindView =
  | 'document'
  | 'image'
  | 'url'
  | 'text'
  | 'audio'
  | 'video'
  | 'other';

interface DownloadPickerSpaceView {
  id: string;
  name: string;
  color?: string;
  itemCount?: number;
}

interface DownloadPickerBootstrapView {
  download: {
    fileName: string;
    mimeType: string;
    kind: DownloadPickerKindView;
    totalBytes: number;
    source: string;
  };
  spaces: DownloadPickerSpaceView[];
  defaultSpaceId?: string;
}

interface DownloadPickerResultView {
  spaceId: string;
  spaceName: string;
}

interface DownloadPickerBridge {
  bootstrap(downloadId: string): Promise<DownloadPickerBootstrapView>;
  resolve(
    downloadId: string,
    result: DownloadPickerResultView | null
  ): Promise<{ ok: true }>;
}

const downloadPicker: DownloadPickerBridge = {
  bootstrap: (downloadId: string) =>
    ipcRenderer.invoke(DOWNLOAD_PICKER_BOOTSTRAP, {
      downloadId,
    }) as Promise<DownloadPickerBootstrapView>,
  resolve: (downloadId: string, result: DownloadPickerResultView | null) =>
    ipcRenderer.invoke(DOWNLOAD_PICKER_RESOLVE, {
      downloadId,
      result,
    }) as Promise<{ ok: true }>,
};

interface BootChatBridge {
  /** Signal the main process to swap this window to chrome.html. */
  finish(): void;
}

const bootChat: BootChatBridge = {
  finish: () => {
    ipcRenderer.send(BOOT_CHAT_FINISH);
  },
};

contextBridge.exposeInMainWorld('lite', {
  bugReport,
  ...liteMetadata,
  homeUrl: {
    get: () =>
      ipcRenderer.invoke(HOME_URL_GET) as Promise<{
        url: string;
        isDefault: boolean;
        defaultUrl: string;
      }>,
    set: (url: string | null) =>
      ipcRenderer.invoke(HOME_URL_SET, { url }) as Promise<{
        url: string;
        isDefault: boolean;
        defaultUrl: string;
      }>,
  },
  theme: {
    get: () =>
      ipcRenderer.invoke(THEME_GET) as Promise<{
        preference: 'light' | 'dark' | 'system';
        isDefault: boolean;
      }>,
    set: (preference: 'light' | 'dark' | 'system' | null) =>
      ipcRenderer.invoke(THEME_SET, { preference }) as Promise<{
        preference: 'light' | 'dark' | 'system';
        isDefault: boolean;
      }>,
  },
  auth,
  totp,
  settings,
  apiDocs,
  spaces,
  health,
  telemetry,
  neon,
  memory,
  idw,
  tools,
  ai,
  gsx,
  mainWindow,
  events,
  university,
  aiRunTimes,
  onboarding,
  downloadPicker,
  bootChat,
});
contextBridge.exposeInMainWorld('logging', logging);
contextBridge.exposeInMainWorld('bugReport', bugReport);
contextBridge.exposeInMainWorld('updater', updater);
