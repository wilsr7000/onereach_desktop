/**
 * ADR-090 — scheduled flows from flow definitions: the "Schedule execution"
 * step's data (as the datahub returns it) becomes schedule events, and
 * events become occurrences within a window.
 */
import { describe, it, expect } from 'vitest';
import { expandOccurrences, scheduleEventFrom, scheduledFlowFrom, type FlowRecord } from '../../calendar/schedule.js';
import { zonedTimeToUtc } from '../../calendar/cron.js';
import { SCHEDULE_STEP_TEMPLATE_ID } from '../../calendar/types.js';

/** The real shape, trimmed (flow 1c8e5be8… "Trigger Custom Report Reducer"). */
const REAL_EVENT = {
  vforkey: '6f1a97d1-d2c4-4d72-88e2-592d7dbcc2a7',
  previewTexts: { reccuring: 'Every <span class="bold-text">1st</span> day' },
  scheduleEventData: {
    id: 'd0f1c7c5-9f00-42e4-940c-7df3cd038a15', color: '#FFC107', eventName: '5min', saved: true,
    daily: { period: '1', periodMode: 'everyDay', cronExpressions: ['0,5,10,15,20,25,30,35,40,45,50,55 0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23 1/1 * ? *'] },
    weekly: { period: '1', weekDays: [], cronExpressions: [] }, monthly: { mode: 'each', cronExpressions: [] }, yearly: { cronExpressions: [] },
    timeZone: { label: 'Europe/Kiev', value: 'Europe/Kiev' },
    expressions: ['0,5,10,15,20,25,30,35,40,45,50,55 0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23 1/1 * ? *'],
    startExpression: { date: '2019-10-09', time: '00:00' }, endExpression: { date: '2020-02-01', time: '23:59:59' },
    isReccuring: true, isRunAtActivation: true, deactivateAfterLastRun: false,
  },
};
const flow = (over: Partial<FlowRecord> = {}, events: unknown[] = [REAL_EVENT]): FlowRecord => ({
  id: '1c8e5be8-6665-40e5-adf8-7165387e85cb', botId: '4d9ba593-59a9-4b48-a03c-dcb2dcdd62ee', version: 'c7696c60-3700-467a-9afb-21bddd7a9301', dateModified: 1776111215100,
  data: { label: 'Trigger Custom Report Reducer', trees: { main: { steps: {
    a287c994: { id: 'a287c994', type: SCHEDULE_STEP_TEMPLATE_ID, label: 'Schedule execution', data: { exits: [], multipleLegs: false, scheduleEvents: events } },
    b3c0a953: { id: 'b3c0a953', type: 'd51593b3-7c89-44bc-9961-d7f08922ca14', label: 'Trigger', data: {} },
  } } } },
  ...over,
});

describe('calendar schedule — extraction', () => {
  it('reads a schedule event as the step wrote it: effective expressions, zone, bounds, preview without markup', () => {
    const ev = scheduleEventFrom(REAL_EVENT)!;
    expect(ev).toMatchObject({ id: 'd0f1c7c5-9f00-42e4-940c-7df3cd038a15', name: '5min', color: '#FFC107', timeZone: 'Europe/Kiev', recurring: true, runAtActivation: true, preview: 'Every 1st day' });
    expect(ev.cron).toHaveLength(1);
    expect(ev.start).toEqual({ date: '2019-10-09', time: '00:00' });
    expect(ev.end).toEqual({ date: '2020-02-01', time: '23:59:59' });
  });
  it('falls back to the mode cron lists when `expressions` is absent, drops unparsable ones, and defaults the zone', () => {
    const ev = scheduleEventFrom({ scheduleEventData: { id: 'x', eventName: 'weekly', weekly: { cronExpressions: ['0 9 ? * MON *', 'not a cron'] } } })!;
    expect(ev.cron).toEqual(['0 9 ? * MON *']);
    expect(ev.timeZone).toBe('UTC');
    expect(scheduleEventFrom({ scheduleEventData: {} })).toBeNull();
  });
  it('finds the Schedule execution step on the canvas (by template id or label) and reads the flow', () => {
    const sf = scheduledFlowFrom(flow(), 'Reporting')!;
    expect(sf).toMatchObject({ flowId: '1c8e5be8-6665-40e5-adf8-7165387e85cb', botLabel: 'Reporting', flowLabel: 'Trigger Custom Report Reducer', deployed: true, stepLabel: 'Schedule execution', modifiedMs: 1776111215100, active: false, armed: false });
    expect(sf.events).toHaveLength(1);
    const byLabel = scheduledFlowFrom(flow({ data: { label: 'x', trees: { main: { steps: { s: { type: 'other', label: 'Schedule execution', data: { scheduleEvents: [REAL_EVENT] } } } } } } }), 'b');
    expect(byLabel?.events).toHaveLength(1);
    expect(scheduledFlowFrom(flow({ data: { label: 'plain', trees: { main: { steps: { s: { type: 'other', label: 'Wait for HTTP Request', data: {} } } } } } }), 'b')).toBeNull();
    expect(scheduledFlowFrom(flow({}, []), 'b')).toBeNull();
  });
});

