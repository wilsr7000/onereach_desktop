import type { CalendarItem } from '@calendar/core';
import type { PointerEvent } from 'react';
import type { CalendarLayout } from '../hooks/useLayout.js';
import { isoOf } from '../hooks/useGridKeyboard.js';
import type { DragState } from '../hooks/useDrag.js';
import type { Registry } from '../registry.js';
import { AllDayRow } from '../primitives/AllDayRow.js';
import { TimeGrid } from '../primitives/TimeGrid.js';

export interface WeekViewProps {
  layout: CalendarLayout;
  registry: Registry;
  density: 'week' | 'day';
  hourRange: readonly [number, number];
  slotMinutes: number;
  maxVisiblePerCell: number;
  selectedId: string | null;
  focusedIso: string | null;
  todayIso: string | null;
  nowMs: number | undefined;
  onActivate: (item: CalendarItem, anchor: HTMLElement) => void;
  onItemChange?: ((item: CalendarItem) => void) | undefined;
  onAllDayDragStart?: ((item: CalendarItem, e: PointerEvent<HTMLElement>, fromIso: string) => void) | undefined;
  dropTarget: string | null;
  registerFlip?: ((el: HTMLElement | null, key: string) => void) | undefined;
  enteringIds?: ReadonlySet<string> | undefined;
  onDragStateChange?: ((drag: DragState | null) => void) | undefined;
  onCellFocus: (iso: string) => void;
}

/** Week and day views are the same composition with a different number of columns. */
export function WeekView(props: WeekViewProps): JSX.Element {
  const { layout, registry, density, hourRange, slotMinutes, maxVisiblePerCell, selectedId, focusedIso, todayIso, nowMs, onActivate, onItemChange, onAllDayDragStart, dropTarget, registerFlip, enteringIds, onDragStateChange, onCellFocus } = props;
  const week = layout.weeks[0];
  return (
    <div className={`cal-week cal-week--${density}`}>
      <div className="cal-week__head" role="row">
        <div className="cal-week__corner" aria-hidden="true" />
        {layout.range.days.map((d) => {
          const iso = isoOf(d);
          return (
            <div key={iso} className={`cal-week__day ${iso === todayIso ? 'is-today' : ''} ${iso === focusedIso ? 'is-focused' : ''}`} role="columnheader" tabIndex={iso === (focusedIso ?? isoOf(layout.range.anchor)) ? 0 : -1} data-focus-target data-date={iso} onFocus={() => onCellFocus(iso)}>
              <span className="cal-week__dow">{d.toDate(layout.range.timeZone).toLocaleDateString(undefined, { weekday: 'short', timeZone: layout.range.timeZone })}</span>
              <span className="cal-week__num">{d.day}</span>
            </div>
          );
        })}
      </div>
      {week !== undefined ? (
        <div className="cal-week__allday">
          <div className="cal-week__corner cal-week__corner--allday" aria-hidden="true">
            all day
          </div>
          <AllDayRow days={week.days} segments={week.segments} overflow={week.overflow} itemsById={layout.itemsById} registry={registry} density={density} maxVisible={maxVisiblePerCell} selectedId={selectedId} onActivate={onActivate} onDragStart={onAllDayDragStart} registerFlip={registerFlip} enteringIds={enteringIds} keyPrefix="allday" barHeight={22} dropTarget={dropTarget} />
        </div>
      ) : null}
      <div className="cal-week__body">
        <TimeGrid days={layout.days} timeZone={layout.range.timeZone} itemsById={layout.itemsById} registry={registry} density={density} hourRange={hourRange} slotMinutes={slotMinutes} selectedId={selectedId} focusedIso={focusedIso} onActivate={onActivate} onItemChange={onItemChange} registerFlip={registerFlip} enteringIds={enteringIds} nowMs={nowMs} onDragStateChange={onDragStateChange} />
      </div>
    </div>
  );
}
