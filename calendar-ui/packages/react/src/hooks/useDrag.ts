import { snapToSlot, type CalendarItem } from '@calendar/core';
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

export type DragMode = 'move' | 'resize-start' | 'resize-end';

export interface DragState {
  item: CalendarItem;
  mode: DragMode;
  /** Tentative item while the pointer moves; committed on release. */
  tentative: CalendarItem;
  /** For all-day drags: the date under the pointer (ISO), if any. */
  overDate: string | null;
}

export interface TimedDragMetrics {
  hourHeight: number;
  columnWidth: number;
  slotMinutes: number;
  /** Day delta is only meaningful across columns (week view). */
  columns: number;
}

/**
 * Pointer-driven move and resize. Emits a NEW item through `onChange`;
 * the original is never mutated. Snaps to `slotMinutes`. Present only
 * when the calendar received `onItemChange`.
 */
export function useTimedDrag(onChange: ((item: CalendarItem) => void) | undefined, metrics: TimedDragMetrics): { drag: DragState | null; start: (item: CalendarItem, e: ReactPointerEvent<HTMLElement>, mode: DragMode) => void } {
  const [drag, setDrag] = useState<DragState | null>(null);
  const origin = useRef<{ x: number; y: number; item: CalendarItem; mode: DragMode } | null>(null);
  const start = useCallback(
    (item: CalendarItem, e: ReactPointerEvent<HTMLElement>, mode: DragMode) => {
      if (onChange === undefined) return;
      e.preventDefault();
      e.currentTarget.setPointerCapture?.(e.pointerId);
      origin.current = { x: e.clientX, y: e.clientY, item, mode };
      setDrag({ item, mode, tentative: item, overDate: null });
    },
    [onChange]
  );
  useEffect(() => {
    if (drag === null) return;
    const onMove = (e: PointerEvent): void => {
      const o = origin.current;
      if (o === null) return;
      const dy = e.clientY - o.y;
      const dx = e.clientX - o.x;
      const rawMinutes = (dy / metrics.hourHeight) * 60;
      const minutes = Math.round(rawMinutes / metrics.slotMinutes) * metrics.slotMinutes;
      const days = metrics.columns > 1 && metrics.columnWidth > 0 ? Math.round(dx / metrics.columnWidth) : 0;
      let start = o.item.start;
      let end = o.item.end;
      if (o.mode === 'move') {
        start = start.add({ days, minutes });
        end = end.add({ days, minutes });
      } else if (o.mode === 'resize-start') {
        const candidate = start.add({ minutes });
        start = candidate.compare(end.subtract({ minutes: metrics.slotMinutes })) > 0 ? end.subtract({ minutes: metrics.slotMinutes }) : candidate;
      } else {
        const candidate = end.add({ minutes });
        end = candidate.compare(start.add({ minutes: metrics.slotMinutes })) < 0 ? start.add({ minutes: metrics.slotMinutes }) : candidate;
      }
      setDrag((d) => (d === null ? d : { ...d, tentative: { ...o.item, start: snapToSlot(start, metrics.slotMinutes), end: snapToSlot(end, metrics.slotMinutes) } }));
    };
    const onUp = (): void => {
      setDrag((d) => {
        if (d !== null && onChange !== undefined && (d.tentative.start.compare(d.item.start) !== 0 || d.tentative.end.compare(d.item.end) !== 0)) onChange(d.tentative);
        return null;
      });
      origin.current = null;
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [drag !== null, metrics.hourHeight, metrics.columnWidth, metrics.slotMinutes, metrics.columns, onChange]);
  return { drag, start };
}

/** Drop an all-day bar on another day (month and week views): the item shifts by whole days. */
export function useAllDayDrag(onChange: ((item: CalendarItem) => void) | undefined, daysBetween: (fromIso: string, toIso: string) => number): { drag: DragState | null; start: (item: CalendarItem, e: ReactPointerEvent<HTMLElement>, fromIso: string) => void } {
  const [drag, setDrag] = useState<DragState | null>(null);
  const from = useRef<string | null>(null);
  const start = useCallback(
    (item: CalendarItem, e: ReactPointerEvent<HTMLElement>, fromIso: string) => {
      if (onChange === undefined) return;
      e.preventDefault();
      from.current = fromIso;
      setDrag({ item, mode: 'move', tentative: item, overDate: fromIso });
    },
    [onChange]
  );
  useEffect(() => {
    if (drag === null) return;
    const dateUnder = (x: number, y: number): string | null => {
      const el = document.elementFromPoint(x, y);
      const cell = el instanceof Element ? el.closest<HTMLElement>('[data-date]') : null;
      return cell?.dataset['date'] ?? null;
    };
    const onMove = (e: PointerEvent): void => {
      const over = dateUnder(e.clientX, e.clientY);
      setDrag((d) => (d === null || d.overDate === over ? d : { ...d, overDate: over }));
    };
    const onUp = (e: PointerEvent): void => {
      const over = dateUnder(e.clientX, e.clientY);
      setDrag((d) => {
        if (d !== null && onChange !== undefined && over !== null && from.current !== null) {
          const delta = daysBetween(from.current, over);
          if (delta !== 0) onChange({ ...d.item, start: d.item.start.add({ days: delta }), end: d.item.end.add({ days: delta }) });
        }
        return null;
      });
      from.current = null;
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [drag !== null, onChange, daysBetween]);
  return { drag, start };
}
