import { daysBetween, type CalendarItem, type View, type WeekStartsOn } from '@calendar/core';
import { CalendarDate, type CalendarDate as CalendarDateType } from '@internationalized/date';
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useAllDayDrag, type DragState } from './hooks/useDrag.js';
import { isoOf, useGridKeyboard } from './hooks/useGridKeyboard.js';
import { useLayout } from './hooks/useLayout.js';
import { ProgressBar } from './motion/ProgressBar.js';
import { SkeletonCells } from './motion/Skeleton.js';
import { useFlip } from './motion/useFlip.js';
import { useReducedMotion, type MotionPreference } from './motion/useReducedMotion.js';
import { Popover } from './primitives/Popover.js';
import type { Registry } from './registry.js';
import { DayView } from './views/DayView.js';
import { MonthView } from './views/MonthView.js';
import { WeekView } from './views/WeekView.js';

export type CalendarStatus = 'idle' | 'loading' | 'refreshing' | 'error';

export interface CalendarProps {
  items: CalendarItem[];
  registry: Registry;
  view: View;
  anchorDate: CalendarDateType;
  timeZone: string;
  weekStartsOn?: WeekStartsOn;
  hourRange?: [number, number];
  slotMinutes?: 15 | 30 | 60;
  onNavigate: (anchorDate: CalendarDateType, view: View) => void;
  onItemActivate?: (item: CalendarItem) => void;
  /** Enables drag to move / resize (week, day) and all-day drops (month, week). */
  onItemChange?: (item: CalendarItem) => void;
  /** Loading presentation; the calendar holds no item state. */
  status?: CalendarStatus;
  errorMessage?: string;
  maxVisiblePerCell?: number;
  motion?: MotionPreference;
  /** Today, as a date in `timeZone`; nothing reads the system clock implicitly. */
  today?: CalendarDateType;
  /** Now, for the current-time line (ms). Omit to hide the line. */
  nowMs?: number;
  className?: string;
  children?: ReactNode;
}

const parseIso = (iso: string): CalendarDateType => {
  const [y, m, d] = iso.split('-').map((v) => Number.parseInt(v, 10)) as [number, number, number];
  return new CalendarDate(y, m, d);
};

