/**
 * Calendar API (ADR-090) — the account's scheduled flows, read from GSX.
 *
 * What "scheduled" means here: a flow whose canvas carries the platform's
 * "Schedule execution" step. At activation that step registers its
 * schedule events (Quartz cron expressions in a time zone, a start and
 * an end) with the Event Manager, which fires the flow. The Event
 * Manager publishes no listing, so the flow definitions — the very data
 * the step hands it — are what this API reads: every bot's flows from
 * the datahub, scanned for the step (`schedule.ts`), expanded into
 * occurrences (`cron.ts`).
 *
 * Public surface: {@link CalendarApi}. Singleton accessors follow the
 * Rule-12 module contract (`getCalendarApi` / `configureCalendarApi` /
 * `_resetCalendarApiForTesting` / `_setCalendarApiForTesting`).
 */
import { getLoggingApi } from '../logging/api.js';
import { CALENDAR_EVENTS } from './events.js';
import { CalendarError } from './errors.js';
import { DatahubClient, type DatahubDeps } from './datahub.js';
import { expandOccurrences, scheduledFlowFrom, type FlowRecord } from './schedule.js';
import type { CalendarOccurrencesInput, CalendarOccurrencesResult, CalendarSnapshot, CalendarStatus, ScheduledFlow } from './types.js';

export { CalendarError } from './errors.js';

export interface CalendarApi {
  /** Every scheduled flow in the signed-in account (cached; `refresh` re-reads GSX). */
  snapshot(opts?: { refresh?: boolean }): Promise<CalendarSnapshot>;
  /** Scheduled runs within a window, ascending, capped. */
  occurrences(input: CalendarOccurrencesInput): Promise<CalendarOccurrencesResult>;
  /** Signed-in state and cache age, without a network call. */
  status(): CalendarStatus;
  /** Open the flow in GSX Designer (Lite's signed-in GSX window). */
  openFlow(input: { flowId: string; botId: string }): Promise<void>;
  /** Open (or focus) the Calendar window. */
  openWindow(): Promise<void>;
}

export interface CalendarServiceDeps {
  getSession: () => { env: string; accountId: string } | null;
  fetch: DatahubDeps['fetch'];
  openGsxWindow: (opts: { env: string; url: string; title: string }) => Promise<unknown>;
  openCalendarWindow: () => void;
  now?: () => number;
  /** Snapshot cache TTL (default 5 minutes). */
  cacheTtlMs?: number;
  /** Bots listed in parallel (default 4). */
  concurrency?: number;
}

const MAX_WINDOW_MS = 400 * 24 * 3600 * 1000;

export class CalendarService implements CalendarApi {
  private client: DatahubClient | null = null;
  private cache: CalendarSnapshot | null = null;
  private inflight: Promise<CalendarSnapshot> | null = null;
  private lastError: string | null = null;
  private readonly now: () => number;
  private readonly ttl: number;
  private readonly concurrency: number;

  constructor(private readonly deps: CalendarServiceDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.ttl = deps.cacheTtlMs ?? 5 * 60 * 1000;
    this.concurrency = Math.max(1, deps.concurrency ?? 4);
  }

  private session(): { env: string; accountId: string } {
    const s = this.deps.getSession();
    if (s === null || s.accountId.length === 0) {
      throw new CalendarError('CALENDAR_SIGNED_OUT', 'Sign in to GSX to see the scheduled flows of your account.', 'GSX menu → Open GSX Studio signs you in; the Calendar follows the session.');
    }
    return s;
  }

  private clientFor(s: { env: string; accountId: string }): DatahubClient {
    if (this.client === null || this.client.account !== s.accountId) {
      this.client = new DatahubClient(s.env, s.accountId, { fetch: this.deps.fetch, now: this.now });
      this.cache = null;
    }
    return this.client;
  }

  status(): CalendarStatus {
    const s = this.deps.getSession();
    return {
      signedIn: s !== null && s.accountId.length > 0,
      env: s?.env ?? null,
      accountId: s?.accountId ?? null,
      snapshotAgeMs: this.cache === null ? null : this.now() - this.cache.fetchedAtMs,
      lastError: this.lastError,
    };
  }

