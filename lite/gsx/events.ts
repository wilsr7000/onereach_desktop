/**
 * GSX automation module event types -- per-module typed event surface
 * (ADR-032).
 *
 * Mirrors the catalog pattern in `lite/totp/events.ts`:
 *   1. A const-typed catalog (`GSX_EVENTS`) of every emitted name.
 *   2. A discriminated union (`GsxEvent`) for consumer ergonomics.
 *   3. `isGsxEvent(record)` type guard.
 *
 * The eval feedback loop is OBSERVABLE BY DESIGN: every run emits
 * `gsx.run.verdict`, every repair emits a `gsx.repair.*` span, and
 * learned-script promotion/demotion emit `gsx.script.learned` /
 * `gsx.script.invalidated` -- so the whole loop can be audited from
 * the event stream without reading module state.
 *
 * Adding an event requires updating BOTH the emit site and this file --
 * the `event-name-conformance` meta-test enforces correspondence.
 */

import type { EventRecord, SerializedEventError } from '../logging/events.js';

/** Stable event-name catalog. Source of truth for what gsx/ emits. */
export const GSX_EVENTS = {
  // Operation spans (base name -> .start/.finish/.fail).
  OPEN_WINDOW_START: 'gsx.open-window.start',
  OPEN_WINDOW_FINISH: 'gsx.open-window.finish',
  OPEN_WINDOW_FAIL: 'gsx.open-window.fail',
  RUN_SCRIPT_START: 'gsx.run-script.start',
  RUN_SCRIPT_FINISH: 'gsx.run-script.finish',
  RUN_SCRIPT_FAIL: 'gsx.run-script.fail',
  REPAIR_START: 'gsx.repair.start',
  REPAIR_FINISH: 'gsx.repair.finish',
  REPAIR_FAIL: 'gsx.repair.fail',
  RECORD_START: 'gsx.record.start',
  RECORD_FINISH: 'gsx.record.finish',
  RECORD_FAIL: 'gsx.record.fail',
  AGENT_INVOKE_START: 'gsx.agent-invoke.start',
  AGENT_INVOKE_FINISH: 'gsx.agent-invoke.finish',
  AGENT_INVOKE_FAIL: 'gsx.agent-invoke.fail',
  // Instant events -- the eval loop's audit trail.
  STEP_RESULT: 'gsx.step.result',
  RECORD_CANCELLED: 'gsx.record.cancelled',
  RECORD_GENERALIZED: 'gsx.record.generalized',
  AGENT_CREATED: 'gsx.agent.created',
  AGENT_DELETED: 'gsx.agent.deleted',
  AGENT_PUBLISHED: 'gsx.agent.published',
  RUN_VERDICT: 'gsx.run.verdict',
  SCRIPT_LEARNED: 'gsx.script.learned',
  SCRIPT_INVALIDATED: 'gsx.script.invalidated',
  WINDOW_CLOSED: 'gsx.window.closed',
  // IPC entry events (per ADR-030).
  IPC_OPEN_WINDOW: 'gsx.ipc.open-window',
  IPC_CLOSE_WINDOW: 'gsx.ipc.close-window',
  IPC_LIST_WINDOWS: 'gsx.ipc.list-windows',
  IPC_NAVIGATE: 'gsx.ipc.navigate',
  IPC_LIST_SCRIPTS: 'gsx.ipc.list-scripts',
  IPC_GET_SCRIPT: 'gsx.ipc.get-script',
  IPC_SAVE_SCRIPT: 'gsx.ipc.save-script',
  IPC_DELETE_SCRIPT: 'gsx.ipc.delete-script',
  IPC_RUN_SCRIPT: 'gsx.ipc.run-script',
  IPC_LIST_RUNS: 'gsx.ipc.list-runs',
  IPC_GET_RUN: 'gsx.ipc.get-run',
  IPC_GET_STATS: 'gsx.ipc.get-stats',
  IPC_SNAPSHOT: 'gsx.ipc.snapshot',
  IPC_START_RECORDING: 'gsx.ipc.start-recording',
  IPC_STOP_RECORDING: 'gsx.ipc.stop-recording',
  IPC_CANCEL_RECORDING: 'gsx.ipc.cancel-recording',
  IPC_GET_RECORDING: 'gsx.ipc.get-recording',
  IPC_STOP_RECORDING_AS_AGENT: 'gsx.ipc.stop-recording-as-agent',
  IPC_INVOKE_AGENT: 'gsx.ipc.invoke-agent',
  IPC_LIST_AGENTS: 'gsx.ipc.list-agents',
  IPC_GET_AGENT: 'gsx.ipc.get-agent',
  IPC_DELETE_AGENT: 'gsx.ipc.delete-agent',
} as const;

