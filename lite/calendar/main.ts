/**
 * Calendar — main-process wiring (ADR-090): IPC for the Calendar window,
 * the window itself, and the door the GSX menu opens.
 */
import { BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { writeFile } from 'node:fs/promises';
import { getLoggingApi } from '../logging/api.js';
import { CalendarError, CalendarService, configureCalendarApi, getCalendarApi, type CalendarApi, type CalendarServiceDeps, type IndexStore } from './api.js';
import { CALENDAR_EVENTS } from './events.js';
import { buildIcs } from './ics.js';
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
  SET_ARMED: 'lite:calendar:set-armed',
  FLOW_LINKS: 'lite:calendar:flow-links',
  EXPORT_ICS: 'lite:calendar:export-ics',
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
  /** The account's KV (flow-build queue → playbook links). */
  kv?: CalendarServiceDeps['kv'];
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
  const built = new CalendarService({ getSession: opts.getSession, fetch: fetchImpl, openGsxWindow: opts.openGsxWindow, openCalendarWindow: open, ...(opts.indexStore !== undefined ? { indexStore: opts.indexStore } : {}), ...(opts.query !== undefined ? { query: opts.query } : {}), ...(opts.viewerId !== undefined ? { viewerId: opts.viewerId } : {}), ...(opts.ai !== undefined ? { ai: opts.ai } : {}), ...(opts.kv !== undefined ? { kv: opts.kv } : {}) });
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
    [CALENDAR_IPC.SET_ARMED, (_e, p) => envelope(() => api.setArmed({ flowId: s(p?.['flowId']), botId: s(p?.['botId']), armed: p?.['armed'] === true }))],
    [CALENDAR_IPC.FLOW_LINKS, (_e, p) => envelope(() => api.flowLinks({ flowId: s(p?.['flowId']), botLabel: s(p?.['botLabel']), refresh: p?.['refresh'] === true }))],
    [
      CALENDAR_IPC.EXPORT_ICS,
      (e, p) =>
        envelope(async () => {
          const fromMs = Number(p?.['fromMs']);
          const toMs = Number(p?.['toMs']);
          const armed = p?.['armed'] === 'armed' || p?.['armed'] === 'unarmed' ? p['armed'] : 'all';
          const res = await api.occurrences({ fromMs, toMs });
          const armedById = new Map(res.snapshot.scheduled.map((f) => [f.flowId, f.armed] as const));
          const runs = res.occurrences.filter((o) => armed === 'all' || (armed === 'armed') === (armedById.get(o.flowId) ?? true));
          const ics = buildIcs(runs, { name: s(p?.['name']) || 'Scheduled flows', nowMs: Date.now() });
          const start = new Date(fromMs);
          const dialogOptions = { defaultPath: `scheduled-flows-${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}.ics`, filters: [{ name: 'Calendar', extensions: ['ics'] }] };
          const parent = BrowserWindow.fromWebContents(e.sender);
          const picked = parent !== null ? await dialog.showSaveDialog(parent, dialogOptions) : await dialog.showSaveDialog(dialogOptions);
          if (picked.canceled || picked.filePath === undefined || picked.filePath.length === 0) return { saved: false, path: null, events: ics.events };
          await writeFile(picked.filePath, ics.text, 'utf8');
          getLoggingApi().event(CALENDAR_EVENTS.EXPORT_ICS, { events: ics.events, collapsed: ics.collapsed, armed, runs: runs.length });
          return { saved: true, path: picked.filePath, events: ics.events };
        }),
    ],
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
