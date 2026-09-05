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
import { DatahubClient, flowHeadOf, type DatahubDeps } from './datahub.js';
import { dropFlows, emptyIndex, indexStats, parseIndex, planScan, recordFlow, scheduledFromIndex, type FlowHead, type ScheduleIndex } from './index.js';
import { expandOccurrences, scheduledFlowFrom, type FlowRecord } from './schedule.js';
import { logExcerpt, narrativeOf, parseLogEvent, summarizeFlowLogs, type FlowLogLine } from './logs.js';
import { SPACE_EVENTS_CYPHER, SPACE_EVENTS_LIMIT, groupSpaceEventsByDay, rowToSpaceEvent, type SpaceEvent, type SpaceEventsInput, type SpaceEventsResult } from './space-events.js';
import type { CalendarOccurrencesInput, CalendarOccurrencesResult, CalendarSnapshot, CalendarStatus, FlowLogSummaryInput, FlowLogSummaryResult, ScheduledFlow } from './types.js';

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
  /** Space events (activity commits the viewer may see) in a window, grouped per local day and per Space. */
  spaceEvents(input: SpaceEventsInput): Promise<SpaceEventsResult>;
  /** Log summary for one past run window, fetched from the deployer only when asked (a button), with an optional model narrative. */
  flowLogSummary(input: FlowLogSummaryInput): Promise<FlowLogSummaryResult>;
}

/** Where the schedule index lives (local file, the account's KV, or both). */
export interface IndexStore {
  load(accountId: string): Promise<unknown | null>;
  save(accountId: string, index: ScheduleIndex): Promise<void>;
}

export interface CalendarServiceDeps {
  getSession: () => { env: string; accountId: string } | null;
  /** The schedule index: which flow versions do and do not carry a schedule. Memory-only when absent. */
  indexStore?: IndexStore;
  /** NEON, for Space events; absent = the calendar shows flows only. `$viewerId` / `$nowMs` are injected here. */
  query?: (cypher: string, parameters: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>;
  viewerId?: () => string | null;
  fetch: DatahubDeps['fetch'];
  openGsxWindow: (opts: { env: string; url: string; title: string }) => Promise<unknown>;
  openCalendarWindow: () => void;
  now?: () => number;
  /** Snapshot cache TTL (default 5 minutes). */
  cacheTtlMs?: number;
  /** Bots listed in parallel (default 4). */
  concurrency?: number;
  /** A chat completion for log narratives; absent = deterministic narrative only. */
  ai?: { chat(input: { system?: string; messages: Array<{ role: 'user' | 'assistant'; content: string }>; maxTokens?: number }): Promise<{ content: string }> };
}

const MAX_WINDOW_MS = 400 * 24 * 3600 * 1000;

export class CalendarService implements CalendarApi {
  private client: DatahubClient | null = null;
  private index: ScheduleIndex | null = null;
  private cache: CalendarSnapshot | null = null;
  private eventsCache: { key: string; result: SpaceEventsResult } | null = null;
  private readonly logCache = new Map<string, FlowLogSummaryResult>();
  private inflight: Promise<CalendarSnapshot> | null = null;
  private lastError: string | null = null;
  private readonly now: () => number;
  private readonly ttl: number;
  private readonly concurrency: number;

