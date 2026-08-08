/**
 * GSX automation module -- PUBLIC API.
 *
 * The only file other lite modules should import from in this module.
 * Per ADR-019 / Rule 11 in `lite/LITE-RULES.md`, cross-module imports
 * go through `<module>/api.ts` -- never reach into `store.ts`,
 * `runner.ts`, `window.ts`, or any other internal file.
 *
 * What this module does
 * --------------------------------------------------------------------
 * Opens GSX studio windows (Designer, Flows, Files -- any
 * `studio.<env>.onereach.ai` surface) and drives their UI with
 * DETERMINISTIC SCRIPTS, wrapped in an evaluation feedback loop:
 *
 *   - Every script carries its own assertions; every run is graded
 *     (`pass` / `fail` / `error` / `repaired-pass` / `repaired-fail`).
 *   - A failing run snapshots the live page and asks the AI module
 *     (Claude, main-process key) to REPAIR the steps. A repaired
 *     script that passes is saved as a `learned` variant that shadows
 *     the seed -- so the next run replays deterministically, with no
 *     model call on the happy path.
 *   - A learned variant that keeps failing is demoted back to the
 *     seed. Every transition is a typed event (`gsx.run.verdict`,
 *     `gsx.script.learned`, `gsx.script.invalidated`).
 *
 * The LLM edits scripts; it never free-drives the page. Scripts are
 * JSON, auditable, and versioned; run records are the eval corpus.
 *
 * This file is deliberately electron-free so the conformance unit test
 * imports it under plain Node. The window layer (`window.ts`) is wired
 * in by `gsx/main.ts` (`initGsx`) via {@link setGsxWindowPortFactory};
 * userData comes in via {@link setGsxPersistDir}.
 *
 * Usage from another module (main process only):
 *
 *   import { getGsxApi } from '../gsx/api.js';
 *   const gsx = getGsxApi();
 *   const win = await gsx.openWindow({ env: 'edison' });
 *   const run = await gsx.runScript({ scriptId: 'designer.open' });
 *   if (run.verdict !== 'pass') console.warn(run.failure);
 *
 * Tests: `_setGsxApiForTesting(stub)` to inject a custom
 * implementation, `_resetGsxApiForTesting()` to clear the singleton.
 */

import { GsxStore, type GsxWindowPort } from './store.js';
import { getLoggingApi } from '../logging/api.js';
import { getAiApi } from '../ai/api.js';
import { isGsxEvent } from './events.js';
import { GsxError as GsxErrorClass, GSX_ERROR_CODES as CODES } from './errors.js';
import type { Environment } from '../auth/types.js';
import type {
  GsxAgent,
  GsxInvokeAgentOptions,
  GsxInvokeAgentResult,
  GsxOpenWindowOptions,
  GsxPageSnapshot,
  GsxRecordingStatus,
  GsxRunRecord,
  GsxRunScriptOptions,
  GsxScript,
  GsxScriptStats,
  GsxStopRecordingAsAgentOptions,
  GsxStopRecordingOptions,
  GsxWindowInfo,
} from './types.js';
import type { GsxEvent } from './events.js';

// Re-export the public types consumers need to typecheck calls.
export type {
  GsxScript,
  GsxScriptStep,
  GsxScriptSource,
  GsxScriptStats,
  GsxStepResult,
  GsxRunRecord,
  GsxRunVerdict,
  GsxRepairSummary,
  GsxPageSnapshot,
  GsxWindowInfo,
  GsxOpenWindowOptions,
  GsxRunScriptOptions,
  GsxStopRecordingOptions,
  GsxRecordingStatus,
  GsxAgent,
  GsxAgentParam,
  GsxStopRecordingAsAgentOptions,
  GsxInvokeAgentOptions,
  GsxInvokeAgentResult,
} from './types.js';
export {
  GSX_DEFAULT_STEP_TIMEOUT_MS,
  GSX_INVALIDATE_AFTER_CONSECUTIVE_FAILURES,
  GSX_MAX_RUN_RECORDS,
} from './types.js';
export { GSX_SEED_SCRIPTS } from './scripts.js';

