/**
 * GSX automation main-process orchestration.
 *
 * Owns:
 *   - Wiring the electron window layer + userData persist dir +
 *     accountId provider into the electron-free `api.ts` singleton.
 *   - IPC handlers (`lite:gsx:*`) for the preload bridge.
 *
 * Envelope convention: main-window style -- handlers validate + throw
 * `GsxError`; the preload re-parses via its standard error handling.
 * Every handler emits a `gsx.ipc.<verb>` entry event (ADR-030).
 */

import { ipcMain } from 'electron';
import { getLoggingApi } from '../logging/api.js';
import { getAuthApi } from '../auth/api.js';
import { getSpacesApi } from '../spaces/api.js';
import {
  getGsxApi,
  setGsxAccountIdProvider,
  setGsxAgentPublisher,
  setGsxPersistDir,
  setGsxWindowPortFactory,
} from './api.js';
import { GSX_EVENTS } from './events.js';
import { createGsxWindowPort } from './window.js';
import type {
  GsxInvokeAgentOptions,
  GsxOpenWindowOptions,
  GsxRunScriptOptions,
  GsxScript,
  GsxStopRecordingAsAgentOptions,
  GsxStopRecordingOptions,
} from './types.js';

/** The core Space taught UI-automation agents are published into. */
const GSX_BUILD_SPACE_NAME = 'GSX Build';
/** Violet -- matches the distinct agent-asset rendering in Spaces. */
const GSX_BUILD_SPACE_COLOR = '#8b5cf6';

/**
 * Publish a taught agent as an agent asset in the "GSX Build" Space,
 * creating the Space on first use. Returns null when Spaces is
 * unavailable (signed out / not initialized) -- the caller records
 * that as "not published", never as a failure of the agent itself.
 */
async function publishAgentToGsxBuildSpace(input: {
  name: string;
  title: string;
  description: string;
  okf: string;
}): Promise<{ itemId: string } | null> {
  const spaces = getSpacesApi();
  const all = await spaces.listSpaces();
  let space = all.find((s) => s.name === GSX_BUILD_SPACE_NAME) ?? null;
  if (space === null) {
    space = await spaces.createSpace({
      name: GSX_BUILD_SPACE_NAME,
      description:
        'Taught UI-automation agents for the GSX studio -- recorded walkthroughs, callable by name through the Lite gsx API.',
      color: GSX_BUILD_SPACE_COLOR,
    });
  }
  const item = await spaces.items.createAgent({
    spaceId: space.id,
    name: input.title,
    okf: input.okf,
    agentType: 'workflow',
    description: input.description,
  });
  return { itemId: item.id };
}

const IPC_OPEN_WINDOW = 'lite:gsx:open-window';
const IPC_CLOSE_WINDOW = 'lite:gsx:close-window';
const IPC_LIST_WINDOWS = 'lite:gsx:list-windows';
const IPC_NAVIGATE = 'lite:gsx:navigate';
const IPC_SNAPSHOT = 'lite:gsx:snapshot';
const IPC_LIST_SCRIPTS = 'lite:gsx:list-scripts';
const IPC_GET_SCRIPT = 'lite:gsx:get-script';
const IPC_SAVE_SCRIPT = 'lite:gsx:save-script';
const IPC_DELETE_SCRIPT = 'lite:gsx:delete-script';
const IPC_RUN_SCRIPT = 'lite:gsx:run-script';
const IPC_LIST_RUNS = 'lite:gsx:list-runs';
const IPC_GET_RUN = 'lite:gsx:get-run';
const IPC_GET_STATS = 'lite:gsx:get-stats';
const IPC_START_RECORDING = 'lite:gsx:start-recording';
const IPC_STOP_RECORDING = 'lite:gsx:stop-recording';
const IPC_CANCEL_RECORDING = 'lite:gsx:cancel-recording';
const IPC_GET_RECORDING = 'lite:gsx:get-recording';
const IPC_STOP_RECORDING_AS_AGENT = 'lite:gsx:stop-recording-as-agent';
const IPC_INVOKE_AGENT = 'lite:gsx:invoke-agent';
const IPC_LIST_AGENTS = 'lite:gsx:list-agents';
const IPC_GET_AGENT = 'lite:gsx:get-agent';
const IPC_DELETE_AGENT = 'lite:gsx:delete-agent';

export interface GsxHandle {
  teardown(): void;
}