export type GsxEventName = (typeof GSX_EVENTS)[keyof typeof GSX_EVENTS];

interface GsxEventBase {
  id: string;
  timestamp: string;
  category: 'gsx';
}

interface GsxSpanBase extends GsxEventBase {
  spanId: string;
}

// ─── spans ──────────────────────────────────────────────────────────────

export interface GsxOpenWindowStartEvent extends GsxSpanBase {
  name: typeof GSX_EVENTS.OPEN_WINDOW_START;
  level: 'info';
  data?: { env?: string; url?: string };
}
export interface GsxOpenWindowFinishEvent extends GsxSpanBase {
  name: typeof GSX_EVENTS.OPEN_WINDOW_FINISH;
  level: 'info';
  durationMs: number;
  data?: { windowId?: string };
}
export interface GsxOpenWindowFailEvent extends GsxSpanBase {
  name: typeof GSX_EVENTS.OPEN_WINDOW_FAIL;
  level: 'error';
  durationMs: number;
  error: SerializedEventError;
}
export interface GsxRunScriptStartEvent extends GsxSpanBase {
  name: typeof GSX_EVENTS.RUN_SCRIPT_START;
  level: 'info';
  data?: { scriptId?: string; version?: number; source?: string; windowId?: string };
}
export interface GsxRunScriptFinishEvent extends GsxSpanBase {
  name: typeof GSX_EVENTS.RUN_SCRIPT_FINISH;
  level: 'info';
  durationMs: number;
  data?: { runId?: string; verdict?: string };
}
export interface GsxRunScriptFailEvent extends GsxSpanBase {
  name: typeof GSX_EVENTS.RUN_SCRIPT_FAIL;
  level: 'error';
  durationMs: number;
  error: SerializedEventError;
}
export interface GsxRepairStartEvent extends GsxSpanBase {
  name: typeof GSX_EVENTS.REPAIR_START;
  level: 'info';
  data?: { scriptId?: string; failedVersion?: number };
}
export interface GsxRepairFinishEvent extends GsxSpanBase {
  name: typeof GSX_EVENTS.REPAIR_FINISH;
  level: 'info';
  durationMs: number;
  data?: { learnedVersion?: number };
}
export interface GsxRepairFailEvent extends GsxSpanBase {
  name: typeof GSX_EVENTS.REPAIR_FAIL;
  level: 'error';
  durationMs: number;
  error: SerializedEventError;
}

export interface GsxRecordStartEvent extends GsxSpanBase {
  name: typeof GSX_EVENTS.RECORD_START;
  level: 'info';
  data?: { windowId?: string };
}
export interface GsxRecordFinishEvent extends GsxSpanBase {
  name: typeof GSX_EVENTS.RECORD_FINISH;
  level: 'info';
  durationMs: number;
  data?: { scriptId?: string; eventCount?: number; generalized?: boolean };
}
export interface GsxRecordFailEvent extends GsxSpanBase {
  name: typeof GSX_EVENTS.RECORD_FAIL;
  level: 'error';
  durationMs: number;
  error: SerializedEventError;
}

export interface GsxAgentInvokeStartEvent extends GsxSpanBase {
  name: typeof GSX_EVENTS.AGENT_INVOKE_START;
  level: 'info';
  data?: { agent?: string; hasDetails?: boolean };
}
export interface GsxAgentInvokeFinishEvent extends GsxSpanBase {
  name: typeof GSX_EVENTS.AGENT_INVOKE_FINISH;
  level: 'info';
  durationMs: number;
  data?: { agent?: string; runId?: string; verdict?: string };
}
export interface GsxAgentInvokeFailEvent extends GsxSpanBase {
  name: typeof GSX_EVENTS.AGENT_INVOKE_FAIL;
  level: 'error';
  durationMs: number;
  error: SerializedEventError;
}

