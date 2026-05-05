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
  apiDocs?: LiteApiDocsBridge;
  health?: LiteHealthBridge;
  neon?: LiteNeonBridge;
  idw?: LiteIdwBridge;
  mainWindow?: LiteMainWindowBridge;
  events?: LiteEventBusBridge;
  university?: LiteUniversityBridge;
  ai?: LiteAiBridge;
  aiRunTimes?: LiteAiRunTimesBridge;
}

// ---------------------------------------------------------------------------
// Lite AI service bridge -- mirrors lite/ai/api.ts AiApi.
// ---------------------------------------------------------------------------

type LiteAiTtsVoice = 'alloy' | 'echo' | 'fable' | 'onyx' | 'nova' | 'shimmer';
type LiteAiTtsModel = 'tts-1' | 'tts-1-hd';
type LiteAiTtsFormat = 'mp3' | 'opus' | 'aac' | 'flac' | 'wav' | 'pcm';

interface LiteAiTtsRequest {
  text: string;
  voice?: LiteAiTtsVoice;
  model?: LiteAiTtsModel;
  format?: LiteAiTtsFormat;
  speed?: number;
  feature?: string;
}

interface LiteAiTtsResult {
  audioBase64: string;
  mimeType: string;
  voice: string;
  model: string;
  format: string;
}

interface LiteAiChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface LiteAiChatRequest {
  messages: LiteAiChatMessage[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
  feature?: string;
}

interface LiteAiChatResponse {
  content: string;
  model: string;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
}

interface LiteAiStatus {
  provider: 'openai';
  hasApiKey: boolean;
  defaultTtsVoice: string;
  defaultTtsModel: string;
  defaultChatModel: string;
}

interface LiteAiConfig {
  apiKey?: string;
  defaultTtsVoice?: LiteAiTtsVoice;
  defaultTtsModel?: LiteAiTtsModel;
  defaultChatModel?: string;
}

interface LiteAiErrorJSON {
  name: string;
  code: string;
  message: string;
  context: Record<string, unknown>;
  remediation: string;
  cause?: string;
}

interface LiteAiBridge {
  tts(req: LiteAiTtsRequest): Promise<LiteAiTtsResult>;
  chat(req: LiteAiChatRequest): Promise<LiteAiChatResponse>;
  status(): Promise<LiteAiStatus>;
  configure(config: LiteAiConfig): Promise<{ ok: true }>;
  parseError(err: unknown): LiteAiErrorJSON | null;
}

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
  parseError(err: unknown): LiteAiRunTimesErrorJSON | null;
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

interface Window {
  lite?: LiteWindowBridge;
}