  constructor(private readonly deps: CalendarServiceDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.ttl = deps.cacheTtlMs ?? 5 * 60 * 1000;
    this.concurrency = Math.max(1, deps.concurrency ?? 6);
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
      this.index = null;
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
      const index = await this.loadIndex(s.accountId);
      const [bots, deployments] = await Promise.all([client.listBots(), client.listActiveDeployments().catch((err: unknown) => { getLoggingApi().warn('calendar', 'active deployments unavailable; activation state unknown', { error: err instanceof Error ? err.message : String(err) }); return null; })]);
      const byFlow = new Map((deployments ?? []).map((d) => [d.flowId, d] as const));
      const scan = { indexed: 0, reused: 0, fetched: 0, bulk: 0, dropped: 0 };
      let indexChanged = false;
      const listedBots = new Set<string>();
      const heads: FlowHead[] = [];
      const scheduled: ScheduledFlow[] = [];
      const errors: CalendarSnapshot['errors'] = [];
      let flowCount = 0;
      const queue = [...bots];
      const worker = async (): Promise<void> => {
        for (let bot = queue.shift(); bot !== undefined; bot = queue.shift()) {
          try {
            const known = Object.values(index.flows).some((e) => e.botId === bot.id);
            if (!known) {
              // Cold space: one bulk listing (main-tree steps projected) fills the index.
              const flows = await client.listFlows(bot.id);
              flowCount += flows.length;
              for (const raw of flows) {
                const head = flowHeadOf(raw, bot.id);
                const sf = await this.examine(client, raw, head, bot.label);
                scan.bulk += 1;
                if (recordFlow(index, head, sf, this.now())) indexChanged = true;
                heads.push(head);
                if (sf !== null) scheduled.push(sf);
              }
            } else {
              // Warm space: heads only; the index answers for versions it has seen.
              const list = await client.listFlowHeads(bot.id);
              flowCount += list.length;
              const plan = planScan(index, list, new Set([bot.id]));
              heads.push(...list);
              for (const h of plan.reuse) {
                scan.reused += 1;
                const e = index.flows[h.id];
                if (e === undefined) continue;
                const sf = scheduledFromIndex(h.id, e, bot.label);
                if (sf !== null) scheduled.push(sf);
              }
              for (const h of plan.fetch) {
                const full = await client.getFlow(h.id);
                scan.fetched += 1;
                const sf = full === null ? null : scheduledFlowFrom({ ...(full as unknown as FlowRecord), botId: h.botId }, bot.label);
                if (recordFlow(index, h, sf, this.now())) indexChanged = true;
                if (sf !== null) scheduled.push(sf);
              }
            }
            listedBots.add(bot.id);
          } catch (err) {
            errors.push({ botId: bot.id, botLabel: bot.label, message: err instanceof Error ? err.message : String(err) });
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(this.concurrency, Math.max(1, queue.length)) }, () => worker()));
      // Flows gone from a space that listed fine are gone from the index too.
      const drop = planScan(index, heads, listedBots).drop;
      if (dropFlows(index, drop, this.now())) indexChanged = true;
      scan.dropped = drop.length;
      scan.indexed = indexStats(index).flows;
      if (indexChanged && this.deps.indexStore !== undefined) {
        await this.deps.indexStore.save(s.accountId, index).catch((err: unknown) => getLoggingApi().warn('calendar', 'schedule index not saved', { error: err instanceof Error ? err.message : String(err) }));
      }
      // Activation state from the deployments.
      for (let i = 0; i < scheduled.length; i += 1) {
        const sf = scheduled[i];
        if (sf === undefined) continue;
        const dep = byFlow.get(sf.flowId);
        if (dep === undefined) continue;
        const nowMs = this.now();
        const next = dep.scheduleTriggers.map((t) => t.timeoutMs).filter((t) => t > nowMs).sort((a, b) => a - b)[0];
        scheduled[i] = { ...sf, active: true, armed: dep.scheduleTriggers.length > 0, activatedMs: dep.activatedMs, nextFireMs: next ?? null };
      }
      scheduled.sort((a, b) => a.botLabel.localeCompare(b.botLabel) || a.flowLabel.localeCompare(b.flowLabel));
      const snapshot: CalendarSnapshot = { env: s.env, accountId: s.accountId, fetchedAtMs: this.now(), botCount: bots.length, flowCount, activeDeployments: deployments?.length ?? 0, scan, scheduled, errors };
      this.cache = snapshot;
      this.lastError = null;
      span.finish({ bots: bots.length, flows: flowCount, scheduled: scheduled.length, armed: scheduled.filter((f) => f.armed).length, events: scheduled.reduce((n, f) => n + f.events.length, 0), botErrors: errors.length, ...scan });
      return snapshot;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      span.fail(err);
      throw err;
    }
  }