// ─── instant events ─────────────────────────────────────────────────────

export interface GsxAgentCreatedEvent extends GsxEventBase {
  name: typeof GSX_EVENTS.AGENT_CREATED;
  level: 'info';
  data?: { agent?: string; scriptId?: string; paramCount?: number; described?: boolean };
}
export interface GsxAgentDeletedEvent extends GsxEventBase {
  name: typeof GSX_EVENTS.AGENT_DELETED;
  level: 'info';
  data?: { agent?: string };
}
export interface GsxAgentPublishedEvent extends GsxEventBase {
  name: typeof GSX_EVENTS.AGENT_PUBLISHED;
  level: 'info';
  data?: { agent?: string; spaceItemId?: string };
}
export interface GsxRecordCancelledEvent extends GsxEventBase {
  name: typeof GSX_EVENTS.RECORD_CANCELLED;
  level: 'info';
  data?: { windowId?: string; eventCount?: number; reason?: string };
}
export interface GsxRecordGeneralizedEvent extends GsxEventBase {
  name: typeof GSX_EVENTS.RECORD_GENERALIZED;
  level: 'info';
  data?: { scriptId?: string; params?: string[]; note?: string };
}
export interface GsxStepResultEvent extends GsxEventBase {
  name: typeof GSX_EVENTS.STEP_RESULT;
  level: 'info' | 'warn';
  data?: { scriptId?: string; index?: number; kind?: string; ok?: boolean; detail?: string };
}
export interface GsxRunVerdictEvent extends GsxEventBase {
  name: typeof GSX_EVENTS.RUN_VERDICT;
  level: 'info' | 'warn' | 'error';
  data?: {
    runId?: string;
    scriptId?: string;
    version?: number;
    source?: string;
    verdict?: string;
    durationMs?: number;
    failure?: string;
  };
}
export interface GsxScriptLearnedEvent extends GsxEventBase {
  name: typeof GSX_EVENTS.SCRIPT_LEARNED;
  level: 'info';
  data?: { scriptId?: string; version?: number };
}
export interface GsxScriptInvalidatedEvent extends GsxEventBase {
  name: typeof GSX_EVENTS.SCRIPT_INVALIDATED;
  level: 'warn';
  data?: { scriptId?: string; invalidatedVersion?: number; consecutiveFailures?: number };
}
export interface GsxWindowClosedEvent extends GsxEventBase {
  name: typeof GSX_EVENTS.WINDOW_CLOSED;
  level: 'info';
  data?: { windowId?: string };
}

// ─── IPC entry events ───────────────────────────────────────────────────

