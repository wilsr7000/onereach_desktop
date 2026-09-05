/**
 * Calendar types (ADR-090) — the account's scheduled flows, as GSX
 * records them: a flow is scheduled when one of its steps is the
 * platform's "Schedule execution" step, whose data carries structured
 * schedule events (Quartz cron expressions in a time zone, a start and
 * an end, recurring or once).
 */

/** The platform step template that schedules a flow ("Schedule execution"). */
export const SCHEDULE_STEP_TEMPLATE_ID = '5d352cdd-6524-47d9-b612-061349152ddc';
export const SCHEDULE_STEP_LABEL = 'Schedule execution';

export interface ScheduleBound {
  /** YYYY-MM-DD in the event's time zone. */
  date: string;
  /** HH:mm or HH:mm:ss in the event's time zone. */
  time: string;
}

export interface ScheduleEvent {
  id: string;
  /** The event name the author gave it ("5min", "Nightly report"). */
  name: string;
  /** Hex colour from the schedule editor, or ''. */
  color: string;
  /** IANA time zone the expressions are evaluated in. */
  timeZone: string;
  /** Quartz cron expressions (min hour dom month dow [year], optionally with seconds first). */
  cron: string[];
  recurring: boolean;
  start: ScheduleBound | null;
  end: ScheduleBound | null;
  /** The editor's own plain-language summary ("Every 1st day"), or ''. */
  preview: string;
  /** Fires once when the flow is activated, in addition to the schedule. */
  runAtActivation: boolean;
}

export interface ScheduledFlow {
  flowId: string;
  botId: string;
  botLabel: string;
  flowLabel: string;
  /** The flow's description as authored in Designer ('' when none). */
  description: string;
  /** The flow has a deployed version. */
  deployed: boolean;
  /** Label of the scheduling step ("Schedule execution"). */
  stepLabel: string;
  events: ScheduleEvent[];
  /** Flow last modified (ms since epoch), 0 when unknown. */
  modifiedMs: number;
  /** An active deployment exists for the flow (it is running). */
  active: boolean;
  /** The active deployment carries a schedule trigger: the Event Manager will fire it. */
  armed: boolean;
  /** When the active deployment was created (ms), 0 when unknown. */
  activatedMs: number;
  /** The next fire time the platform recorded at activation (ms), null when none or past. */
  nextFireMs: number | null;
}

/** An active deployment as the datahub lists it (the fields the Calendar reads). */
export interface ActiveDeployment {
  id: string;
  flowId: string;
  botId: string;
  activatedMs: number;
  flowVersion: string;
  /** Timer triggers (name `timer/<flowId>/<stepId>/…`) with the recorded next fire time. */
  scheduleTriggers: Array<{ name: string; timeoutMs: number }>;
}

export interface CalendarSnapshot {
  env: string;
  accountId: string;
  fetchedAtMs: number;
  botCount: number;
  flowCount: number;
  /** Active deployments in the account (all flows, scheduled or not). */
  activeDeployments: number;
  /** How the scan got its answers (schedule index): bodies read vs answered from the index. */
  scan: { indexed: number; reused: number; fetched: number; bulk: number; dropped: number };
  scheduled: ScheduledFlow[];
  /** Per-bot listing failures (the rest of the snapshot is still good). */
  errors: Array<{ botId: string; botLabel: string; message: string }>;
}

export interface Occurrence {
  atMs: number;
  flowId: string;
  botId: string;
  botLabel: string;
  flowLabel: string;
  description: string;
  eventId: string;
  eventName: string;
  color: string;
  timeZone: string;
}

export interface CalendarOccurrencesInput {
  fromMs: number;
  toMs: number;
  refresh?: boolean;
}

export interface CalendarOccurrencesResult {
  snapshot: CalendarSnapshot;
  occurrences: Occurrence[];
  /** True when the window was cut at the occurrence cap. */
  truncated: boolean;
}

export interface CalendarStatus {
  signedIn: boolean;
  env: string | null;
  accountId: string | null;
  /** Age of the cached snapshot in ms, or null when none. */
  snapshotAgeMs: number | null;
  lastError: string | null;
}

export interface FlowLogSummaryInput {
  flowId: string;
  botId: string;
  /** The run's window (ms). */
  fromMs: number;
  toMs: number;
  refresh?: boolean;
}

export interface FlowLogSummaryResult {
  flowId: string;
  fromMs: number;
  toMs: number;
  summary: import('./logs.js').FlowLogSummary;
  /** Deterministic narrative, always present. */
  narrative: string;
  /** The model's narrative when a key is configured and the call worked. */
  aiNarrative: string | null;
  aiError?: string;
  truncated: boolean;
  fetchedAtMs: number;
}

export type CalendarErrorCode =
  | 'CALENDAR_SIGNED_OUT'
  | 'CALENDAR_TOKEN_FAILED'
  | 'CALENDAR_DISCOVERY_FAILED'
  | 'CALENDAR_HTTP_FAILED'
  | 'CALENDAR_INVALID_INPUT'
  | 'CALENDAR_NOT_INITIALIZED';
