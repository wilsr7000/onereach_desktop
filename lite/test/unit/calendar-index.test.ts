/**
 * ADR-090 — the schedule index: which flow versions do and do not carry a
 * schedule, so a scan re-reads only what changed.
 */
import { describe, it, expect } from 'vitest';
import { dropFlows, emptyIndex, indexStats, parseIndex, planScan, recordFlow, scheduledFromIndex, type FlowHead } from '../../calendar/index.js';
import type { ScheduledFlow } from '../../calendar/types.js';

const head = (id: string, version: string, botId = 'b1', modifiedMs = 10): FlowHead => ({ id, botId, version, modifiedMs, label: `Flow ${id}` });
const sched = (id: string): ScheduledFlow => ({ flowId: id, botId: 'b1', botLabel: 'B', flowLabel: `Flow ${id}`, deployed: true, stepLabel: 'Schedule execution', modifiedMs: 10, active: false, armed: false, activatedMs: 0, nextFireMs: null, events: [{ id: 'e', name: 'n', color: '', timeZone: 'UTC', cron: ['0 9 * * ? *'], recurring: true, start: null, end: null, preview: '', runAtActivation: false }] });

describe('schedule index', () => {
  it('records what each version showed and reports whether anything changed', () => {
    const idx = emptyIndex('acct', 1);
    expect(recordFlow(idx, head('f1', 'v1'), null, 2)).toBe(true);
    expect(recordFlow(idx, head('f2', 'v1'), sched('f2'), 3)).toBe(true);
    expect(recordFlow(idx, head('f1', 'v1'), null, 4)).toBe(false); // same answer, only checkedAt moves
    expect(idx.flows['f1']?.checkedAt).toBe(4);
    expect(recordFlow(idx, head('f1', 'v2'), sched('f1'), 5)).toBe(true);
    expect(indexStats(idx)).toEqual({ flows: 2, withSchedule: 2 });
    expect(scheduledFromIndex('f2', idx.flows['f2']!, 'Bot')).toMatchObject({ flowId: 'f2', botLabel: 'Bot', flowLabel: 'Flow f2', events: [{ name: 'n' }], active: false });
    expect(scheduledFromIndex('f1', { ...idx.flows['f1']!, schedule: null }, 'Bot')).toBeNull();
  });
  it('plans a scan: same version and modified time reuse, anything else fetches, vanished flows drop only from spaces that listed', () => {
    const idx = emptyIndex('acct', 1);
    recordFlow(idx, head('f1', 'v1'), null, 2);
    recordFlow(idx, head('f2', 'v1'), sched('f2'), 2);
    recordFlow(idx, head('f3', 'v1', 'b2'), null, 2);
    recordFlow(idx, head('f4', 'v1', 'b1'), null, 2);
    const plan = planScan(idx, [head('f1', 'v1'), head('f2', 'v2'), head('f5', 'v1'), head('f6', 'v1', 'b1', 99)], new Set(['b1']));
    expect(plan.reuse.map((h) => h.id)).toEqual(['f1']);
    expect(plan.fetch.map((h) => h.id)).toEqual(['f2', 'f5', 'f6']);
    expect(plan.drop).toEqual(['f4']); // f3 is in b2, which did not list: kept
    expect(planScan(idx, [head('f1', 'v1', 'b1', 11)], new Set(['b1'])).fetch.map((h) => h.id)).toEqual(['f1']); // modified time moved
    expect(dropFlows(idx, ['f4', 'nope'], 3)).toBe(true);
    expect(idx.flows['f4']).toBeUndefined();
    expect(dropFlows(idx, ['nope'], 4)).toBe(false);
  });
  it('parses a stored index and discards junk, other accounts and other versions', () => {
    const idx = emptyIndex('acct', 1);
    recordFlow(idx, head('f1', 'v1'), sched('f1'), 2);
    recordFlow(idx, head('f2', 'v1'), null, 2);
    const back = parseIndex(JSON.stringify(idx), 'acct')!;
    expect(back.flows['f1']?.schedule?.events[0]?.cron).toEqual(['0 9 * * ? *']);
    expect(back.flows['f2']?.schedule).toBeNull();
    expect(parseIndex(JSON.stringify(idx), 'other')).toBeNull();
    expect(parseIndex({ ...idx, v: 99 }, 'acct')).toBeNull();
    expect(parseIndex('not json', 'acct')).toBeNull();
    expect(parseIndex({ v: 1, accountId: 'acct', flows: { bad: 'x', f: { version: 'v' } } }, 'acct')!.flows).toEqual({ f: { version: 'v', modifiedMs: 0, botId: '', label: 'f', checkedAt: 0, schedule: null } });
  });
});
