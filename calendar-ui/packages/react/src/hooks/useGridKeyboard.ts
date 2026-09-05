import type { CalendarDate } from '@internationalized/date';
import { useCallback, type KeyboardEvent } from 'react';

export interface GridKeyboardOptions {
  days: readonly CalendarDate[];
  columns: number;
  focused: string | null;
  setFocused: (iso: string) => void;
  onEdge: (direction: -1 | 1) => void;
  onEnter: (iso: string) => void;
  onEscape: () => void;
}

export const isoOf = (d: CalendarDate): string => `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;

/** Arrow keys move focus between cells (roving tabindex); Enter opens the focused cell's first item; Escape closes popovers. */
export function useGridKeyboard(opts: GridKeyboardOptions): (e: KeyboardEvent<HTMLElement>) => void {
  const { days, columns, focused, setFocused, onEdge, onEnter, onEscape } = opts;
  return useCallback(
    (e: KeyboardEvent<HTMLElement>) => {
      const t = e.target instanceof HTMLElement ? e.target : null;
      const onCell = t !== null && (t.getAttribute('role') === 'gridcell' || t.hasAttribute('data-focus-target'));
      if (e.target !== e.currentTarget && !onCell) {
        if (e.key === 'Escape') onEscape();
        return;
      }
      // Start from the cell that holds focus when the state has not caught up yet.
      const targetIso = t?.dataset['date'] ?? t?.closest<HTMLElement>('[data-date]')?.dataset['date'] ?? null;
      const from = focused ?? targetIso;
      const index = from === null ? 0 : days.findIndex((d) => isoOf(d) === from);
      const current = index < 0 ? 0 : index;
      let next: number | null = null;
      switch (e.key) {
        case 'ArrowRight':
          next = current + 1;
          break;
        case 'ArrowLeft':
          next = current - 1;
          break;
        case 'ArrowDown':
          next = current + columns;
          break;
        case 'ArrowUp':
          next = current - columns;
          break;
        case 'Home':
          next = current - (current % columns);
          break;
        case 'End':
          next = current - (current % columns) + columns - 1;
          break;
        case 'Enter': {
          const d = days[current];
          if (d !== undefined) {
            e.preventDefault();
            onEnter(isoOf(d));
          }
          return;
        }
        case 'Escape':
          onEscape();
          return;
        default:
          return;
      }
      e.preventDefault();
      if (next < 0) onEdge(-1);
      else if (next >= days.length) onEdge(1);
      else {
        const d = days[next];
        if (d !== undefined) setFocused(isoOf(d));
      }
    },
    [days, columns, focused, setFocused, onEdge, onEnter, onEscape]
  );
}
