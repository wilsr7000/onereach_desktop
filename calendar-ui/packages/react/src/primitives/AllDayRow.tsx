import type { AllDaySegment, CalendarItem, CellOverflow } from '@calendar/core';
import type { CalendarDate } from '@internationalized/date';
import type { PointerEvent, ReactNode } from 'react';
import type { Density, Registry } from '../registry.js';
import { ItemSlot } from './ItemSlot.js';
import { isoOf } from '../hooks/useGridKeyboard.js';

export interface AllDayRowProps {
  days: readonly CalendarDate[];
  segments: readonly AllDaySegment[];
  overflow: readonly CellOverflow[];
  itemsById: ReadonlyMap<string, CalendarItem>;
  registry: Registry;
  density: Density;
  maxVisible: number;
  selectedId: string | null;
  onActivate: (item: CalendarItem, anchor: HTMLElement) => void;
  onDragStart?: ((item: CalendarItem, e: PointerEvent<HTMLElement>, fromIso: string) => void) | undefined;
  registerFlip?: ((el: HTMLElement | null, key: string) => void) | undefined;
  enteringIds?: ReadonlySet<string> | undefined;
  keyPrefix: string;
  /** Rendered per column beneath the bars (day headers, "+N more"). */
  renderCell?: ((date: CalendarDate, col: number, overflow: CellOverflow) => ReactNode) | undefined;
  barHeight: number;
  dropTarget?: string | null | undefined;
}

/**
 * Bars spanning day columns on a CSS grid. Row 1 is the cell header;
 * a bar occupies `grid-row: row + 2`. Hidden rows (beyond the cap) are
 * not rendered; each column's "+N more" comes from `overflow`.
 */
export function AllDayRow(props: AllDayRowProps): JSX.Element {
  const { days, segments, overflow, itemsById, registry, density, maxVisible, selectedId, onActivate, onDragStart, registerFlip, enteringIds, keyPrefix, renderCell, barHeight, dropTarget } = props;
  const anyOverflow = overflow.some((o) => o.overflow > 0);
  const rowLimit = anyOverflow ? Math.max(0, maxVisible - 1) : maxVisible;
  const shown = segments.filter((s) => s.row < rowLimit);
  const rows = Math.min(rowLimit, shown.reduce((m, s) => Math.max(m, s.row + 1), 0));
  const cols = days.length;
  return (
    <div className="cal-allday" role="row" style={{ ['--cal-columns' as string]: String(cols), ['--cal-bar-rows' as string]: String(rows + (anyOverflow ? 1 : 0)) }}>
      {days.map((date, col) => {
        const iso = isoOf(date);
        const o = overflow[col] ?? { visible: [], hidden: [], overflow: 0 };
        return (
          <div key={iso} className={`cal-cell ${dropTarget === iso ? 'is-drop-target' : ''}`} role="gridcell" data-date={iso} data-col={col} style={{ gridColumn: col + 1, gridRow: '1 / -1' }}>
            {renderCell?.(date, col, o)}
          </div>
        );
      })}
      {shown.map((s) => {
        const item = itemsById.get(s.itemId);
        if (item === undefined) return null;
        const fromIso = isoOf(days[s.startCol] ?? days[0] ?? date0(days));
        const width = s.endCol - s.startCol + 1;
        return (
          <ItemSlot
            key={`${keyPrefix}:${s.itemId}`}
            item={item}
            registry={registry}
            density={density}
            boxHint={{ width: 120 * width, height: barHeight }}
            className="cal-bar"
            style={{ gridColumn: `${s.startCol + 1} / ${s.endCol + 2}`, gridRow: s.row + 2, height: barHeight }}
            isSelected={selectedId === item.id}
            onActivate={onActivate}
            onDragStart={onDragStart === undefined ? undefined : (it, e) => onDragStart(it, e, fromIso)}
            registerFlip={registerFlip === undefined ? undefined : (el) => registerFlip(el, `${keyPrefix}:${s.itemId}`)}
            entering={enteringIds?.has(item.id) ?? false}
            continuesBefore={s.continuesBefore}
            continuesAfter={s.continuesAfter}
          />
        );
      })}
    </div>
  );
}

function date0(days: readonly CalendarDate[]): CalendarDate {
  const d = days[0];
  if (d === undefined) throw new Error('AllDayRow: no days');
  return d;
}