export interface InitGsxOptions {
  /** Absolute path of the app's userData dir (persistence root). */
  userDataDir: string;
}

let registered = false;

/**
 * Register IPC handlers + wire the window/auth/persistence seams.
 * Call once at app boot (after auth + logging are initialized).
 */
export function initGsx(opts: InitGsxOptions): GsxHandle {
  if (registered) return { teardown: () => undefined };
  registered = true;

  setGsxWindowPortFactory(createGsxWindowPort);
  setGsxPersistDir(opts.userDataDir);
  setGsxAccountIdProvider((env) => getAuthApi().getSession(env)?.accountId ?? null);
  setGsxAgentPublisher(publishAgentToGsxBuildSpace);

  const log = getLoggingApi();

  ipcMain.handle(IPC_OPEN_WINDOW, async (_event, input?: GsxOpenWindowOptions) => {
    log.event(GSX_EVENTS.IPC_OPEN_WINDOW);
    return getGsxApi().openWindow(input ?? {});
  });

  ipcMain.handle(IPC_CLOSE_WINDOW, async (_event, windowId: unknown) => {
    log.event(GSX_EVENTS.IPC_CLOSE_WINDOW);
    requireNonEmptyString(windowId, 'windowId');
    return getGsxApi().closeWindow(windowId as string);
  });

  ipcMain.handle(IPC_LIST_WINDOWS, async () => {
    log.event(GSX_EVENTS.IPC_LIST_WINDOWS);
    return getGsxApi().listWindows();
  });

  ipcMain.handle(IPC_NAVIGATE, async (_event, windowId: unknown, url: unknown) => {
    log.event(GSX_EVENTS.IPC_NAVIGATE);
    requireNonEmptyString(windowId, 'windowId');
    requireNonEmptyString(url, 'url');
    return getGsxApi().navigate(windowId as string, url as string);
  });

  ipcMain.handle(IPC_SNAPSHOT, async (_event, windowId: unknown) => {
    log.event(GSX_EVENTS.IPC_SNAPSHOT);
    requireNonEmptyString(windowId, 'windowId');
    return getGsxApi().snapshot(windowId as string);
  });

  ipcMain.handle(IPC_LIST_SCRIPTS, async () => {
    log.event(GSX_EVENTS.IPC_LIST_SCRIPTS);
    return getGsxApi().listScripts();
  });

  ipcMain.handle(IPC_GET_SCRIPT, async (_event, id: unknown) => {
    log.event(GSX_EVENTS.IPC_GET_SCRIPT);
    requireNonEmptyString(id, 'id');
    return getGsxApi().getScript(id as string);
  });

  ipcMain.handle(IPC_SAVE_SCRIPT, async (_event, script: unknown) => {
    log.event(GSX_EVENTS.IPC_SAVE_SCRIPT);
    // Structural validation happens in the store (validateScript).
    return getGsxApi().saveScript(script as GsxScript);
  });

  ipcMain.handle(IPC_DELETE_SCRIPT, async (_event, id: unknown) => {
    log.event(GSX_EVENTS.IPC_DELETE_SCRIPT);
    requireNonEmptyString(id, 'id');
    return getGsxApi().deleteScript(id as string);
  });

  ipcMain.handle(IPC_RUN_SCRIPT, async (_event, input: unknown) => {
    log.event(GSX_EVENTS.IPC_RUN_SCRIPT);
    const opts = input as GsxRunScriptOptions;
    requireNonEmptyString(opts?.scriptId, 'scriptId');
    return getGsxApi().runScript(opts);
  });

  ipcMain.handle(IPC_LIST_RUNS, async (_event, scriptId?: unknown) => {
    log.event(GSX_EVENTS.IPC_LIST_RUNS);
    if (scriptId !== undefined && scriptId !== null) {
      requireNonEmptyString(scriptId, 'scriptId');
      return getGsxApi().listRuns(scriptId as string);
    }
    return getGsxApi().listRuns();
  });

  ipcMain.handle(IPC_GET_RUN, async (_event, runId: unknown) => {
    log.event(GSX_EVENTS.IPC_GET_RUN);
    requireNonEmptyString(runId, 'runId');
    return getGsxApi().getRun(runId as string);
  });

  ipcMain.handle(IPC_GET_STATS, async (_event, scriptId?: unknown) => {
    log.event(GSX_EVENTS.IPC_GET_STATS);
    if (scriptId !== undefined && scriptId !== null) {
      requireNonEmptyString(scriptId, 'scriptId');
      return getGsxApi().getStats(scriptId as string);
    }
    return getGsxApi().getStats();
  });

  ipcMain.handle(IPC_START_RECORDING, async (_event, windowId: unknown) => {
    log.event(GSX_EVENTS.IPC_START_RECORDING);
    requireNonEmptyString(windowId, 'windowId');
    return getGsxApi().startRecording(windowId as string);
  });

  ipcMain.handle(IPC_STOP_RECORDING, async (_event, windowId: unknown, input: unknown) => {
    log.event(GSX_EVENTS.IPC_STOP_RECORDING);
    requireNonEmptyString(windowId, 'windowId');
    const opts = input as GsxStopRecordingOptions;
    requireNonEmptyString(opts?.scriptId, 'scriptId');
    requireNonEmptyString(opts?.title, 'title');
    requireNonEmptyString(opts?.description, 'description');
    return getGsxApi().stopRecording(windowId as string, opts);
  });

  ipcMain.handle(IPC_CANCEL_RECORDING, async (_event, windowId: unknown) => {
    log.event(GSX_EVENTS.IPC_CANCEL_RECORDING);
    requireNonEmptyString(windowId, 'windowId');
    return getGsxApi().cancelRecording(windowId as string);
  });

  ipcMain.handle(IPC_GET_RECORDING, async (_event, windowId: unknown) => {
    log.event(GSX_EVENTS.IPC_GET_RECORDING);
    requireNonEmptyString(windowId, 'windowId');
    return getGsxApi().getRecording(windowId as string);
  });

  ipcMain.handle(
    IPC_STOP_RECORDING_AS_AGENT,
    async (_event, windowId: unknown, input: unknown) => {
      log.event(GSX_EVENTS.IPC_STOP_RECORDING_AS_AGENT);
      requireNonEmptyString(windowId, 'windowId');
      const opts = input as GsxStopRecordingAsAgentOptions;
      requireNonEmptyString(opts?.name, 'name');
      return getGsxApi().stopRecordingAsAgent(windowId as string, opts);
    }
  );

  ipcMain.handle(IPC_INVOKE_AGENT, async (_event, name: unknown, input?: unknown) => {
    log.event(GSX_EVENTS.IPC_INVOKE_AGENT);
    requireNonEmptyString(name, 'name');
    return getGsxApi().invokeAgent(name as string, (input ?? {}) as GsxInvokeAgentOptions);
  });

  ipcMain.handle(IPC_LIST_AGENTS, async () => {
    log.event(GSX_EVENTS.IPC_LIST_AGENTS);
    return getGsxApi().listAgents();
  });

  ipcMain.handle(IPC_GET_AGENT, async (_event, name: unknown) => {
    log.event(GSX_EVENTS.IPC_GET_AGENT);
    requireNonEmptyString(name, 'name');
    return getGsxApi().getAgent(name as string);
  });

  ipcMain.handle(IPC_DELETE_AGENT, async (_event, name: unknown) => {
    log.event(GSX_EVENTS.IPC_DELETE_AGENT);
    requireNonEmptyString(name, 'name');
    return getGsxApi().deleteAgent(name as string);
  });

  return {
    teardown(): void {
      for (const channel of [
        IPC_OPEN_WINDOW,
        IPC_CLOSE_WINDOW,
        IPC_LIST_WINDOWS,
        IPC_NAVIGATE,
        IPC_SNAPSHOT,
        IPC_LIST_SCRIPTS,
        IPC_GET_SCRIPT,
        IPC_SAVE_SCRIPT,
        IPC_DELETE_SCRIPT,
        IPC_RUN_SCRIPT,
        IPC_LIST_RUNS,
        IPC_GET_RUN,
        IPC_GET_STATS,
        IPC_START_RECORDING,
        IPC_STOP_RECORDING,
        IPC_CANCEL_RECORDING,
        IPC_GET_RECORDING,
        IPC_STOP_RECORDING_AS_AGENT,
        IPC_INVOKE_AGENT,
        IPC_LIST_AGENTS,
        IPC_GET_AGENT,
        IPC_DELETE_AGENT,
      ]) {
        ipcMain.removeHandler(channel);
      }
      registered = false;
    },
  };
}

function requireNonEmptyString(value: unknown, field: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
}
