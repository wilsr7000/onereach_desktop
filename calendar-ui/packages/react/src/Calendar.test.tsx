import { CalendarDate, CalendarDateTime, toZoned } from '@internationalized/date';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { CalendarItem } from '@calendar/core';
import { Calendar } from './Calendar.js';
import { createRegistry } from './registry.js';
import { textRenderer } from './renderers/text.js';
import { computeLayout } from './hooks/useLayout.js';

const TZ = 'America/New_York';
const z = (iso: string) => {
  const [d, t] = iso.split('T') as [string, string];
  const [y, m, dd] = d.split('-').map(Number) as [number, number, number];
  const [h, mi] = t.split(':').map(Number) as [number, number];
  return toZoned(new CalendarDateTime(y, m, dd, h, mi, 0, 0), TZ);
};
const items: CalendarItem[] = [
  { id: 'a', start: z('2026-09-04T09:00'), end: z('2026-09-04T10:00'), allDay: false, type: 'text', payload: { title: 'Standup' } },
  { id: 'b', start: z('2026-09-04T09:30'), end: z('2026-09-04T11:00'), allDay: false, type: 'text', payload: { title: 'Design review' } },
  { id: 'c', start: z('2026-09-03T00:00'), end: z('2026-09-18T00:00'), allDay: true, type: 'text', payload: { title: 'Offsite' } },
  { id: 'd', start: z('2026-09-10T12:00'), end: z('2026-09-10T13:00'), allDay: false, type: 'ghost', payload: {} },
];
const registry = createRegistry().register(textRenderer);
const anchor = new CalendarDate(2026, 9, 4);

describe('Calendar', () => {
  it('month view: a grid with rows and cells, bars for every item, an unregistered type as a placeholder', () => {
    render(<Calendar items={items} registry={registry} view="month" anchorDate={anchor} timeZone={TZ} onNavigate={() => undefined} today={anchor} />);
    const grid = screen.getByRole('grid', { name: 'month calendar' });
    expect(grid.querySelectorAll('[role="row"]').length).toBe(5);
    expect(grid.querySelectorAll('[role="gridcell"]').length).toBe(35);
    expect(screen.getAllByRole('button', { name: 'Offsite' }).length).toBe(3); // one bar per week
    expect(screen.getByRole('note')).toHaveTextContent('ghost');
    expect(grid.querySelector('.cal-daycell.is-today .cal-daynum')).toHaveTextContent('4');
  });
  it('week view: seven columns, overlapping items share the width, the live region describes the view', () => {
    render(<Calendar items={items} registry={registry} view="week" anchorDate={anchor} timeZone={TZ} onNavigate={() => undefined} />);
    const cols = document.querySelectorAll('.cal-col');
    expect(cols.length).toBe(7);
    const a = screen.getByRole('button', { name: 'Standup' });
    const b = screen.getByRole('button', { name: 'Design review' });
    expect(a.style.width).toBe('calc(50% - 2px)');
    expect(b.style.left).toBe('50%');
    expect(screen.getByTestId('cal-live')).toHaveTextContent('week view, 7 days, 4 items');
  });
  it('activating an item opens its Expanded popover, Escape closes it and restores focus', async () => {
    const onItemActivate = vi.fn();
    render(<Calendar items={items} registry={registry} view="day" anchorDate={anchor} timeZone={TZ} onNavigate={() => undefined} onItemActivate={onItemActivate} />);
    const slot = screen.getByRole('button', { name: 'Standup' });
    slot.focus();
    await act(async () => {
      slot.click();
    });
    expect(onItemActivate).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }));
    const dialog = screen.getByRole('dialog', { name: 'Standup' });
    expect(dialog).toHaveTextContent('Standup');
    await act(async () => {
      fireEvent.keyDown(dialog, { key: 'Escape' });
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(slot);
  });
  it('arrow keys move the focused cell; the range edge navigates', () => {
    const onNavigate = vi.fn();
    render(<Calendar items={items} registry={registry} view="week" anchorDate={anchor} timeZone={TZ} onNavigate={onNavigate} />);
    const head = document.querySelector<HTMLElement>('.cal-week__day[data-date="2026-09-04"]')!;
    act(() => head.focus());
    fireEvent.keyDown(head, { key: 'ArrowRight' });
    expect(document.querySelector('.cal-week__day[data-date="2026-09-05"]')).toHaveClass('is-focused');
    const last = document.querySelector<HTMLElement>('.cal-week__day[data-date="2026-09-05"]')!;
    fireEvent.keyDown(last, { key: 'ArrowRight' });
    expect(onNavigate).toHaveBeenCalledWith(expect.objectContaining({ day: 11 }), 'week');
  });
  it('loading: skeleton with one ghost cell per day when there is nothing yet; progress bar when refreshing over data', () => {
    const { rerender } = render(<Calendar items={[]} registry={registry} view="month" anchorDate={anchor} timeZone={TZ} onNavigate={() => undefined} status="loading" />);
    expect(screen.getByTestId('cal-skeleton').querySelectorAll('.cal-skeleton__cell').length).toBe(35);
    expect(screen.getByRole('grid')).toHaveAttribute('aria-busy', 'true');
    rerender(<Calendar items={items} registry={registry} view="month" anchorDate={anchor} timeZone={TZ} onNavigate={() => undefined} status="refreshing" />);
    expect(screen.queryByTestId('cal-skeleton')).toBeNull();
    expect(screen.getByTestId('cal-progress')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Offsite' }).length).toBe(3);
    rerender(<Calendar items={items} registry={registry} view="month" anchorDate={anchor} timeZone={TZ} onNavigate={() => undefined} status="error" errorMessage="GSX is unreachable" />);
    expect(screen.getByRole('alert')).toHaveTextContent('GSX is unreachable');
  });
  it('respects reduced motion: durations collapse through the motion prop', () => {
    render(<Calendar items={items} registry={registry} view="month" anchorDate={anchor} timeZone={TZ} onNavigate={() => undefined} motion="reduced" />);
    expect(screen.getByRole('grid')).toHaveClass('cal--reduced');
  });
  it('layout is pure and memoisable: same inputs give the same placements', () => {
    const input = { items, view: 'week' as const, anchorDate: anchor, timeZone: TZ, weekStartsOn: 0 as const, hourRange: [0, 24] as const, maxVisiblePerCell: 3 };
    const a = computeLayout(input);
    const b = computeLayout(input);
    expect(a.days.map((d) => d.placements)).toEqual(b.days.map((d) => d.placements));
    expect(a.weeks[0]?.segments.map((s) => s.itemId)).toEqual(['c']);
  });
});
