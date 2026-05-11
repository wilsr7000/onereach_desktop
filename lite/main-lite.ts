/**
 * Onereach Lite -- main process entry point.
 *
 * Per ADR-011 (slim kernel) + ADR-038 (tabbed main window), this
 * kernel ships with:
 *   - Single-instance lock keyed on com.onereach.lite
 *   - Boot-time guard that no full-app modules have been loaded
 *   - Branding banner log line at boot
 *   - Log server on port 47392 (via lib/log-server.js)
 *   - Tabbed main window (chrome.html + per-tab WebContentsView under
 *     a 36px tab bar). Falls back to legacy `placeholder.html` on hard
 *     init failure.
 *   - Top-level menus: Onereach.ai Lite, IDW, Agentic University,
 *     Help, etc. -- registered by per-module `init*()` calls below.
 *   - Sign-in popup-aware OAuth (Google / Microsoft / Apple SSO) per
 *     ADR-042: popups stay in the same partition so cookies land
 *     correctly.
 *   - Bug-reporter modal writing to userData/lite-bugs/ on Send
 *   - Onboarding checklist card on the home view (KV-backed)
 *
 * Borrowed patterns (studied, never imported):
 *   - main.js:95-115 single-instance lock + second-instance focus
 *   - main.js:286-516 app.whenReady boot sequence
 *   - main.js:563 logServer.start wiring
 *   - main.js:182-218 shell.openExternal override pattern (NOT borrowed --
 *     kernel does not navigate external URLs yet)
 *
 * No imports from full's root files. Only lite/, lib/log-server, and node_modules.
 */

import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import * as path from 'node:path';
import * as fs from 'node:fs';

import { initMenu } from './menu/build-menu.js';
import { seedKernelMenu } from './menu/seed.js';
import { registry as menuRegistry } from './menu/registry.js';
import { openBugReportModal, initBugReport } from './bug-report/main.js';
import { initAuth, type AuthHandle } from './auth/main.js';
import { initTotp, type TotpHandle } from './totp/main.js';
import { initSettings, type SettingsHandle } from './settings/main.js';
import { initHelp, type HelpHandle } from './help/main.js';
import { initApiDocs, type ApiDocsHandle } from './api-docs/main.js';
import { initHealth, type HealthHandle } from './health/main.js';
import { initNeon, type NeonHandle } from './neon/main.js';
import { initIdw, type IdwHandle } from './idw/main.js';
import { initTools, type ToolsHandle } from './tools/main.js';
import { initMainWindow, type MainWindowHandle } from './main-window/main.js';
import { initEventBus, type EventBusHandle } from './event-bus/main.js';
import { initUniversity, type UniversityHandle } from './university/main.js';
// NOTE: `initAi` from lite/ai/ was removed -- TTS and the AI
// service module were pulled in the first-run UX hardening pass.
// Bringing TTS back is a separate chunk that re-introduces lite/ai/.
import { initAiRunTimes, type AiRunTimesHandle } from './ai-run-times/main.js';
import { initOnboarding, type OnboardingHandle } from './onboarding/main.js';
import { initUpdater, verifyUpdateOnStartup, type UpdaterHandle } from './updater/index.js';
import { getLoggingApi, LOGGING_SELF_CATEGORY } from './logging/api.js';
import { getAuthApi } from './auth/api.js';
import { runKvMigration } from './kv/migration.js';
import { setKVAuthBindings } from './kv/api.js';
import { setFilesAuthBindings } from './files/api.js';
import { installReSignInPrompter } from './auth/re-signin-prompt.js';
import { getDiscoveryApi } from './discovery/api.js';

const LITE_LOG_PORT = 47392;
const LITE_PRODUCT_NAME = 'Onereach.ai Lite';

// ============================================================================
// APP IDENTITY -- override the defaults that Electron picks up from its own
// package.json when running via `electron <script>` in dev. This must run
// BEFORE app.whenReady so the userData path uses the correct product name.
// In packaged builds, electron-builder's productName + version override
// these defaults automatically -- but the explicit setName is harmless
// either way.
// ============================================================================

app.setName(LITE_PRODUCT_NAME);

// Electron prints "Insecure Content-Security-Policy" warnings for any
// renderer process loaded without a CSP header / meta tag. Lite's own
// windows (chrome, settings, api-docs, catalog, modal, etc.) all set
// strict CSPs -- but the per-tab WebContentsView agent renderers load
// third-party pages (ChatGPT, Claude, Marvin, ...) whose CSP we don't
// control. Those third-party pages legitimately use `unsafe-eval` and
// other patterns that fire the warning. Since the warning would
// otherwise spam DevTools with noise we cannot fix, we suppress it
// here. The suppression is dev-only -- packaged builds don't show
// these warnings regardless. If a new lite-owned window ships
// without CSP, run `grep -L 'Content-Security-Policy' lite/**/*.html`
// to catch the regression at lint time instead of relying on this
// warning. ADR-042.
process.env['ELECTRON_DISABLE_SECURITY_WARNINGS'] = 'true';

