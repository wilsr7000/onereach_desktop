/**
 * Scheduled flows from flow definitions (ADR-090) — pure.
 *
 * A flow is scheduled when a step of the platform's "Schedule execution"
 * template is on its canvas. That step, at activation, hands the Event
 * Manager exactly what its data carries: per schedule event, the cron
 * expressions (`expressions`), the time zone, a start and an end. The
 * Event Manager fires the flow; it publishes no listing, so the flow
 * definitions are the authored truth the Calendar reads.
 */
import { boundToMs, cronOccurrences, parseCron } from './cron.js';
import { SCHEDULE_STEP_LABEL, SCHEDULE_STEP_TEMPLATE_ID, type Occurrence, type ScheduleBound, type ScheduleEvent, type ScheduledFlow } from './types.js';

/** A flow as the datahub lists it (the fields we read). */
export interface FlowRecord {
  id: string;
  botId?: string;
  version?: string | null;
  dateModified?: number | string;
  data?: {
    label?: string;
    description?: string;
    trees?: Record<string, { steps?: Record<string, StepRecord> }>;
  };
}
export interface StepRecord {
  id?: string;
  type?: string;
  label?: string;
  data?: Record<string, unknown>;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const stripTags = (v: unknown): string => str(v).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

function bound(v: unknown): ScheduleBound | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  const date = str(o['date']);
  return date.length > 0 ? { date, time: str(o['time']) } : null;
}

function cronList(d: Record<string, unknown>): string[] {
  const out: string[] = [];
  const push = (v: unknown): void => {
    if (Array.isArray(v)) for (const x of v) if (typeof x === 'string' && x.trim().length > 0) out.push(x.trim());
  };
  push(d['expressions']);
  if (out.length === 0) {
    for (const mode of ['daily', 'weekly', 'monthly', 'yearly']) {
      const m = d[mode];
      if (typeof m === 'object' && m !== null) push((m as Record<string, unknown>)['cronExpressions']);
    }
  }
  // Keep only expressions we can evaluate; drop duplicates.
  const seen = new Set<string>();
  return out.filter((c) => {
    if (seen.has(c)) return false;
    try {
      parseCron(c);
    } catch {
      return false;
    }
    seen.add(c);
    return true;
  });
}

/** One schedule event from the step's `scheduleEvents[i]`. */
export function scheduleEventFrom(raw: unknown): ScheduleEvent | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const ev = raw as Record<string, unknown>;
  const d = (typeof ev['scheduleEventData'] === 'object' && ev['scheduleEventData'] !== null ? ev['scheduleEventData'] : {}) as Record<string, unknown>;
  const tz = typeof d['timeZone'] === 'object' && d['timeZone'] !== null ? str((d['timeZone'] as Record<string, unknown>)['value']) : str(d['timeZone']);
  const preview = typeof ev['previewTexts'] === 'object' && ev['previewTexts'] !== null ? stripTags((ev['previewTexts'] as Record<string, unknown>)['reccuring'] ?? (ev['previewTexts'] as Record<string, unknown>)['recurring']) : '';
  const id = str(d['id']) || str(ev['vforkey']);
  if (id.length === 0) return null;
  return {
    id,
    name: str(d['eventName']) || 'Scheduled run',
    color: str(d['color']),
    timeZone: tz.length > 0 ? tz : 'UTC',
    cron: cronList(d),
    recurring: d['isReccuring'] !== false && d['isRecurring'] !== false,
    start: bound(d['startExpression']),
    end: bound(d['endExpression']),
    preview,
    runAtActivation: d['isRunAtActivation'] === true,
  };
}

export function isScheduleStep(step: StepRecord): boolean {
  return step.type === SCHEDULE_STEP_TEMPLATE_ID || (step.label ?? '').trim().toLowerCase() === SCHEDULE_STEP_LABEL.toLowerCase();
}

/** The flow's schedule, or null when nothing on its canvas schedules it. */
export function scheduledFlowFrom(flow: FlowRecord, botLabel: string): ScheduledFlow | null {
  const events: ScheduleEvent[] = [];
  let stepLabel = SCHEDULE_STEP_LABEL;
  for (const tree of Object.values(flow.data?.trees ?? {})) {
    for (const step of Object.values(tree.steps ?? {})) {
      if (!isScheduleStep(step)) continue;
      stepLabel = step.label ?? stepLabel;
      const list = step.data?.['scheduleEvents'];
      if (!Array.isArray(list)) continue;
      for (const raw of list) {
        const ev = scheduleEventFrom(raw);
        if (ev !== null) events.push(ev);
      }
    }
  }
  if (events.length === 0) return null;
  const modified = typeof flow.dateModified === 'number' ? flow.dateModified : Number.parseInt(str(flow.dateModified), 10);
  return {
    flowId: flow.id,
    botId: flow.botId ?? '',
    botLabel,
    flowLabel: flow.data?.label ?? flow.id,
    description: typeof flow.data?.description === 'string' ? flow.data.description : '',
    deployed: typeof flow.version === 'string' && flow.version.length > 0,
    stepLabel,
    events,
    modifiedMs: Number.isFinite(modified) ? modified : 0,
    active: false,
    armed: false,
    activatedMs: 0,
    nextFireMs: null,
  };
}

/** Occurrences of every event of every scheduled flow within [fromMs, toMs], ascending; capped. */
/**
 * Every run in [fromMs, toMs). The start bound is honoured (the platform
 * records the first fire at it); the END bound is advisory: an armed flow
 * keeps firing past it (the _ReportingAdapters "5min" flow, window ended
 * 2020-02-01, fires every five minutes to this day), so runs after the
 * end are produced and flagged `pastWindow` — the grid draws them, grey
 * when the flow is not armed, in colour when it is.
 */
export function expandOccurrences(flows: ScheduledFlow[], fromMs: number, toMs: number, cap = 60000): { occurrences: Occurrence[]; truncated: boolean } {
  const out: Occurrence[] = [];
  let truncated = false;
  for (const f of flows) {
    for (const ev of f.events) {
      const startMs = boundToMs(ev.start, ev.timeZone);
      const endMs = boundToMs(ev.end, ev.timeZone, true);
      const lo = Math.max(fromMs, startMs ?? fromMs);
      const hi = toMs;
      if (lo > hi) continue;
      const base = { flowId: f.flowId, botId: f.botId, botLabel: f.botLabel, flowLabel: f.flowLabel, description: f.description, eventId: ev.id, eventName: ev.name, color: ev.color, timeZone: ev.timeZone };
      const past = (atMs: number): boolean => endMs !== null && atMs > endMs;
      if (!ev.recurring || ev.cron.length === 0) {
        if (startMs !== null && startMs >= lo && startMs <= hi) out.push({ atMs: startMs, ...base, pastWindow: past(startMs) });
        continue;
      }
      for (const expr of ev.cron) {
        const remaining = cap - out.length;
        if (remaining <= 0) {
          truncated = true;
          break;
        }
        const instants = cronOccurrences(expr, ev.timeZone, { fromMs: lo, toMs: hi, limit: remaining + 1 });
        if (instants.length > remaining) {
          truncated = true;
          instants.length = remaining;
        }
        for (const atMs of instants) out.push({ atMs, ...base, pastWindow: past(atMs) });
      }
    }
  }
  out.sort((a, b) => a.atMs - b.atMs || a.flowLabel.localeCompare(b.flowLabel));
  return { occurrences: out, truncated };
}