// Re-export the structured error class + code catalog so consumers
// catch and branch via the public surface.
export type { GsxErrorCode, GsxErrorOptions } from './errors.js';
export { GsxError, GSX_ERROR_CODES } from './errors.js';

// Per-module typed event surface (ADR-032).
export {
  GSX_EVENTS,
  isGsxEvent,
  type GsxEvent,
  type GsxEventName,
} from './events.js';

// Generic base class -- consumers can also catch via `instanceof LiteError`.
export { LiteError, isLiteError } from '../errors.js';

/**
 * The public surface of the GSX automation module. All cross-module
 * callers (and, via IPC + the preload bridge, renderers) route through
 * this interface.
 *
 * **Error contract**: methods throw {@link GsxError} (extends
 * `LiteError`). Branch on `.code`: `GSX_UNSUPPORTED_ENV`,
 * `GSX_WINDOW_NOT_FOUND`, `GSX_SCRIPT_NOT_FOUND`, `GSX_INVALID_SCRIPT`,
 * `GSX_RUN_NOT_FOUND`, `GSX_URL_NOT_ALLOWED`, `GSX_NAVIGATION_FAILED`,
 * `GSX_SEED_READ_ONLY`. Repair-path failures never throw out of
 * `runScript` -- they land in the run record's `repair` summary.
 *
 * See `lite/gsx/README.md` for the script format and eval-loop recipe.
 */
export interface GsxApi {
  /**
   * Open a GSX window. The URL defaults to the studio root for the env
   * (with `?accountId=<signed-in account>`); relative paths resolve
   * against `https://studio.<env>.onereach.ai`. Auth cookies are
   * injected into the window's partition BEFORE navigation (ADR-042),
   * so a signed-in user lands authenticated.
   */
  openWindow(opts?: GsxOpenWindowOptions): Promise<GsxWindowInfo>;

  /** Close a GSX window. `{ closed: false }` when the id is unknown. */
  closeWindow(windowId: string): Promise<{ closed: boolean }>;

  /** List the open GSX windows. */
  listWindows(): Promise<GsxWindowInfo[]>;

  /** Navigate an open window (same URL resolution + auth as openWindow). */
  navigate(windowId: string, url: string): Promise<GsxWindowInfo>;

  /**
   * Census of the window's interactive elements (capped at 150). This
   * is the same picture the repair LLM sees -- useful for authoring
   * new script selectors against the live UI.
   */
  snapshot(windowId: string): Promise<GsxPageSnapshot>;

  /**
   * List the EFFECTIVE scripts: learned/custom variants shadow the
   * seed with the same id; untouched seeds appear as-is.
   */
  listScripts(): Promise<GsxScript[]>;

  /** Get the effective script for an id. Throws `GSX_SCRIPT_NOT_FOUND`. */
  getScript(id: string): Promise<GsxScript>;

  /**
   * Register or update a script. `source` must be `learned` (seeds are
   * read-only; a learned script with a seed's id shadows it). The
   * script passes the same structural validation the AI repair output
   * does. Throws `GSX_INVALID_SCRIPT` / `GSX_SEED_READ_ONLY`.
   */
  saveScript(script: GsxScript): Promise<GsxScript>;

  /**
   * Delete a learned/custom script. Deleting a learned variant reverts
   * its id to the seed. Throws `GSX_SEED_READ_ONLY` for seed ids.
   */
  deleteScript(id: string): Promise<{ deleted: boolean }>;

  /**
   * Run a script and grade it -- the heart of the module. Opens a
   * window when `windowId` is omitted. On a failing run (and unless
   * `repair: false`), snapshots the page, asks the AI module to repair
   * the steps, re-runs, and promotes a passing repair to a `learned`
   * variant. The returned {@link GsxRunRecord} carries the verdict,
   * per-step results, and the repair summary.
   */
  runScript(opts: GsxRunScriptOptions): Promise<GsxRunRecord>;