describe('calendar schedule — occurrences', () => {
  it('expands a recurring event from its start, in its zone; runs past the authored end are produced and flagged (the platform fires them)', () => {
    const sf = scheduledFlowFrom(flow(), 'Reporting')!;
    const from = zonedTimeToUtc(2019, 10, 8, 0, 0, 0, 'Europe/Kiev') ?? 0; // a day before the start
    const to = zonedTimeToUtc(2019, 10, 9, 0, 30, 0, 'Europe/Kiev') ?? 0;
    const { occurrences, truncated } = expandOccurrences([sf], from, to);
    expect(truncated).toBe(false);
    expect(occurrences.map((o) => o.atMs)).toEqual([0, 5, 10, 15, 20, 25, 30].map((m) => zonedTimeToUtc(2019, 10, 9, 0, m, 0, 'Europe/Kiev')));
    expect(occurrences[0]).toMatchObject({ flowId: sf.flowId, eventName: '5min', botLabel: 'Reporting', timeZone: 'Europe/Kiev', color: '#FFC107', pastWindow: false });
    // After the end bound (2020-02-01): the series continues, every run flagged — an armed flow keeps firing past its window.
    const later = expandOccurrences([sf], zonedTimeToUtc(2026, 9, 5, 0, 0, 0, 'UTC') ?? 0, zonedTimeToUtc(2026, 9, 6, 0, 0, 0, 'UTC') ?? 0);
    expect(later.occurrences).toHaveLength(289); // the window's end instant is inclusive, as the 00:30 case above shows
    expect(later.occurrences.every((o) => o.pastWindow)).toBe(true);
    // Before the start bound: nothing (the platform records the first fire at the start).
    const before = expandOccurrences([sf], zonedTimeToUtc(2019, 10, 1, 0, 0, 0, 'UTC') ?? 0, zonedTimeToUtc(2019, 10, 2, 0, 0, 0, 'UTC') ?? 0);
    expect(before.occurrences).toHaveLength(0);
  });
  it('a one-shot event fires once at its start; the cap marks truncation', () => {
    const once = scheduledFlowFrom(flow({}, [{ scheduleEventData: { id: 'once', eventName: 'Launch', timeZone: { value: 'UTC' }, expressions: ['0 12 * * ? *'], isReccuring: false, startExpression: { date: '2026-09-10', time: '12:00' } } }]), 'b')!;
    const from = zonedTimeToUtc(2026, 9, 1, 0, 0, 0, 'UTC') ?? 0;
    const to = zonedTimeToUtc(2026, 9, 30, 0, 0, 0, 'UTC') ?? 0;
    const r = expandOccurrences([once], from, to);
    expect(r.occurrences).toHaveLength(1);
    expect(r.occurrences[0]?.atMs).toBe(zonedTimeToUtc(2026, 9, 10, 12, 0, 0, 'UTC'));
    const busy = scheduledFlowFrom(flow({}, [{ scheduleEventData: { id: 'm', eventName: 'minutely', timeZone: { value: 'UTC' }, expressions: ['* * * * ? *'], isReccuring: true } }]), 'b')!;
    const capped = expandOccurrences([busy], from, to, 100);
    expect(capped.occurrences).toHaveLength(100);
    expect(capped.truncated).toBe(true);
  });
});
