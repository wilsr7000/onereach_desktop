import type { CalendarItem } from '@calendar/core';
import type { CalendarDate } from '@internationalized/date';
import type { PointerEvent } from 'react';
import type { CalendarLayout } from '../hooks/useLayout.js';
import { isoOf } from '../hooks/useGridKeyboard.js';
import type { Registry } from '../registry.js';
import { AllDayRow } from '../primitives/AllDayRow.js';

export interface MonthViewProps {
  layout: CalendarLayout;
  registry: Registry;
  maxVisiblePerCell: number;
  selectedId: string | null;
  focusedIso: string | null;
  todayIso: string | null;
  onActivate: (item: CalendarItem, anchor: HTMLElement) => void;
  onOverflow: (date: CalendarDate) => void;
  onDragStart?: ((item: CalendarItem, e: PointerEvent<HTMLElement>, fromIso: string) => void) | undefined;
  dropTarget: string | null;
  registerFlip?: ((el: HTMLElement | null, key: string) => void) | undefined;
  enteringIds?: ReadonlySet<string> | undefined;
  onCellFocus: (iso: string) => void;
}

export function MonthView(props: MonthViewProps): JSX.Element {
  const { layout, registry, maxVisiblePerCell, selectedId, focusedIso, todayIso, onActivate, onOverflow, onDragStart, dropTarget, registerFlip, enteringIds, onCellFocus } = props;
  const anchorMonth = layout.range.anchor.month;
  return (
    <div className="cal-month" role="rowgroup">
      {layout.weeks.map((week, w) => (
        <AllDayRow
          key={isoOf(week.days[0] ?? layout.range.start)}
          days={week.days}
          segments={week.segments}
          overflow={week.overflow}
          itemsById={layout.itemsById}
          registry={registry}
          density="month"
          maxVisible={maxVisiblePerCell}
          selectedId={selectedId}
          onActivate={onActivate}
          onDragStart={onDragStart}
          registerFlip={registerFlip}
          enteringIds={enteringIds}
          keyPrefix={`w${w}`}
          barHeight={22}
          dropTarget={dropTarget}
          renderCell={(date, _col, overflow) => {
            const iso = isoOf(date);
            const outside = date.month !== anchorMonth;
            return (
              <div className={`cal-daycell ${outside ? 'is-outside' : ''} ${iso === todayIso ? 'is-today' : ''} ${iso === focusedIso ? 'is-focused' : ''}`} tabIndex={iso === (focusedIso ?? isoOf(layout.range.anchor)) ? 0 : -1} data-focus-target onFocus={() => onCellFocus(iso)}>
                <span className="cal-daynum">{date.day}</span>
                {overflow.overflow > 0 ? (
                  <button type="button" className="cal-more" onClick={(e) => { e.preventDefault(); onOverflow(date); }} aria-label={`${overflow.overflow} more on ${iso}`}>
                    +{overflow.overflow} more
                  </button>
                ) : null}
              </div>
            );
          }}
        />
      ))}
    </div>
  );
}