  async snapshot(opts: { refresh?: boolean } = {}): Promise<CalendarSnapshot> {
    const s = this.session();
    const client = this.clientFor(s);
    if (opts.refresh !== true && this.cache !== null && this.cache.accountId === s.accountId && this.now() - this.cache.fetchedAtMs < this.ttl) return this.cache;
    if (this.inflight !== null) return this.inflight;
    this.inflight = this.read(s, client).finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async read(s: { env: string; accountId: string }, client: DatahubClient): Promise<CalendarSnapshot> {
    const span = getLoggingApi().start('calendar.snapshot', { env: s.env });
    try {
      const [bots, deployments] = await Promise.all([client.listBots(), client.listActiveDeployments().catch((err: unknown) => { getLoggingApi().warn('calendar', 'active deployments unavailable; activation state unknown', { error: err instanceof Error ? err.message : String(err) }); return null; })]);
      const byFlow = new Map((deployments ?? []).map((d) => [d.flowId, d] as const));
      const scheduled: ScheduledFlow[] = [];
      const errors: CalendarSnapshot['errors'] = [];
      let flowCount = 0;
      const queue = [...bots];
      const worker = async (): Promise<void> => {
        for (let bot = queue.shift(); bot !== undefined; bot = queue.shift()) {
          try {
            const flows = await client.listFlows(bot.id);
            flowCount += flows.length;
            for (const raw of flows) {
              const sf = scheduledFlowFrom({ ...(raw as unknown as FlowRecord), botId: String(raw['botId'] ?? bot.id) }, bot.label);
              if (sf === null) continue;
              const dep = byFlow.get(sf.flowId);
              if (dep !== undefined) {
                const nowMs = this.now();
                const next = dep.scheduleTriggers.map((t) => t.timeoutMs).filter((t) => t > nowMs).sort((a, b) => a - b)[0];
                scheduled.push({ ...sf, active: true, armed: dep.scheduleTriggers.length > 0, activatedMs: dep.activatedMs, nextFireMs: next ?? null });
              } else scheduled.push(sf);
            }
          } catch (err) {
            errors.push({ botId: bot.id, botLabel: bot.label, message: err instanceof Error ? err.message : String(err) });
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(this.concurrency, Math.max(1, queue.length)) }, () => worker()));
      scheduled.sort((a, b) => a.botLabel.localeCompare(b.botLabel) || a.flowLabel.localeCompare(b.flowLabel));
      const snapshot: CalendarSnapshot = { env: s.env, accountId: s.accountId, fetchedAtMs: this.now(), botCount: bots.length, flowCount, activeDeployments: deployments?.length ?? 0, scheduled, errors };
      this.cache = snapshot;
      this.lastError = null;
      span.finish({ bots: bots.length, flows: flowCount, scheduled: scheduled.length, armed: scheduled.filter((f) => f.armed).length, events: scheduled.reduce((n, f) => n + f.events.length, 0), botErrors: errors.length });
      return snapshot;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      span.fail(err);
      throw err;
    }
  }

  async occurrences(input: CalendarOccurrencesInput): Promise<CalendarOccurrencesResult> {
    const fromMs = Number(input.fromMs);
    const toMs = Number(input.toMs);
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs < fromMs) throw new CalendarError('CALENDAR_INVALID_INPUT', 'The window needs fromMs ≤ toMs.');
    if (toMs - fromMs > MAX_WINDOW_MS) throw new CalendarError('CALENDAR_INVALID_INPUT', 'The window is capped at 400 days.');
    const snapshot = await this.snapshot(input.refresh === true ? { refresh: true } : {});
    const { occurrences, truncated } = expandOccurrences(snapshot.scheduled, fromMs, toMs);
    return { snapshot, occurrences, truncated };
  }

  async openFlow(input: { flowId: string; botId: string }): Promise<void> {
    const s = this.session();
    const flowId = String(input.flowId ?? '').trim();
    const botId = String(input.botId ?? '').trim();
    const ID = /^[A-Za-z0-9_.-]{1,128}$/;
    if (!ID.test(flowId) || !ID.test(botId)) throw new CalendarError('CALENDAR_INVALID_INPUT', 'A flow id and a bot id are needed to open the flow.');
    const label = this.cache?.scheduled.find((f) => f.flowId === flowId)?.flowLabel ?? flowId;
    getLoggingApi().event(CALENDAR_EVENTS.OPEN_FLOW, { flowId, botId });
    await this.deps.openGsxWindow({ env: s.env, url: `https://studio.${s.env}.onereach.ai/flows/${botId}/${flowId}`, title: `${label} — GSX Designer` });
  }

  async openWindow(): Promise<void> {
    getLoggingApi().event(CALENDAR_EVENTS.OPEN_WINDOW);
    this.deps.openCalendarWindow();
  }
}

// ── Singleton accessors (Rule 12 module contract) ─────────────────────
const METHODS: ReadonlyArray<keyof CalendarApi> = ['snapshot', 'occurrences', 'status', 'openFlow', 'openWindow'];

function notInitializedApi(): CalendarApi {
  const refuse = (name: string) => (): Promise<never> =>
    Promise.reject(new CalendarError('CALENDAR_NOT_INITIALIZED', `Calendar API not initialized (${name}).`, 'initCalendar() must run before the calendar is used.'));
  return {
    snapshot: refuse('snapshot'),
    occurrences: refuse('occurrences'),
    status: () => ({ signedIn: false, env: null, accountId: null, snapshotAgeMs: null, lastError: 'Calendar API not initialized.' }),
    openFlow: refuse('openFlow'),
    openWindow: refuse('openWindow'),
  };
}

let instance: CalendarApi | null = null;
let factory: (() => CalendarApi) | null = null;

/** Install the factory (called once by initCalendar); the instance is built lazily. */
export function configureCalendarApi(f: () => CalendarApi): void {
  factory = f;
  instance = null;
}
export function getCalendarApi(): CalendarApi {
  if (instance === null) instance = factory !== null ? factory() : notInitializedApi();
  return instance;
}
export function _resetCalendarApiForTesting(): void {
  instance = null;
}
export function _setCalendarApiForTesting(api: CalendarApi): void {
  instance = api;
}
export const CALENDAR_API_METHODS = METHODS;