  /** The account's schedule index: memory, else the store, else empty. */
  private async loadIndex(accountId: string): Promise<ScheduleIndex> {
    if (this.index !== null && this.index.accountId === accountId) return this.index;
    let loaded: ScheduleIndex | null = null;
    if (this.deps.indexStore !== undefined) {
      try {
        loaded = parseIndex(await this.deps.indexStore.load(accountId), accountId);
      } catch (err) {
        getLoggingApi().warn('calendar', 'schedule index not loaded; starting cold', { error: err instanceof Error ? err.message : String(err) });
      }
    }
    this.index = loaded ?? emptyIndex(accountId, this.now());
    return this.index;
  }

  /**
   * A bulk-listed flow is projected to its main tree; when that shows no
   * schedule but the flow has other trees (~6%), the body is fetched whole.
   */
  private async examine(client: DatahubClient, raw: Record<string, unknown>, head: FlowHead, botLabel: string): Promise<ScheduledFlow | null> {
    const record: FlowRecord = { ...(raw as unknown as FlowRecord), botId: head.botId };
    const sf = scheduledFlowFrom(record, botLabel);
    if (sf !== null || !Object.keys(record.data?.trees ?? {}).some((t) => t !== 'main')) return sf;
    const full = await client.getFlow(head.id).catch(() => null);
    return full === null ? null : scheduledFlowFrom({ ...(full as unknown as FlowRecord), botId: head.botId }, botLabel);
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

  async flowLogSummary(input: FlowLogSummaryInput): Promise<FlowLogSummaryResult> {
    const s = this.session();
    const client = this.clientFor(s);
    const flowId = String(input.flowId ?? '').trim();
    const fromMs = Number(input.fromMs);
    const toMs = Number(input.toMs);
    if (!/^[A-Za-z0-9_.-]{1,128}$/.test(flowId)) throw new CalendarError('CALENDAR_INVALID_INPUT', 'A flow id is needed for a log summary.');
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs < fromMs) throw new CalendarError('CALENDAR_INVALID_INPUT', 'The run window needs fromMs ≤ toMs.');
    if (toMs - fromMs > 7 * 24 * 3600 * 1000) throw new CalendarError('CALENDAR_INVALID_INPUT', 'A log window is capped at 7 days.');
    const key = `${flowId}:${fromMs}:${toMs}`;
    const cached = this.logCache.get(key);
    if (input.refresh !== true && cached !== undefined && this.now() - cached.fetchedAtMs < 5 * 60_000) return cached;
    const span = getLoggingApi().start('calendar.flow-logs', { flowId, fromMs, toMs });
    try {
      const { events, truncated } = await client.fetchFlowLogs(flowId, fromMs, toMs);
      const lines: FlowLogLine[] = [];
      for (const e of events) {
        const l = parseLogEvent(e);
        if (l !== null) lines.push(l);
      }
      const summary = summarizeFlowLogs(lines);
      const narrative = narrativeOf(summary);
      let aiNarrative: string | null = null;
      let aiError: string | undefined;
      if (this.deps.ai !== undefined && summary.lines > 0) {
        try {
          const label = this.cache?.scheduled.find((f) => f.flowId === flowId)?.flowLabel ?? flowId;
          const res = await this.deps.ai.chat({
            system: 'You summarise the logs of one scheduled automation run for its owner. Three sentences at most, plain language, no markdown: what ran, whether it succeeded, and anything that needs attention. If the logs show errors, name the first one. Do not invent details that are not in the logs.',
            messages: [{ role: 'user', content: `Flow: ${label}\nWindow: ${new Date(fromMs).toISOString()} to ${new Date(toMs).toISOString()}\nDeterministic summary: ${narrative}\n\nLog excerpt (vitals omitted):\n${logExcerpt(lines)}` }],
            maxTokens: 300,
          });
          aiNarrative = res.content.trim().slice(0, 1200) || null;
        } catch (err) {
          aiError = err instanceof Error ? err.message : String(err);
        }
      }
      const result: FlowLogSummaryResult = { flowId, fromMs, toMs, summary, narrative, aiNarrative, ...(aiError !== undefined ? { aiError } : {}), truncated, fetchedAtMs: this.now() };
      this.logCache.set(key, result);
      span.finish({ lines: summary.lines, executions: summary.executions.length, errors: summary.errorCount, ai: aiNarrative !== null });
      return result;
    } catch (err) {
      span.fail(err);
      throw err;
    }
  }

