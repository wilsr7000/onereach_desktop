/**
 * Calendar — main-process wiring (ADR-090): IPC for the Calendar window,
 * the window itself, and the door the GSX menu opens.
 */
import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import { CalendarError, CalendarService, configureCalendarApi, getCalendarApi, type CalendarApi, type IndexStore } from './api.js';
import { openCalendarWindow, closeCalendarWindow } from './window.js';
import type { CalendarOccurrencesInput } from './types.js';
import type { DatahubDeps } from './datahub.js';

export const CALENDAR_IPC = {
  SNAPSHOT: 'lite:calendar:snapshot',
  OCCURRENCES: 'lite:calendar:occurrences',
  STATUS: 'lite:calendar:status',
  OPEN_FLOW: 'lite:calendar:open-flow',
  OPEN_WINDOW: 'lite:calendar:open-window',
  SPACE_EVENTS: 'lite:calendar:space-events',
  FLOW_LOG_SUMMARY: 'lite:calendar:flow-log-summary',
} as const;

export interface CalendarIpcResult<T> {
  ok: boolean;
  value?: T;
  error?: { code: string; message: string; remediation: string };
}

export interface InitCalendarOptions {
  getSession: () => { env: string; accountId: string } | null;
  openGsxWindow: (opts: { env: string; url: string; title: string }) => Promise<unknown>;
  getMainWindow: () => BrowserWindow | null;
  htmlPath: string;
  preloadPath: string;
  /** Injectable for tests; defaults to the global fetch. */
  fetch?: DatahubDeps['fetch'];
  /** The schedule index store (local file + account KV in the app). */
  indexStore?: IndexStore;
  /** NEON for Space events (the Home tab's activity commits, sight-filtered). */
  query?: (cypher: string, parameters: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>;
  viewerId?: () => string | null;
  /** A chat completion for log narratives (optional). */
  ai?: { chat(input: { system?: string; messages: Array<{ role: 'user' | 'assistant'; content: string }>; maxTokens?: number }): Promise<{ content: string }> };
}

export interface CalendarHandle {
  open(): void;
  api: CalendarApi;
  dispose(): void;
}

function envelope<T>(fn: () => Promise<T> | T): Promise<CalendarIpcResult<T>> {
  return Promise.resolve()
    .then(fn)
    .then(
      (value) => ({ ok: true, value }),
      (err: unknown) => {
        if (err instanceof CalendarError) return { ok: false, error: { code: err.code, message: err.message, remediation: err.remediation } };
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, error: { code: 'CALENDAR_ERROR', message, remediation: 'Try again; if it persists, check the GSX sign-in.' } };
      }
    );
}

const s = (v: unknown): string => (typeof v === 'string' ? v : '');

export function initCalendar(opts: InitCalendarOptions): CalendarHandle {
  const open = (): void => {
    openCalendarWindow({ parent: opts.getMainWindow(), htmlPath: opts.htmlPath, preloadPath: opts.preloadPath });
  };
  const fetchImpl: DatahubDeps['fetch'] = opts.fetch ?? ((url, init) => fetch(url, init));
  const built = new CalendarService({ getSession: opts.getSession, fetch: fetchImpl, openGsxWindow: opts.openGsxWindow, openCalendarWindow: open, ...(opts.indexStore !== undefined ? { indexStore: opts.indexStore } : {}), ...(opts.query !== undefined ? { query: opts.query } : {}), ...(opts.viewerId !== undefined ? { viewerId: opts.viewerId } : {}), ...(opts.ai !== undefined ? { ai: opts.ai } : {}) });
  configureCalendarApi(() => built);
  const api = getCalendarApi();

  const handlers: Array<[string, (event: IpcMainInvokeEvent, payload?: Record<string, unknown>) => Promise<unknown>]> = [
    [CALENDAR_IPC.SNAPSHOT, (_e, p) => envelope(() => api.snapshot({ refresh: p?.['refresh'] === true }))],
    [CALENDAR_IPC.OCCURRENCES, (_e, p) => envelope(() => api.occurrences({ fromMs: Number(p?.['fromMs']), toMs: Number(p?.['toMs']), refresh: p?.['refresh'] === true } as CalendarOccurrencesInput))],
    [CALENDAR_IPC.STATUS, () => envelope(() => api.status())],
    [CALENDAR_IPC.OPEN_FLOW, (_e, p) => envelope(async () => { await api.openFlow({ flowId: s(p?.['flowId']), botId: s(p?.['botId']) }); return { ok: true as const }; })],
    [CALENDAR_IPC.OPEN_WINDOW, () => envelope(async () => { await api.openWindow(); return { ok: true as const }; })],
    [CALENDAR_IPC.SPACE_EVENTS, (_e, p) => envelope(() => api.spaceEvents({ fromMs: Number(p?.['fromMs']), toMs: Number(p?.['toMs']), timeZone: s(p?.['timeZone']), refresh: p?.['refresh'] === true }))],
    [CALENDAR_IPC.FLOW_LOG_SUMMARY, (_e, p) => envelope(() => api.flowLogSummary({ flowId: s(p?.['flowId']), botId: s(p?.['botId']), fromMs: Number(p?.['fromMs']), toMs: Number(p?.['toMs']), refresh: p?.['refresh'] === true }))],
  ];
  for (const [channel, handler] of handlers) ipcMain.handle(channel, handler);

  return {
    open,
    api,
    dispose: () => {
      for (const [channel] of handlers) ipcMain.removeHandler(channel);
      closeCalendarWindow();
    },
  };
}
