import type { CalendarItem } from '@calendar/core';
import { CalendarDateTime, toZoned } from '@internationalized/date';
import type { ButtonPayload, SvgPayload, TextPayload } from '@calendar/react';
import type { ProgressPayload } from './progressRenderer.js';

export const TZ = 'America/Los_Angeles';
const z = (y: number, m: number, d: number, h = 0, mi = 0) => toZoned(new CalendarDateTime(y, m, d, h, mi, 0, 0), TZ);

const wide = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 120"><rect x="0" y="0" width="320" height="120" rx="12" fill="#e8f0fb"/><polyline points="10,100 60,70 110,85 160,40 210,55 260,20 310,35" fill="none" stroke="#3f78c0" stroke-width="6" stroke-linecap="round"/></svg>';
const square = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="42" fill="#2e7d32"/><path d="M30 52 l14 14 l28 -30" stroke="#fff" stroke-width="9" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';

export function seedItems(onButton: (label: string) => void): CalendarItem[] {
  const text = (id: string, title: string, s: ReturnType<typeof z>, e: ReturnType<typeof z>, extra: Partial<CalendarItem<TextPayload>> = {}, body?: string): CalendarItem<TextPayload> => ({ id, start: s, end: e, allDay: false, type: 'text', payload: body === undefined ? { title } : { title, body }, ...extra });
  const button = (id: string, label: string, s: ReturnType<typeof z>, e: ReturnType<typeof z>): CalendarItem<ButtonPayload> => ({ id, start: s, end: e, allDay: false, type: 'button', payload: { label, onClick: () => onButton(label), color: '#2e7d32' } });
  const svg = (id: string, markup: string, s: ReturnType<typeof z>, e: ReturnType<typeof z>, title: string, allDay = false): CalendarItem<SvgPayload> => ({ id, start: s, end: e, allDay, type: 'svg', payload: { svg: markup, title } });
  const progress = (id: string, label: string, fraction: number, s: ReturnType<typeof z>, e: ReturnType<typeof z>): CalendarItem<ProgressPayload> => ({ id, start: s, end: e, allDay: false, type: 'progress', payload: { label, fraction } });
  const overlap = Array.from({ length: 11 }, (_, i) => text(`ov${i}`, `Overlap ${i + 1}`, z(2026, 9, 8, 9, (i % 4) * 5), z(2026, 9, 8, 10, 0), {}, 'One of eleven items starting around nine.'));
  return [
    text('t1', 'Standup', z(2026, 9, 4, 9, 0), z(2026, 9, 4, 9, 30), {}, 'Daily sync with the platform team.'),
    text('t2', 'A rather long title that will certainly be truncated at month density and wrap at day density', z(2026, 9, 4, 11, 0), z(2026, 9, 4, 12, 30), {}, 'Longer body text appears at week and day density where there is room for it.'),
    text('t3', 'Late review', z(2026, 9, 4, 23, 0), z(2026, 9, 5, 1, 0), { payload: { title: 'Late review (crosses midnight)', color: '#7c3aed' } }),
    text('t4', 'Offsite', z(2026, 9, 3), z(2026, 9, 18), { allDay: true, payload: { title: 'Offsite — two weeks, all day', color: '#b3261e' } }),
    text('t5', 'Short', z(2026, 9, 10, 14, 0), z(2026, 9, 10, 14, 15)),
    text('t6', 'Zero-length marker', z(2026, 9, 10, 16, 0), z(2026, 9, 10, 16, 0)),
    button('b1', 'Join call', z(2026, 9, 4, 14, 0), z(2026, 9, 4, 15, 0)),
    button('b2', 'Approve', z(2026, 9, 9, 10, 0), z(2026, 9, 9, 10, 30)),
    button('b3', 'Ship it', z(2026, 9, 16, 15, 0), z(2026, 9, 16, 16, 0)),
    svg('s1', wide, z(2026, 9, 5, 10, 0), z(2026, 9, 5, 12, 0), 'Weekly trend (wide)'),
    svg('s2', square, z(2026, 9, 11, 9, 0), z(2026, 9, 11, 10, 0), 'Checks passed'),
    svg('s3', wide, z(2026, 9, 21), z(2026, 9, 22), 'Trend, all day', true),
    progress('p1', 'Migration', 0.62, z(2026, 9, 7, 13, 0), z(2026, 9, 7, 15, 0)),
    progress('p2', 'Rollout', 0.9, z(2026, 9, 23, 9, 0), z(2026, 9, 23, 11, 0)),
    { id: 'u1', start: z(2026, 9, 12, 12, 0), end: z(2026, 9, 12, 13, 0), allDay: false, type: 'video', payload: { url: 'x' } },
    ...overlap,
  ];
}