/** The controlled calendar: a layout engine that never looks at item types. */
export function Calendar(props: CalendarProps): JSX.Element {
  const { items, registry, view, anchorDate, timeZone, onNavigate, onItemActivate, onItemChange, status = 'idle', errorMessage, motion = 'auto', today, nowMs, className } = props;
  const weekStartsOn = props.weekStartsOn ?? 0;
  const hourRange = props.hourRange ?? [0, 24];
  const slotMinutes = props.slotMinutes ?? 30;
  const maxVisiblePerCell = props.maxVisiblePerCell ?? 3;
  const reduced = useReducedMotion(motion);
  const layout = useLayout({ items, view, anchorDate, timeZone, weekStartsOn, hourRange, maxVisiblePerCell });
  const [selected, setSelected] = useState<{ item: CalendarItem; anchor: HTMLElement } | null>(null);
  const [focusedIso, setFocusedIso] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [timedDrag, setTimedDrag] = useState<DragState | null>(null);
  const registerFlip = useFlip([layout, view], !reduced);
  const seen = useRef<Set<string>>(new Set());
  const enteringIds = useMemo(() => {
    const next = new Set<string>();
    for (const i of items) if (!seen.current.has(i.id)) next.add(i.id);
    return next;
  }, [items]);
  useEffect(() => {
    seen.current = new Set(items.map((i) => i.id));
  }, [items]);

  const activate = useCallback(
    (item: CalendarItem, anchor: HTMLElement) => {
      onItemActivate?.(item);
      setSelected((s) => (s !== null && s.item.id === item.id ? null : { item, anchor }));
    },
    [onItemActivate]
  );
  const close = useCallback(() => setSelected(null), []);
  const dayDelta = useCallback((fromIso: string, toIso: string) => daysBetween(parseIso(fromIso), parseIso(toIso)), []);
  const allDay = useAllDayDrag(onItemChange, dayDelta);
  useEffect(() => setDropTarget(allDay.drag?.overDate ?? null), [allDay.drag]);

  const columns = view === 'day' ? 1 : 7;
  const onKeyDown = useGridKeyboard({
    days: layout.range.days,
    columns,
    focused: focusedIso,
    setFocused: (iso) => {
      setFocusedIso(iso);
      requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-focus-target][data-date="${iso}"], .cal-cell[data-date="${iso}"] [data-focus-target]`)?.focus());
    },
    onEdge: (direction) => onNavigate(view === 'month' ? anchorDate.add({ months: direction }) : anchorDate.add({ days: direction * columns }), view),
    onEnter: (iso) => {
      const first = document.querySelector<HTMLElement>(`.cal-cell[data-date="${iso}"] ~ .cal-slot, .cal-col[data-date="${iso}"] .cal-slot`) ?? firstBarOn(iso);
      first?.click();
    },
    onEscape: close,
  });
  useEffect(() => {
    if (selected !== null && !layout.itemsById.has(selected.item.id)) setSelected(null);
  }, [layout, selected]);

  const todayIso = today === undefined ? null : isoOf(today);
  const density = view;
  const skeleton = status === 'loading' && items.length === 0;
  const Expanded = selected === null ? undefined : registry.get(selected.item.type)?.Expanded;
  const classes = ['cal', `cal--${view}`, reduced ? 'cal--reduced' : '', status === 'loading' ? 'is-loading' : '', timedDrag !== null || allDay.drag !== null ? 'is-dragging' : '', className ?? ''].filter((c) => c.length > 0).join(' ');
  const handleKey = (e: KeyboardEvent<HTMLDivElement>): void => onKeyDown(e);
  return (
    <div className={classes} role="grid" aria-label={`${view} calendar`} aria-busy={status === 'loading' || status === 'refreshing'} data-view={view} onKeyDown={handleKey}>
      <ProgressBar active={status === 'refreshing' || (status === 'loading' && items.length > 0)} />
      {status === 'error' ? (
        <div className="cal-banner" role="alert">
          {errorMessage ?? 'The calendar could not load.'}
        </div>
      ) : null}
      {props.children}
      {skeleton ? (
        <SkeletonCells count={layout.range.days.length} columns={columns} perCell={view === 'month' ? 2 : 3} reduced={reduced} />
      ) : view === 'month' ? (
        <MonthView layout={layout} registry={registry} maxVisiblePerCell={maxVisiblePerCell} selectedId={selected?.item.id ?? null} focusedIso={focusedIso} todayIso={todayIso} onActivate={activate} onOverflow={(date) => onNavigate(date, 'day')} onDragStart={onItemChange === undefined ? undefined : allDay.start} dropTarget={dropTarget} registerFlip={registerFlip} enteringIds={enteringIds} onCellFocus={setFocusedIso} />
      ) : view === 'week' ? (
        <WeekView layout={layout} registry={registry} density="week" hourRange={hourRange} slotMinutes={slotMinutes} maxVisiblePerCell={maxVisiblePerCell} selectedId={selected?.item.id ?? null} focusedIso={focusedIso} todayIso={todayIso} nowMs={nowMs} onActivate={activate} onItemChange={onItemChange} onAllDayDragStart={onItemChange === undefined ? undefined : allDay.start} dropTarget={dropTarget} registerFlip={registerFlip} enteringIds={enteringIds} onDragStateChange={setTimedDrag} onCellFocus={setFocusedIso} />
      ) : (
        <DayView layout={layout} registry={registry} hourRange={hourRange} slotMinutes={slotMinutes} maxVisiblePerCell={maxVisiblePerCell} selectedId={selected?.item.id ?? null} focusedIso={focusedIso} todayIso={todayIso} nowMs={nowMs} onActivate={activate} onItemChange={onItemChange} onAllDayDragStart={onItemChange === undefined ? undefined : allDay.start} dropTarget={dropTarget} registerFlip={registerFlip} enteringIds={enteringIds} onDragStateChange={setTimedDrag} onCellFocus={setFocusedIso} />
      )}
      {selected !== null && Expanded !== undefined ? (
        <Popover anchor={selected.anchor} onClose={close} reduced={reduced} label={registry.getLabel(selected.item)}>
          <Expanded item={selected.item} onClose={close} />
        </Popover>
      ) : null}
      <span className="cal-live" aria-live="polite" data-testid="cal-live">
        {`${density} view, ${layout.range.days.length} days, ${items.length} items`}
      </span>
    </div>
  );
}

function firstBarOn(iso: string): HTMLElement | null {
  const cell = document.querySelector<HTMLElement>(`.cal-cell[data-date="${iso}"]`);
  if (cell === null) return null;
  const col = Number.parseInt(cell.dataset['col'] ?? '-1', 10);
  const row = cell.parentElement;
  if (row === null || col < 0) return null;
  for (const bar of row.querySelectorAll<HTMLElement>('.cal-bar')) {
    const gc = bar.style.gridColumn;
    const m = /^(\d+)\s*\/\s*(\d+)$/.exec(gc);
    if (m === null) continue;
    const a = Number.parseInt(m[1] ?? '0', 10) - 1;
    const b = Number.parseInt(m[2] ?? '0', 10) - 2;
    if (a <= col && col <= b) return bar;
  }
  return null;
}