interface GsxIpcBase extends GsxEventBase {
  level: 'info';
}
export interface GsxIpcOpenWindowEvent extends GsxIpcBase {
  name: typeof GSX_EVENTS.IPC_OPEN_WINDOW;
}
export interface GsxIpcCloseWindowEvent extends GsxIpcBase {
  name: typeof GSX_EVENTS.IPC_CLOSE_WINDOW;
}
export interface GsxIpcListWindowsEvent extends GsxIpcBase {
  name: typeof GSX_EVENTS.IPC_LIST_WINDOWS;
}
export interface GsxIpcNavigateEvent extends GsxIpcBase {
  name: typeof GSX_EVENTS.IPC_NAVIGATE;
}
export interface GsxIpcListScriptsEvent extends GsxIpcBase {
  name: typeof GSX_EVENTS.IPC_LIST_SCRIPTS;
}
export interface GsxIpcGetScriptEvent extends GsxIpcBase {
  name: typeof GSX_EVENTS.IPC_GET_SCRIPT;
}
export interface GsxIpcSaveScriptEvent extends GsxIpcBase {
  name: typeof GSX_EVENTS.IPC_SAVE_SCRIPT;
}
export interface GsxIpcDeleteScriptEvent extends GsxIpcBase {
  name: typeof GSX_EVENTS.IPC_DELETE_SCRIPT;
}
export interface GsxIpcRunScriptEvent extends GsxIpcBase {
  name: typeof GSX_EVENTS.IPC_RUN_SCRIPT;
}
export interface GsxIpcListRunsEvent extends GsxIpcBase {
  name: typeof GSX_EVENTS.IPC_LIST_RUNS;
}
export interface GsxIpcGetRunEvent extends GsxIpcBase {
  name: typeof GSX_EVENTS.IPC_GET_RUN;
}
export interface GsxIpcGetStatsEvent extends GsxIpcBase {
  name: typeof GSX_EVENTS.IPC_GET_STATS;
}
export interface GsxIpcSnapshotEvent extends GsxIpcBase {
  name: typeof GSX_EVENTS.IPC_SNAPSHOT;
}
export interface GsxIpcStartRecordingEvent extends GsxIpcBase {
  name: typeof GSX_EVENTS.IPC_START_RECORDING;
}
export interface GsxIpcStopRecordingEvent extends GsxIpcBase {
  name: typeof GSX_EVENTS.IPC_STOP_RECORDING;
}
export interface GsxIpcCancelRecordingEvent extends GsxIpcBase {
  name: typeof GSX_EVENTS.IPC_CANCEL_RECORDING;
}
export interface GsxIpcGetRecordingEvent extends GsxIpcBase {
  name: typeof GSX_EVENTS.IPC_GET_RECORDING;
}
export interface GsxIpcStopRecordingAsAgentEvent extends GsxIpcBase {
  name: typeof GSX_EVENTS.IPC_STOP_RECORDING_AS_AGENT;
}
export interface GsxIpcInvokeAgentEvent extends GsxIpcBase {
  name: typeof GSX_EVENTS.IPC_INVOKE_AGENT;
}
export interface GsxIpcListAgentsEvent extends GsxIpcBase {
  name: typeof GSX_EVENTS.IPC_LIST_AGENTS;
}
export interface GsxIpcGetAgentEvent extends GsxIpcBase {
  name: typeof GSX_EVENTS.IPC_GET_AGENT;
}
export interface GsxIpcDeleteAgentEvent extends GsxIpcBase {
  name: typeof GSX_EVENTS.IPC_DELETE_AGENT;
}

/** Discriminated union of every typed GSX event. */
export type GsxEvent =
  | GsxOpenWindowStartEvent
  | GsxOpenWindowFinishEvent
  | GsxOpenWindowFailEvent
  | GsxRunScriptStartEvent
  | GsxRunScriptFinishEvent
  | GsxRunScriptFailEvent
  | GsxRepairStartEvent
  | GsxRepairFinishEvent
  | GsxRepairFailEvent
  | GsxRecordStartEvent
  | GsxRecordFinishEvent
  | GsxRecordFailEvent
  | GsxAgentInvokeStartEvent
  | GsxAgentInvokeFinishEvent
  | GsxAgentInvokeFailEvent
  | GsxAgentCreatedEvent
  | GsxAgentDeletedEvent
  | GsxAgentPublishedEvent
  | GsxRecordCancelledEvent
  | GsxRecordGeneralizedEvent
  | GsxStepResultEvent
  | GsxRunVerdictEvent
  | GsxScriptLearnedEvent
  | GsxScriptInvalidatedEvent
  | GsxWindowClosedEvent
  | GsxIpcOpenWindowEvent
  | GsxIpcCloseWindowEvent
  | GsxIpcListWindowsEvent
  | GsxIpcNavigateEvent
  | GsxIpcListScriptsEvent
  | GsxIpcGetScriptEvent
  | GsxIpcSaveScriptEvent
  | GsxIpcDeleteScriptEvent
  | GsxIpcRunScriptEvent
  | GsxIpcListRunsEvent
  | GsxIpcGetRunEvent
  | GsxIpcGetStatsEvent
  | GsxIpcSnapshotEvent
  | GsxIpcStartRecordingEvent
  | GsxIpcStopRecordingEvent
  | GsxIpcCancelRecordingEvent
  | GsxIpcGetRecordingEvent
  | GsxIpcStopRecordingAsAgentEvent
  | GsxIpcInvokeAgentEvent
  | GsxIpcListAgentsEvent
  | GsxIpcGetAgentEvent
  | GsxIpcDeleteAgentEvent;

const GSX_EVENT_NAMES: ReadonlySet<string> = new Set(Object.values(GSX_EVENTS));

/** Type guard: is this event record one of the GSX module's events? */
export function isGsxEvent(record: EventRecord): record is EventRecord & GsxEvent {
  return GSX_EVENT_NAMES.has(record.name);
}