  /**
   * TEACH MODE. Start recording the user's own navigation in an open
   * GSX window. A page-side recorder captures every click and final
   * input value with ranked selector candidates and human labels
   * (aria-label / <label> / placeholder); the main process drains it
   * on a poll and tracks navigations. Idempotent per window.
   */
  startRecording(windowId: string): Promise<GsxRecordingStatus>;

  /** Live recording status for a window (recording + event count). */
  getRecording(windowId: string): Promise<GsxRecordingStatus>;

  /**
   * Finish a recording and save it as a `learned` template script.
   * The recorded actions become deterministic steps (best selector +
   * text fallback, `{accountId}`/`{env}` back-substituted, a final
   * `assertUrl` pinning the destination). Unless `generalize: false`,
   * the AI module then promotes content-specific literals -- the item
   * you clicked, the text you typed -- to NAMED `{param}` placeholders
   * derived from the elements' labels, so the template can click
   * DIFFERENT elements on replay (`runScript({ params })`). If
   * generalization fails, the deterministic recording is saved as-is.
   * Throws `GSX_NOT_RECORDING` / `GSX_EMPTY_RECORDING` /
   * `GSX_INVALID_SCRIPT` / `GSX_SEED_READ_ONLY`.
   */
  stopRecording(windowId: string, opts: GsxStopRecordingOptions): Promise<GsxScript>;

  /** Abandon a recording without saving. `{ cancelled: false }` when idle. */
  cancelRecording(windowId: string): Promise<{ cancelled: boolean }>;

  /**
   * UI-AUTOMATION AGENTS (ADR-054). Finish a recording as a NAMED
   * agent: the system -- not the user -- writes the agent's title,
   * description, and per-param descriptions from the recording, in the
   * same model call that generalizes the steps into a `{param}`
   * template. The agent is callable by name via {@link invokeAgent}
   * and (best-effort) published as an OKF asset into the "GSX Build"
   * Space. Without AI, the agent still exists with a slug-derived
   * title and placeholder-scanned params.
   */
  stopRecordingAsAgent(
    windowId: string,
    opts: GsxStopRecordingAsAgentOptions
  ): Promise<GsxAgent>;

  /**
   * Invoke an agent by name. Pass free-form `details` and the agent's
   * param descriptions are used to extract values from it ("open the
   * billing bot flow" -> `{ flowName: "Billing Bot" }`); structured
   * `params` merge over extraction. Missing params throw
   * `GSX_MISSING_PARAMS` naming them. The run itself goes through the
   * standard graded/repaired loop.
   */
  invokeAgent(name: string, opts?: GsxInvokeAgentOptions): Promise<GsxInvokeAgentResult>;

  /** All registered UI-automation agents. */
  listAgents(): Promise<GsxAgent[]>;

  /** One agent by name. Throws `GSX_AGENT_NOT_FOUND`. */
  getAgent(name: string): Promise<GsxAgent>;

  /** Delete an agent and its learned script. Soft when unknown. */
  deleteAgent(name: string): Promise<{ deleted: boolean }>;

  /** Run history, newest first (capped ring buffer). */
  listRuns(scriptId?: string): Promise<GsxRunRecord[]>;

  /** One run record. Throws `GSX_RUN_NOT_FOUND`. */
  getRun(runId: string): Promise<GsxRunRecord>;

  /** Per-script health: runs/passes/failures/consecutive failures. */
  getStats(scriptId?: string): Promise<GsxScriptStats[]>;

  /**
   * Subscribe to typed GSX events (ADR-032): run verdicts, step
   * results, learned/invalidated transitions, window lifecycle.
   * Returns an unsubscribe function.
   */
  onEvent(handler: (event: GsxEvent) => void): () => void;
}