  async spaceEvents(input: SpaceEventsInput): Promise<SpaceEventsResult> {
    const fromMs = Number(input.fromMs);
    const toMs = Number(input.toMs);
    const timeZone = typeof input.timeZone === 'string' && input.timeZone.length > 0 ? input.timeZone : 'UTC';
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs < fromMs) throw new CalendarError('CALENDAR_INVALID_INPUT', 'The window needs fromMs ≤ toMs.');
    if (toMs - fromMs > MAX_WINDOW_MS) throw new CalendarError('CALENDAR_INVALID_INPUT', 'The window is capped at 400 days.');
    const key = `${fromMs}:${toMs}:${timeZone}`;
    if (input.refresh !== true && this.eventsCache !== null && this.eventsCache.key === key && this.now() - this.eventsCache.result.fetchedAtMs < 60_000) return this.eventsCache.result;
    const empty = (unavailable: boolean): SpaceEventsResult => ({ events: [], days: [], total: 0, truncated: false, fetchedAtMs: this.now(), unavailable });
    if (this.deps.query === undefined) return empty(true);
    const span = getLoggingApi().start('calendar.space-events', { fromMs, toMs });
    try {
      const rows = await this.deps.query(SPACE_EVENTS_CYPHER, { fromMs, toMs, limit: SPACE_EVENTS_LIMIT, viewerId: (this.deps.viewerId?.() ?? '').trim().toLowerCase(), nowMs: this.now() });
      const events: SpaceEvent[] = [];
      for (const r of rows) {
        const e = rowToSpaceEvent(r);
        if (e !== null) events.push(e);
      }
      const result: SpaceEventsResult = { events, days: groupSpaceEventsByDay(events, timeZone), total: events.length, truncated: rows.length >= SPACE_EVENTS_LIMIT, fetchedAtMs: this.now(), unavailable: false };
      this.eventsCache = { key, result };
      span.finish({ events: events.length, days: result.days.length });
      return result;
    } catch (err) {
      span.fail(err);
      getLoggingApi().warn('calendar', 'space events unavailable', { error: err instanceof Error ? err.message : String(err) });
      return empty(true);
    }
  }
}

// ── Singleton accessors (Rule 12 module contract) ─────────────────────
const METHODS: ReadonlyArray<keyof CalendarApi> = ['snapshot', 'occurrences', 'status', 'openFlow', 'openWindow', 'spaceEvents', 'flowLogSummary'];

function notInitializedApi(): CalendarApi {
  const refuse = (name: string) => (): Promise<never> =>
    Promise.reject(new CalendarError('CALENDAR_NOT_INITIALIZED', `Calendar API not initialized (${name}).`, 'initCalendar() must run before the calendar is used.'));
  return {
    snapshot: refuse('snapshot'),
    occurrences: refuse('occurrences'),
    status: () => ({ signedIn: false, env: null, accountId: null, snapshotAgeMs: null, lastError: 'Calendar API not initialized.' }),
    openFlow: refuse('openFlow'),
    openWindow: refuse('openWindow'),
    spaceEvents: refuse('spaceEvents'),
    flowLogSummary: refuse('flowLogSummary'),
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