// Read Lite's version. Lite ships from the same repo as the full
// app but tracks its own version independently -- the full app's
// `package.json` at the repo root carries the full app's version
// (currently 5.x), which is NOT what Lite should display.
//
// Resolution order:
//   1. `lite/package.json` (the canonical Lite version source).
//   2. Electron-builder packaged metadata at `app.asar/package.json`.
//   3. Repo-root `package.json` (last-resort fallback only -- if you
//      see Lite reporting the full app's version, it means the
//      `lite/package.json` candidate didn't resolve, NOT that this
//      is the intended source).
//
// __dirname differs between dev (`dist-lite/build/`) and packaged
// (`app.asar/dist-lite/build/`), so we try several relative paths.
function readLiteVersion(): string {
  const candidates = [
    // Dev path: <repo>/dist-lite/build -> <repo>/lite/package.json
    path.resolve(__dirname, '..', '..', 'lite', 'package.json'),
    // Packaged: extraMetadata.version is written into app.asar/package.json
    path.resolve(__dirname, '..', '..', 'package.json'),
    // Fallback siblings (rarely used; keep for paranoia).
    path.resolve(__dirname, '..', 'package.json'),
    path.resolve(__dirname, 'package.json'),
  ];
  for (const candidate of candidates) {
    try {
      const pkg = JSON.parse(fs.readFileSync(candidate, 'utf-8')) as {
        version?: string;
        name?: string;
      };
      // Defense in depth: if we accidentally read the full app's
      // package.json (name === 'onereach-app' or similar), skip it.
      // Only `lite/package.json` (name: 'onereach-lite') or the
      // packaged extraMetadata override should match.
      if (
        typeof pkg.version === 'string' &&
        pkg.version.length > 0 &&
        (pkg.name === undefined || pkg.name === 'onereach-lite')
      ) {
        return pkg.version;
      }
    } catch {
      /* try next candidate */
    }
  }
  return '0.0.0';
}

const LITE_VERSION = readLiteVersion();
process.env.LITE_APP_VERSION = LITE_VERSION;

// Module-load time -- best-available "process started" stamp for the
// health snapshot's uptime computation. ADR-036.
const BOOT_STARTED_AT = Date.now();

// ============================================================================
// BOOT GUARD -- assert no full-app modules have already been required.
// Per LITE-RULES, lite imports only from lite/ and lib/. If main-lite.ts
// somehow ended up loading main.js (or any forbidden root file), crash
// loud here so the bug surfaces in dev rather than corrupting state.
// ============================================================================

const FORBIDDEN_MODULE_PATTERNS = [
  /[/\\]main\.js$/,
  /[/\\]preload\.js$/,
  /[/\\]preload-(?!lite).+\.js$/, // preload-* but NOT preload-lite
  /[/\\]action-executor\.js$/,
  /[/\\]app-manager-agent\.js$/,
  /[/\\]menu\.js$/,
  /[/\\]menu-data-manager\.js$/,
  /[/\\]module-manager\.js$/,
  /[/\\]module-manager-ui\.html$/,
  /[/\\]tabbed-browser\.html$/,
  /[/\\]agent-manager\.html$/,
  /[/\\]orb\.html$/,
  /[/\\]packages[/\\]/,
];

function assertNoFullAppModulesLoaded(): void {
  const loaded = Object.keys(require.cache);
  const violations = loaded.filter((modulePath) =>
    FORBIDDEN_MODULE_PATTERNS.some((pattern) => pattern.test(modulePath))
  );
  if (violations.length > 0) {
    const message = `Onereach Lite boot guard: forbidden full-app modules loaded:\n${violations.join('\n')}`;
    // eslint-disable-next-line no-console
    console.error(message);
    throw new Error(message);
  }
}

// Run guard before anything else (other than imports above this file).
// Imports above are: electron, node:path, node:fs, lite/*. None of those
// pull in full-app code.
assertNoFullAppModulesLoaded();

// ============================================================================
// SINGLE INSTANCE LOCK -- keyed on com.onereach.lite. Lite installs as a
// distinct app (different bundle ID, different Dock entry, different
// userData), so this lock does NOT conflict with the full app's lock.
// ============================================================================

if (!app.requestSingleInstanceLock()) {
  // eslint-disable-next-line no-console
  console.log('[lite] Another instance is already running. Exiting.');
  app.quit();
  process.exit(0);
}

let mainWindow: BrowserWindow | null = null;
let updaterHandle: UpdaterHandle | null = null;
let authHandle: AuthHandle | null = null;
let totpHandle: TotpHandle | null = null;
let settingsHandle: SettingsHandle | null = null;
let helpHandle: HelpHandle | null = null;
let apiDocsHandle: ApiDocsHandle | null = null;
let healthHandle: HealthHandle | null = null;
let neonHandle: NeonHandle | null = null;
let idwHandle: IdwHandle | null = null;
let toolsHandle: ToolsHandle | null = null;
let mainWindowHandle: MainWindowHandle | null = null;
let eventBusHandle: EventBusHandle | null = null;
let universityHandle: UniversityHandle | null = null;
let aiRunTimesHandle: AiRunTimesHandle | null = null;
let onboardingHandle: OnboardingHandle | null = null;