let _instance: GsxApi | null = null;
let _windowPortFactory: (() => GsxWindowPort) | null = null;
let _windowPort: GsxWindowPort | null = null;
let _persistDir: string | null = null;
let _accountIdProvider: ((env: Environment) => string | null) | null = null;
let _agentPublisher:
  | ((input: {
      name: string;
      title: string;
      description: string;
      okf: string;
    }) => Promise<{ itemId: string } | null>)
  | null = null;

/**
 * Wire the production window layer. Called by `initGsx` in the main
 * process (`window.ts` imports electron; this file must not). Until
 * it's called, window-touching methods throw `GSX_WINDOW_NOT_FOUND`
 * via the port guard below.
 */
export function setGsxWindowPortFactory(factory: (() => GsxWindowPort) | null): void {
  _windowPortFactory = factory;
  _windowPort = null;
}

/** Point persistence at the app's userData directory. Called by `initGsx`. */
export function setGsxPersistDir(dir: string | null): void {
  _persistDir = dir;
}

/**
 * Provide the signed-in accountId resolver (from the auth module).
 * Injected by `initGsx` so this file stays importable without pulling
 * the auth store into the conformance test.
 */
export function setGsxAccountIdProvider(
  fn: ((env: Environment) => string | null) | null
): void {
  _accountIdProvider = fn;
}

/**
 * Provide the "publish to the GSX Build Space" implementation (from
 * the spaces module). Injected by `initGsx` so this file stays free of
 * a spaces import; publication is best-effort decoration either way.
 */
export function setGsxAgentPublisher(
  fn:
    | ((input: {
        name: string;
        title: string;
        description: string;
        okf: string;
      }) => Promise<{ itemId: string } | null>)
    | null
): void {
  _agentPublisher = fn;
}

export function getGsxApi(): GsxApi {
  if (_instance === null) {
    _instance = buildDefaultApi();
  }
  return _instance;
}

/** Reset the singleton (for tests). */
export function _resetGsxApiForTesting(): void {
  _instance = null;
  _windowPort = null;
}

/**
 * Override the singleton with a custom implementation (for tests). The
 * provided value is returned by subsequent `getGsxApi()` calls until
 * reset.
 */
export function _setGsxApiForTesting(api: GsxApi): void {
  _instance = api;
}

function resolveWindowPort(): GsxWindowPort {
  if (_windowPort !== null) return _windowPort;
  if (_windowPortFactory === null) {
    // Reachable only before initGsx() ran (or in tests that didn't
    // inject a port). Surfaced as a structured error, not a crash.
    throw new GsxErrorClass({
      code: CODES.WINDOW_NOT_FOUND,
      message: 'GSX window layer is not initialized (initGsx has not run)',
      remediation: 'Restart the app; if this persists, file a bug report.',
    });
  }
  _windowPort = _windowPortFactory();
  return _windowPort;
}

/**
 * Default store config -- routes logs/events through the lite logging
 * module (ADR-025/030), chat through the AI module, and windows
 * through the port `initGsx` wired.
 */
function buildDefaultApi(): GsxApi {
  return new GsxStore({
    logger: (level, message, data) => {
      getLoggingApi()[level]('gsx', message, data);
    },
    spanEmitter: (name, data) => getLoggingApi().start(name, data),
    eventEmitter: (name, data, level) => getLoggingApi().event(name, data, level ?? 'info'),
    eventSubscribe: (handler) =>
      getLoggingApi().onEvent('gsx.*', (record) => {
        if (isGsxEvent(record)) handler(record);
      }),
    windowPort: resolveWindowPort,
    chat: () => {
      // Repair is optional: when the AI module isn't configured the
      // chat call itself would throw AI_NOT_CONFIGURED; the store
      // records that as a skipped repair rather than failing the run.
      const ai = getAiApi();
      return (input) => ai.chat(input);
    },
    accountId: (env) => (_accountIdProvider !== null ? _accountIdProvider(env) : null),
    persistDir: () => _persistDir,
    publishAgent: (input) =>
      _agentPublisher !== null ? _agentPublisher(input) : Promise.resolve(null),
  });
}
