/**
 * iCalendar export (ADR-090): RFC 5545 shapes, stable UIDs, escaping,
 * folding, and the daily marker for dense series.
 */
import { describe, it, expect } from 'vitest';
import { buildIcs, dayIn, foldLine, icsEscape, icsUtc, type IcsRun } from '../../calendar/ics.js';

const run = (atMs: number, over: Partial<IcsRun> = {}): IcsRun => ({ atMs, flowId: 'f1', botLabel: 'Reporting', flowLabel: 'Nightly report', description: 'Rolls up the day; semi;colon, comma', eventId: 'e1', eventName: 'Nightly', timeZone: 'UTC', ...over });

describe('calendar ics', () => {
  it('formats UTC stamps, escapes text, folds long lines at 75 octets', () => {
    expect(icsUtc(Date.UTC(2026, 8, 5, 7, 30, 15))).toBe('20260905T073015Z');
    expect(icsEscape('a;b,c\\d\ne')).toBe('a\;b\\,c\\\\d\\ne');
    const long = `DESCRIPTION:${'x'.repeat(200)}`;
    const folded = foldLine(long);
    const lines = folded.split('\r\n');
    expect(lines.length).toBeGreaterThan(2);
    expect(lines.slice(1).every((l) => l.startsWith(' '))).toBe(true);
    expect(lines.every((l) => new TextEncoder().encode(l).length <= 75)).toBe(true);
    expect(folded.replace(/\r\n /g, '')).toBe(long);
    expect(foldLine('short')).toBe('short');
    expect(dayIn(Date.UTC(2026, 8, 5, 23, 30), 'America/Los_Angeles')).toBe('2026-09-05');
    expect(dayIn(Date.UTC(2026, 8, 5, 23, 30), 'Europe/Kiev')).toBe('2026-09-06');
    expect(dayIn(Date.UTC(2026, 8, 5, 23, 30), 'Not/AZone')).toBe('2026-09-05');
  });

  it('writes one VEVENT per run with a stable UID, sorted by time, CRLF-terminated', () => {
    const t = Date.UTC(2026, 8, 5, 2, 0);
    const out = buildIcs([run(t + 3_600_000), run(t, { flowId: 'f2', flowLabel: 'Other', botLabel: 'Ops' })], { name: 'Scheduled flows · Sept', nowMs: Date.UTC(2026, 8, 1) });
    expect(out.events).toBe(2);
    expect(out.collapsed).toBe(0);
    expect(out.text.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n')).toBe(true);
    expect(out.text.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(out.text).toContain('X-WR-CALNAME:Scheduled flows · Sept');
    const uids = [...out.text.matchAll(/^UID:(.+)$/gm)].map((m) => m[1]);
    expect(uids).toEqual([`f2.e1.${t}@onereach-lite`, `f1.e1.${t + 3_600_000}@onereach-lite`]);
    expect(out.text).toContain(`DTSTART:${icsUtc(t)}`);
    expect(out.text).toContain('SUMMARY:Nightly report · Nightly');
    expect(out.text).toContain('CATEGORIES:Ops');
    expect(out.text).toContain('X-OR-FLOW-ID:f1');
    expect(out.text).toContain('DESCRIPTION:Reporting\\nRolls up the day\; semi\;colon\\, comma');
    expect(buildIcs([run(t)], { name: 'x', nowMs: 0 }).text).toBe(buildIcs([run(t)], { name: 'x', nowMs: 0 }).text);
  });

  it('collapses a dense day into one all-day marker with the count and cadence, in the event\'s zone', () => {
    const day = Date.UTC(2026, 8, 5, 0, 0);
    const runs = Array.from({ length: 288 }, (_, i) => run(day + i * 5 * 60_000, { eventName: '5min' }));
    const out = buildIcs([...runs, run(Date.UTC(2026, 8, 6, 9, 0), { eventName: 'Once' })], { name: 'dense', nowMs: 0 });
    expect(out.events).toBe(2);
    expect(out.collapsed).toBe(1);
    expect(out.text).toContain('DTSTART;VALUE=DATE:20260905');
    expect(out.text).toContain('DTEND;VALUE=DATE:20260906');
    expect(out.text).toContain('SUMMARY:Nightly report · 5min ×288');
    expect(out.text).toContain('288 runs on this day every 5 min (Reporting).');
    expect(out.text).toContain('UID:f1.e1.20260905.day@onereach-lite');
    // A day split by the zone: 13 runs straddling midnight Kiev fall on two days, neither dense.
    const kiev = Array.from({ length: 13 }, (_, i) => run(Date.UTC(2026, 8, 5, 20, 0) + i * 30 * 60_000, { timeZone: 'Europe/Kiev' }));
    const split = buildIcs(kiev, { name: 'k', nowMs: 0 });
    expect(split.collapsed).toBe(0);
    expect(split.events).toBe(13);
  });
});