app.on('second-instance', () => {
  // Best-effort event emission: if logging isn't initialized yet, skip
  // (the central queue lazy-resolves on first call).
  try {
    getLoggingApi().event('app.second-instance', {
      hadMainWindow: mainWindow !== null && !mainWindow.isDestroyed(),
    });
  } catch {
    // intentional silent fallback during very-early second-instance bursts
  }
  if (mainWindow !== null && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

// ============================================================================
// LOG QUEUE + LOG SERVER (lite port 47392)
// ============================================================================

// Use require for the lib/ modules (they're CJS).
// Path: from dist-lite/build/main-lite.js, lib/ lives at repo-root/lib,
// which is two levels up. Resolve via __dirname so it works regardless
// of process CWD, and use a dynamic argument so esbuild leaves the
// require alone (we want lib/ loaded from disk at runtime).
const libDir = path.resolve(__dirname, '..', '..', 'lib');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { getLogQueue } = require(path.join(libDir, 'log-event-queue')) as {
  getLogQueue: () => {
    debug: (cat: string, msg: string, data?: unknown) => void;
    info: (cat: string, msg: string, data?: unknown) => void;
    warn: (cat: string, msg: string, data?: unknown) => void;
    error: (cat: string, msg: string, data?: unknown) => void;
  };
};
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { LogServer } = require(path.join(libDir, 'log-server')) as {
  LogServer: new (queue: unknown, options?: { port?: number }) => {
    start: () => Promise<void>;
    stop: () => void;
  };
};

const logQueue = getLogQueue();
const logServer = new LogServer(logQueue, { port: LITE_LOG_PORT });

// ============================================================================
// IPC -- accept structured logging from the renderer (preload-lite.ts)
// ============================================================================

interface LogEnqueuePayload {
  level: 'debug' | 'info' | 'warn' | 'error';
  category: string;
  message: string;
  data?: unknown;
}

// The logging IPC handlers are deliberately NOT wrapped with
// `logging.ipc.<verb>` invocation events (per ADR-030). The work each
// handler performs IS the event log -- the resulting log entry / event
// is the visible artifact. Adding a parallel "this IPC fired" event
// would double the volume for every renderer log call without
// providing new diagnostic value, and risks subtle recursion if the
// logging module itself ever logs at debug level inside event().
ipcMain.on('lite:logging:enqueue', (_event, payload: LogEnqueuePayload) => {
  if (typeof payload?.level !== 'string' || typeof payload.category !== 'string' || typeof payload.message !== 'string') {
    return;
  }
  // Route through getLoggingApi() so renderer log lines pick up any
  // future LoggingStore-side validation, sampling, or tagging. Fall back
  // to the lib queue directly if the logging module itself is unhealthy
  // -- losing a log line is preferable to dropping it on the floor.
  try {
    const fn = getLoggingApi()[payload.level];
    if (typeof fn === 'function') {
      fn(payload.category, payload.message, payload.data);
    }
  } catch {
    const fn = logQueue[payload.level];
    if (typeof fn === 'function') {
      fn(payload.category, payload.message, payload.data);
    }
  }
});

// Renderer-emitted structured events. Spans stay main-process only;
// renderer code emits paired `<name>.start` / `<name>.finish` instant
// events through this channel.
//
// The handler body wraps the LoggingApi call in try/catch so a buggy
// or unloadable logging module never crashes the IPC dispatcher --
// fall back to a direct lib-queue warn so the failure itself is
// observable. (Direct queue access here is the deliberate
// last-resort path; everything else routes through getLoggingApi.)
ipcMain.on(
  'lite:logging:event',
  (_event, payload: { name?: unknown; data?: unknown; level?: unknown }) => {
    if (typeof payload?.name !== 'string' || payload.name.length === 0) return;
    const level =
      payload.level === 'debug' || payload.level === 'info' || payload.level === 'warn' || payload.level === 'error'
        ? payload.level
        : undefined;
    try {
      getLoggingApi().event(payload.name, payload.data, level);
    } catch (err) {
      logQueue.warn(LOGGING_SELF_CATEGORY, 'renderer event() rejected', {
        name: payload.name,
        error: (err as Error).message,
      });
    }
  }
);

// Renderer can query recent events from the main-side ring buffer.
// Same defensive pattern as the event handler above: fall back to a
// direct lib-queue warn if getLoggingApi() / recent() fails.
ipcMain.handle(
  'lite:logging:recent',
  async (_event, payload: { pattern?: unknown; limit?: unknown }) => {
    const pattern = typeof payload?.pattern === 'string' ? payload.pattern : '*';
    const limit = typeof payload?.limit === 'number' ? payload.limit : 50;
    try {
      return getLoggingApi().recent(pattern, limit);
    } catch (err) {
      logQueue.warn(LOGGING_SELF_CATEGORY, 'renderer recent() failed', {
        pattern,
        error: (err as Error).message,
      });
      return [];
    }
  }
);

// ============================================================================
// APP READY -- boot sequence
// ============================================================================

// Boot span -- wraps the whole whenReady chain so consumers can see how
// long boot took and which steps fired before any failure. Started here
// (in module scope) and finished/failed inside the chain. ADR-030.
const bootSpan = (() => {
  try {
    return getLoggingApi().start('app.boot', { version: LITE_VERSION });
  } catch {
    // Pre-queue startup edge case: emit nothing, return a no-op stub.
    return { id: 'pre-queue', name: 'app.boot', finish: () => undefined, fail: () => undefined };
  }
})();

app
  .whenReady()
  .then(async () => {
    // Branding banner -- log line that makes it visually unmistakable
    // which app is running when both lite + full are open simultaneously.
    const userDataPath = app.getPath('userData');
    const banner = `[LITE] ${LITE_PRODUCT_NAME} v${LITE_VERSION} | userData=${userDataPath} | log=:${LITE_LOG_PORT}`;
    // eslint-disable-next-line no-console
    console.log(banner);
    getLoggingApi().info('app', `${LITE_PRODUCT_NAME} booting`, {
      version: LITE_VERSION,
      userDataPath,
      logPort: LITE_LOG_PORT,
      platform: process.platform,
      appTag: 'lite',
    });

    // Cross-restart install verification BEFORE creating any windows.
    // If the prior install failed, this surfaces a dialog and clears
    // (or preserves) state per the user's choice.
    try {
      await verifyUpdateOnStartup({
        logger: {
          info: (msg, data) => getLoggingApi().info('updater', msg, data),
          warn: (msg, data) => getLoggingApi().warn('updater', msg, data),
        },
      });
    } catch (err) {
      getLoggingApi().error('updater', 'verifyUpdateOnStartup threw', {
        error: (err as Error).message,
      });
    }

    // Start log server. Failure is non-fatal -- bug reporter falls back
    // to an empty log lines array if the server is unreachable.
    try {
      await logServer.start();
    } catch (err) {
      getLoggingApi().error('app', 'log server failed to start', {
        error: (err as Error).message,
      });
    }

    // Configure macOS About panel -- on macOS, role: 'about' opens this panel
    // automatically. On Windows we route to the custom about.html via the
    // app:about menu entry's click handler.
    if (process.platform === 'darwin') {
      app.setAboutPanelOptions({
        applicationName: LITE_PRODUCT_NAME,
        applicationVersion: LITE_VERSION,
        version: LITE_VERSION,
        copyright: 'Copyright © 2026 Onereach.ai',
        credits: `${LITE_PRODUCT_NAME} -- v0.1 kernel`,
      });
    }

    // Initialize bug-report main-process handlers + window factory.
    // HTML/CSS assets live in dist-lite/build/ alongside their bundled JS so
    // file:// origin + strict CSP can load them with relative paths.
    const preloadPath = path.join(__dirname, 'preload-lite.js');
    const modalHtmlPath = path.join(__dirname, 'modal.html');
    initBugReport({
      logServerPort: LITE_LOG_PORT,
      preloadPath,
      modalHtmlPath,
      liteVersion: LITE_VERSION,
      getParentWindow: () => mainWindow,
    });

    // Initialize the event bus (ADR-043) FIRST among the IPC modules
    // so it catches every domain-relevant event subsequent inits
    // emit. The bus subscribes to the central logging queue and
    // projects raw events into the typed `DomainEvent` catalogue;
    // hydrate replays the persisted ring buffer from KV.
    try {
      eventBusHandle = await initEventBus({
        logger: {
          info: (msg, data) => logQueue.info('event-bus', msg, data),
          warn: (msg, data) => logQueue.warn('event-bus', msg, data),
          error: (msg, data) => logQueue.error('event-bus', msg, data),
        },
      });
    } catch (err) {
      getLoggingApi().error('event-bus', 'initEventBus threw', {
        error: (err as Error).message,
      });
    }

    // Initialize auth (Edison only in v1; ADR-026). Hydrates from KV
    // in the background so getSession() returns the rehydrated value
    // by the time the placeholder window asks.
    try {
      authHandle = initAuth({
        logger: {
          info: (msg, data) => logQueue.info('auth', msg, data),
          warn: (msg, data) => logQueue.warn('auth', msg, data),
          error: (msg, data) => logQueue.error('auth', msg, data),
        },
      });
    } catch (err) {
      getLoggingApi().error('auth', 'initAuth threw', {
        error: (err as Error).message,
      });
    }

    // Install the re-sign-in prompter BEFORE wiring KV bindings so the
    // KV layer can call `promptReSignIn(reason)` the moment the SDK
    // surfaces a stale-token rejection. The prompter dedupes
    // concurrent rejections itself, so the KV layer never has to.
    const reSignInHandle = installReSignInPrompter({
      env: 'edison',
      getParentWindow: () => mainWindow,
    });

    // Wire KV's default config to live auth. Per ADR-044, lite/kv/api.ts
    // intentionally does NOT import lite/auth/ to avoid the
    // auth -> kv -> auth cycle. Instead, main-lite.ts (which sits
    // above both) injects the resolvers after initAuth completes.
    //
    // `onAuthRejected` carries the kernel's "Sign in again?" prompt.
    // The KV transport detects `"Token was not accepted: wrong keyId"`
    // (and similar stale-token strings) and fires this hook, which
    // surfaces a system dialog and -- on user consent -- opens the
    // OneReach SSO popup. Without this hook, the user would see a
    // generic KV_NETWORK toast and have no recovery path.
    try {
      setKVAuthBindings({
        getToken: () => getAuthApi().getToken('edison') ?? '',
        getAccountId: () => getAuthApi().getSession('edison')?.accountId ?? null,
        onAuthRejected: (reason) => reSignInHandle.promptReSignIn(reason),
      });
    } catch (err) {
      getLoggingApi().error('kv', 'setKVAuthBindings threw', {
        error: (err as Error).message,
      });
    }

    // Same pattern for Files (ADR-045). lite/files/ does not import
    // lite/auth/ either, so main-lite.ts injects the resolvers here.
    // The bindings are read lazily on every Files op, so they always
    // reflect the current sign-in state.
    try {
      setFilesAuthBindings({
        getToken: () => getAuthApi().getToken('edison') ?? '',
        getAccountId: () => getAuthApi().getSession('edison')?.accountId ?? null,
      });
    } catch (err) {
      getLoggingApi().error('files', 'setFilesAuthBindings threw', {
        error: (err as Error).message,
      });
    }

    // KV migration + discovery cache invalidation on session changes.
    // The lite-kv-via-sdk chunk introduced server-side per-account
    // scoping for KV; existing data still lives in the legacy
    // anonymous KV. On every sign-in, attempt a one-shot copy into
    // the user's authenticated namespace. Idempotent -- subsequent
    // calls for the same account are no-ops once the sentinel is set.
    //
    // Discovery cache is cleared on sign-out so a subsequent sign-in
    // (potentially as a different user) re-resolves service URLs
    // through the new token.
    try {
      getAuthApi().onSessionChanged((env, session) => {
        if (env !== 'edison') return;
        if (session === null) {
          try {
            getDiscoveryApi().invalidateCache();
          } catch (err) {
            getLoggingApi().warn('discovery', 'invalidateCache on sign-out failed', {
              error: (err as Error).message,
            });
          }
          return;
        }
        // Run migration in the background -- never block sign-in on it.
        void runKvMigration(session.accountId)
          .then((result) => {
            getLoggingApi().info('kv-migration', 'sign-in migration complete', {
              accountId: result.accountId,
              alreadyMigrated: result.alreadyMigrated,
              copiedCount: result.copied.length,
              failedCount: result.failed.length,
            });
          })
          .catch((err: unknown) => {
            getLoggingApi().error('kv-migration', 'sign-in migration threw', {
              accountId: session.accountId,
              error: (err as Error).message,
            });
          });
      });
    } catch (err) {
      getLoggingApi().error('kv-migration', 'failed to wire onSessionChanged', {
        error: (err as Error).message,
      });
    }

    // Initialize TOTP module (ADR-027). Registers IPC handlers
    // (lite:totp:*) consumed by the Settings -> Two-Factor section.
    // The standalone Authenticator window was removed in ADR-031;
    // initTotp no longer takes window-related options.
    try {
      totpHandle = initTotp({
        logger: {
          info: (msg, data) => logQueue.info('totp', msg, data),
          warn: (msg, data) => logQueue.warn('totp', msg, data),
          error: (msg, data) => logQueue.error('totp', msg, data),
        },
      });
    } catch (err) {
      getLoggingApi().error('totp', 'initTotp threw', {
        error: (err as Error).message,
      });
    }

    // Initialize Settings (ADR-031). Hosts the Two-Factor section and
    // any future sections (Account, Updates, Diagnostics, About).
    // Reuses the kernel's single preload so renderer code can call
    // window.lite.totp.* etc.
    try {
      settingsHandle = initSettings({
        preloadPath,
        htmlPath: path.join(__dirname, 'settings.html'),
        getParentWindow: () => mainWindow,
        logger: {
          info: (msg, data) => logQueue.info('settings', msg, data),
          warn: (msg, data) => logQueue.warn('settings', msg, data),
          error: (msg, data) => logQueue.error('settings', msg, data),
        },
      });
    } catch (err) {
      getLoggingApi().error('settings', 'initSettings threw', {
        error: (err as Error).message,
      });
    }

    // Initialize Help (User Guide). Adds the "Onereach.ai Lite Help"
    // entry under the Help menu. Single-instance window loading
    // help.html. Registers its own menu entry via initHelp() (matches
    // the updater pattern -- the kernel seed only owns top:help, child
    // owners attach their items themselves).
    try {
      helpHandle = initHelp({
        preloadPath,
        htmlPath: path.join(__dirname, 'help.html'),
        getParentWindow: () => mainWindow,
        logger: {
          info: (msg, data) => logQueue.info('help', msg, data),
          warn: (msg, data) => logQueue.warn('help', msg, data),
          error: (msg, data) => logQueue.error('help', msg, data),
        },
      });
    } catch (err) {
      getLoggingApi().error('help', 'initHelp threw', {
        error: (err as Error).message,
      });
    }

    // Initialize API Reference window (ADR-035). Renders bundled
    // module documentation harvested from lite/<module>/api.ts +
    // events.ts + README.md. Reachable from Settings -> Developer
    // -> Open API Reference and from window.lite.apiDocs.open().
    try {
      apiDocsHandle = initApiDocs({
        preloadPath,
        htmlPath: path.join(__dirname, 'api-docs.html'),
        getParentWindow: () => mainWindow,
        logger: {
          info: (msg, data) => getLoggingApi().info('api-docs', msg, data),
          warn: (msg, data) => getLoggingApi().warn('api-docs', msg, data),
          error: (msg, data) => getLoggingApi().error('api-docs', msg, data),
        },
      });
    } catch (err) {
      getLoggingApi().error('api-docs', 'initApiDocs threw', {
        error: (err as Error).message,
      });
    }

    // Initialize Neon (Neo4j Aura) module. Registers IPC handlers
    // (lite:neon:*) consumed by the Settings -> Neon section and any
    // future feature ports that need graph access. Lazy: no network
    // call until the renderer / a feature actually invokes a query.
    try {
      neonHandle = initNeon({
        logger: {
          info: (msg, data) => getLoggingApi().info('neon', msg, data),
          warn: (msg, data) => getLoggingApi().warn('neon', msg, data),
          error: (msg, data) => getLoggingApi().error('neon', msg, data),
        },
      });
    } catch (err) {
      getLoggingApi().error('neon', 'initNeon threw', {
        error: (err as Error).message,
      });
    }

    // Initialize IDW module. Registers IPC handlers (lite:idw:*),
    // the top:idw menu placeholder + dynamic entries, the shared
    // placeholder browser window factory, and the OAGI Store
    // catalog window factory. Pulls IDW + Agent nodes from OAGI via
    // window.lite.neon.query in the catalog renderer.
    try {
      idwHandle = initIdw({
        preloadPath,
        catalogHtmlPath: path.join(__dirname, 'idw-store.html'),
        getParentWindow: () => mainWindow,
        logger: {
          info: (msg, data) => getLoggingApi().info('idw', msg, data),
          warn: (msg, data) => getLoggingApi().warn('idw', msg, data),
          error: (msg, data) => getLoggingApi().error('idw', msg, data),
        },
      });
    } catch (err) {
      getLoggingApi().error('idw', 'initIdw threw', {
        error: (err as Error).message,
      });
    }

    // Initialize Tools module. Registers IPC handlers (lite:tools:*),
    // the top:tools menu placeholder + per-tool items + the always-
    // present "Manage Tools..." item, and the manager window factory.
    // Each tool is a user-curated label+url shortcut; clicks open in
    // the user's default browser.
    try {
      toolsHandle = initTools({
        preloadPath,
        managerHtmlPath: path.join(__dirname, 'tools-manager.html'),
        getParentWindow: () => mainWindow,
        logger: {
          info: (msg, data) => getLoggingApi().info('tools', msg, data),
          warn: (msg, data) => getLoggingApi().warn('tools', msg, data),
          error: (msg, data) => getLoggingApi().error('tools', msg, data),
        },
      });
    } catch (err) {
      getLoggingApi().error('tools', 'initTools threw', {
        error: (err as Error).message,
      });
    }

    // Initialize Agentic University module. Registers the
    // top:university menu (Open LMS / Quick Starts -> View All
    // Tutorials + courses / AI Run Times / Wiser Method), the
    // shared Learning Browser singleton (separate persistent
    // partition from IDW so course session cookies don't bleed
    // into IDW agent sessions), and the polished tutorials
    // catalog window factory.
    try {
      universityHandle = initUniversity({
        preloadPath,
        tutorialsHtmlPath: path.join(__dirname, 'university-tutorials.html'),
        getParentWindow: () => mainWindow,
        logger: {
          info: (msg, data) => getLoggingApi().info('university', msg, data),
          warn: (msg, data) => getLoggingApi().warn('university', msg, data),
          error: (msg, data) => getLoggingApi().error('university', msg, data),
        },
        // Special-case: the curated 'ai-run-times' entry routes to
        // the dedicated AI Run Times reader window instead of
        // opening uxmag.com in the generic Learning Browser. Keeps
        // lite/university/ from depending on lite/ai-run-times/.
        onOpenEntryOverride: (entry) => {
          if (entry.id === 'ai-run-times') {
            // Lazy import via require so the wiring stays inside
            // main-lite.ts and the modules remain peers (per
            // Rule 11). The handle is the same singleton initAiRunTimes
            // returned, so calling its window factory is safe even
            // before the user has opened it once.
            void (async () => {
              try {
                const { openAiRunTimesWindow } = await import('./ai-run-times/window.js');
                openAiRunTimesWindow({
                  parent: mainWindow,
                  htmlPath: path.join(__dirname, 'ai-run-times.html'),
                  preloadPath,
                });
              } catch (e) {
                getLoggingApi().error('university', 'failed to open AI Run Times', {
                  error: (e as Error).message,
                });
              }
            })();
            return true;
          }
          return false;
        },
      });
    } catch (err) {
      getLoggingApi().error('university', 'initUniversity threw', {
        error: (err as Error).message,
      });
    }

    // Lite AI service (initAi) was pulled in the first-run UX
    // hardening pass along with TTS. Re-introducing it is a separate
    // chunk -- see ADR-040 history if you need the original wiring.

    // Initialize AI Run Times -- Flipboard-style article reader,
    // owns the dedicated reader window. The University menu's
    // "AI Run Times" item routes to `lite:ai-run-times:open-window`
    // via the click handler installed by initAiRunTimes. ADR-041.
    try {
      aiRunTimesHandle = initAiRunTimes({
        preloadPath,
        htmlPath: path.join(__dirname, 'ai-run-times.html'),
        getParentWindow: () => mainWindow,
        logger: {
          info: (msg, data) => getLoggingApi().info('ai-run-times', msg, data),
          warn: (msg, data) => getLoggingApi().warn('ai-run-times', msg, data),
          error: (msg, data) => getLoggingApi().error('ai-run-times', msg, data),
        },
      });
    } catch (err) {
      getLoggingApi().error('ai-run-times', 'initAiRunTimes threw', {
        error: (err as Error).message,
      });
    }

    // Initialize Onboarding module: KV-backed checklist progress
    // for the first-run "checklist card" in the chrome home view.
    try {
      onboardingHandle = initOnboarding();
    } catch (err) {
      getLoggingApi().error('onboarding', 'initOnboarding threw', {
        error: (err as Error).message,
      });
    }

    // Initialize Health snapshot module (ADR-036). Pull-based "what
    // is true right now?" reader. Wired AFTER auth/totp/neon/updater
    // so its readers can call those modules' singletons -- the IPC
    // handler installs the real store-backed singleton and the
    // renderer's `window.lite.health.snapshot()` works from then on.
    try {
      healthHandle = initHealth({
        version: LITE_VERSION,
        startedAt: BOOT_STARTED_AT,
        userDataPath,
        logger: {
          info: (msg, data) => getLoggingApi().info('health', msg, data),
          warn: (msg, data) => getLoggingApi().warn('health', msg, data),
          error: (msg, data) => getLoggingApi().error('health', msg, data),
        },
      });
    } catch (err) {
      getLoggingApi().error('health', 'initHealth threw', {
        error: (err as Error).message,
      });
    }

    // Seed the menu registry with kernel entries, then start the builder.
    seedKernelMenu({
      onReportBug: () => openBugReportModal(),
      onAbout: () => {
        if (process.platform === 'darwin') {
          // Native panel
          app.showAboutPanel();
        } else {
          // Custom HTML window for Windows + Linux
          openAboutWindow();
        }
      },
      onQuit: () => app.quit(),
      onSettings: () => settingsHandle?.open(),
      onOpenFocusedDevTools: () => openFocusedWindowDevTools(),
      onOpenActiveTabDevTools: () => openActiveTabDevTools(),
      onOpenAllDevTools: () => openAllWindowDevTools(),
    });
    initMenu();

    // E2E test seam: expose the menu registry on globalThis so the harness
    // can drive register/unregister from a Playwright app.evaluate callback.
    // Gated on LITE_TEST_MODE so this surface never exists in user-facing
    // builds. Test launches set LITE_TEST_MODE via launchLite().
    if (process.env.LITE_TEST_MODE === 'true') {
      (globalThis as Record<string, unknown>).__liteMenuRegistry = menuRegistry;
    }

    // Initialize auto-updater AFTER the menu seed (so top:help exists for
    // the Check for Updates child item to attach to) and AFTER initMenu
    // (so the registry's change event triggers a rebuild that picks up
    // the new entry). Per ADR-020, lite ships with full parity.
    //
    // LITE_DEV_UPDATE_CONFIG: when set, point electron-updater at a local
    // dev-app-update.yml (typically pointing at lite/test/harness/updater/
    // server.ts). This is how the updater test harness exercises the
    // check-for-updates flow against a hermetic local server -- never set
    // in production builds. See lite/LITE-PUNCH-LIST.md (now resolved).
    try {
      const updaterOpts: Parameters<typeof initUpdater>[0] = {
        logger: {
          info: (msg, data) => getLoggingApi().info('updater', msg, data),
          warn: (msg, data) => getLoggingApi().warn('updater', msg, data),
          error: (msg, data) => getLoggingApi().error('updater', msg, data),
          debug: (msg, data) => getLoggingApi().debug('updater', msg, data),
        },
        // ADR-030: spans on `updater.check` and `updater.install`.
        spanEmitter: (name, data) => getLoggingApi().start(name, data),
      };
      const devCfg = process.env.LITE_DEV_UPDATE_CONFIG;
      if (devCfg !== undefined && devCfg.length > 0) {
        updaterOpts.devUpdateConfigPath = devCfg;
      }
      updaterHandle = initUpdater(updaterOpts);
    } catch (err) {
      getLoggingApi().error('updater', 'initUpdater threw', {
        error: (err as Error).message,
      });
    }

    // Create the tabbed main window (replaces the legacy single
    // placeholder window per ADR-038). The factory wires its own
    // store subscription, IPC handlers, and tab-view orchestration;
    // we just hold a reference for the parent-window resolvers
    // already wired into Settings / IDW / API Docs / etc.
    try {
      mainWindowHandle = initMainWindow({
        chromeHtmlPath: path.join(__dirname, 'chrome.html'),
        preloadPath,
        logger: {
          info: (message, data) => getLoggingApi().info('main-window', message, data),
          warn: (message, data) => getLoggingApi().warn('main-window', message, data),
          error: (message, data) => getLoggingApi().error('main-window', message, data),
        },
      });
      mainWindow = mainWindowHandle.window;
    } catch (err) {
      getLoggingApi().error('main-window', 'initMainWindow threw', {
        error: (err as Error).message,
      });
      // Fallback: spin up the legacy placeholder so the kernel still
      // boots while the tabbed window is being debugged. Reachable
      // only on hard errors during ADR-038 rollout.
      mainWindow = createMainWindow(preloadPath);
    }

    // Boot span -- close the success path. The window is on screen but
    // ready-to-show is async; treating window creation as the boot's
    // logical end is correct (subsequent logs are runtime, not boot).
    try {
      bootSpan.finish({
        version: LITE_VERSION,
        platform: process.platform,
      });
    } catch {
      // intentional silent fallback
    }
  })
  .catch((err: unknown) => {
    // Best-effort: try to log via the central queue. Boot may have
    // failed before getLoggingApi() can resolve its lib queue, so wrap
    // in try/catch and fall back to raw console.
    try {
      bootSpan.fail(err);
    } catch {
      // eslint-disable-next-line no-console
      console.error('[lite] boot failed:', err);
    }
    dialog.showErrorBox('Onereach.ai Lite failed to start', String(err));
    app.quit();
  });

// ============================================================================
// WINDOW MANAGEMENT
// ============================================================================

function createMainWindow(preloadPath: string): BrowserWindow {
  // placeholder.html is copied into dist-lite/build/ during esbuild build
  // so file:// origin + strict CSP can load same-directory assets.
  const placeholderHtml = path.join(__dirname, 'placeholder.html');

  const win = new BrowserWindow({
    width: 720,
    height: 480,
    title: LITE_PRODUCT_NAME,
    backgroundColor: '#0e0e10',
    show: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      additionalArguments: [`--lite-app-version=${LITE_VERSION}`],
    },
  });

  void win.loadFile(placeholderHtml);
  win.once('ready-to-show', () => {
    getLoggingApi().event('window.main.ready-to-show');
    win.show();
  });

  win.on('closed', () => {
    getLoggingApi().event('window.main.closed');
    if (mainWindow === win) mainWindow = null;
  });

  // Block external navigation in kernel (no AI, no Spaces, no IDWs to
  // navigate to). Future ports relax this when needed.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  return win;
}

let aboutWindow: BrowserWindow | null = null;

function openAboutWindow(): void {
  if (aboutWindow !== null && !aboutWindow.isDestroyed()) {
    aboutWindow.focus();
    return;
  }
  const aboutHtml = path.join(__dirname, 'about.html');

  aboutWindow = new BrowserWindow({
    width: 360,
    height: 280,
    title: `About ${LITE_PRODUCT_NAME}`,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    backgroundColor: '#0e0e10',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload-lite.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      additionalArguments: [`--lite-app-version=${LITE_VERSION}`],
    },
  });

  void aboutWindow.loadFile(aboutHtml);
  aboutWindow.once('ready-to-show', () => {
    getLoggingApi().event('window.about.ready-to-show');
    aboutWindow?.show();
  });
  aboutWindow.on('closed', () => {
    getLoggingApi().event('window.about.closed');
    aboutWindow = null;
  });
}

function openDevToolsForBrowserWindow(win: BrowserWindow | null, source: string): boolean {
  if (win === null || win.isDestroyed() || win.webContents.isDestroyed()) {
    return false;
  }

  try {
    win.webContents.openDevTools({ mode: 'detach' });
    getLoggingApi().event('devtools.open-window', {
      source,
      windowId: win.id,
      title: win.getTitle(),
    });
    return true;
  } catch (err) {
    getLoggingApi().warn('devtools', 'failed to open BrowserWindow DevTools', {
      source,
      windowId: win.id,
      error: (err as Error).message,
    });
    return false;
  }
}

function openFocusedWindowDevTools(): void {
  const focusedWindow = BrowserWindow.getFocusedWindow();
  if (openDevToolsForBrowserWindow(focusedWindow, 'focused-window')) {
    return;
  }

  const fallbackWindow = BrowserWindow.getAllWindows().find(
    (win) => !win.isDestroyed() && win.isVisible()
  );
  if (!openDevToolsForBrowserWindow(fallbackWindow ?? null, 'first-visible-window')) {
    getLoggingApi().warn('devtools', 'no BrowserWindow available for DevTools');
  }
}

function openActiveTabDevTools(): void {
  const opened = mainWindowHandle?.openActiveTabDevTools() ?? false;
  if (!opened) {
    getLoggingApi().warn('devtools', 'no active tab available for DevTools');
  }
}

function openAllWindowDevTools(): void {
  let opened = 0;
  for (const win of BrowserWindow.getAllWindows()) {
    if (openDevToolsForBrowserWindow(win, 'all-windows')) {
      opened += 1;
    }
  }

  if (mainWindowHandle?.openActiveTabDevTools() === true) {
    opened += 1;
  }

  if (opened === 0) {
    getLoggingApi().warn('devtools', 'no Lite windows or active tab available for DevTools');
  }
}

// ============================================================================
// SHUTDOWN
// ============================================================================

app.on('window-all-closed', () => {
  // On macOS, leaving the app running with no windows is conventional.
  // For the kernel, quit on all-closed regardless -- there's no state
  // worth preserving in the placeholder window.
  try {
    getLoggingApi().event('app.window-all-closed');
  } catch {
    // intentional silent fallback during shutdown
  }
  // Skip the explicit quit when an auto-update install is in flight.
  // Squirrel.Mac's `nativeUpdater.quitAndInstall()` closes all
  // windows itself as part of its handoff to ShipIt; if we ALSO
  // call `app.quit()` here, Electron's cooperative quit races
  // Squirrel's terminate path. The race is the exact scenario the
  // install.ts header warns about (lines 16-22), and the user's
  // "Install and Relaunch" still produced the old bundle until the
  // before-quit guard skipped the teardowns AND we stopped the
  // redundant quit. Squirrel will drive the process to exit
  // cleanly on its own.
  if ((global as { isUpdatingApp?: boolean }).isUpdatingApp === true) {
    try {
      getLoggingApi().event('app.window-all-closed.skip-quit', { reason: 'updating' });
    } catch {
      // intentional silent fallback during shutdown
    }
    return;
  }
  app.quit();
});

app.on('before-quit', () => {
  try {
    getLoggingApi().event('app.before-quit');
  } catch {
    // intentional silent fallback during shutdown
  }

  // CRITICAL: when an auto-update install is in flight, Squirrel.Mac's
  // `nativeUpdater.quitAndInstall()` triggered this `before-quit`
  // event mid-handoff. Running our normal module teardowns here
  // breaks the install in two ways:
  //
  //  1. `updaterHandle.teardown()` calls `lifecycle.teardown()` which
  //     calls `autoUpdater.removeAllListeners()`. Stripping every
  //     listener off the autoUpdater EventEmitter mid-flight can
  //     leave electron-updater unable to drive the handoff to ShipIt
  //     (and even when ShipIt does start, the renderer's
  //     `update-downloaded` UI state may already have been thrown
  //     away by our teardown).
  //  2. The 14+ other teardowns below (auth/totp/settings/...) all
  //     do real work -- KV flushes, cookie clears, window-close
  //     callbacks. Each consumes part of the 10s safety-net budget
  //     in `lite/updater/install.ts`. If we burn that budget,
  //     `process.exit(0)` fires BEFORE Squirrel.Mac finishes
  //     swapping `/Applications/Onereach.ai Lite.app`. The user
  //     reboots into the OLD bundle and sees "fails to replace the
  //     code and relaunch when user clicks install and relaunch".
  //
  // The full app handles this with the same guard at
  // `main.js:1884` (`if (global.isUpdatingApp) return`). Lite's
  // `lite/updater/install.ts` sets the same flag via
  // `setUpdatingFlag(true)` before `quitAndInstall()`; we honor it
  // here so the Squirrel handoff runs unobstructed and the system
  // teardowns are left to the OS as the process exits.
  if ((global as { isUpdatingApp?: boolean }).isUpdatingApp === true) {
    try {
      getLoggingApi().event('app.before-quit.skip-teardown', { reason: 'updating' });
    } catch {
      // intentional silent fallback during shutdown
    }
    return;
  }

  try {
    updaterHandle?.teardown();
  } catch {
    /* shutdown best-effort */
  }
  try {
    authHandle?.teardown();
  } catch {
    /* shutdown best-effort */
  }
  try {
    totpHandle?.teardown();
  } catch {
    /* shutdown best-effort */
  }
  try {
    settingsHandle?.teardown();
  } catch {
    /* shutdown best-effort */
  }
  try {
    helpHandle?.teardown();
  } catch {
    /* shutdown best-effort */
  }
  try {
    apiDocsHandle?.teardown();
  } catch {
    /* shutdown best-effort */
  }
  try {
    healthHandle?.teardown();
  } catch {
    /* shutdown best-effort */
  }
  try {
    neonHandle?.teardown();
  } catch {
    /* shutdown best-effort */
  }
  try {
    onboardingHandle?.teardown();
  } catch {
    /* shutdown best-effort */
  }
  try {
    aiRunTimesHandle?.teardown();
  } catch {
    /* shutdown best-effort */
  }
  try {
    universityHandle?.teardown();
  } catch {
    /* shutdown best-effort */
  }
  try {
    idwHandle?.teardown();
  } catch {
    /* shutdown best-effort */
  }
  try {
    toolsHandle?.teardown();
  } catch {
    /* shutdown best-effort */
  }
  try {
    mainWindowHandle?.teardown();
  } catch {
    /* shutdown best-effort */
  }
  try {
    eventBusHandle?.teardown();
  } catch {
    /* shutdown best-effort */
  }
  try {
    logServer.stop();
  } catch {
    /* shutdown best-effort */
  }
});
