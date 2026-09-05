import { dayRangeOf, instantMs, type CalendarItem, type TimedPlacement } from '@calendar/core';
import { toTimeZone, type CalendarDate } from '@internationalized/date';
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from 'react';
import { useTimedDrag, type DragState } from '../hooks/useDrag.js';
import { isoOf } from '../hooks/useGridKeyboard.js';
import type { Density, Registry } from '../registry.js';
import { ItemSlot } from './ItemSlot.js';

export interface TimeGridProps {
  days: readonly { date: CalendarDate; placements: TimedPlacement[] }[];
  timeZone: string;
  itemsById: ReadonlyMap<string, CalendarItem>;
  registry: Registry;
  density: Density;
  hourRange: readonly [number, number];
  slotMinutes: number;
  selectedId: string | null;
  focusedIso: string | null;
  onActivate: (item: CalendarItem, anchor: HTMLElement) => void;
  onItemChange?: ((item: CalendarItem) => void) | undefined;
  registerFlip?: ((el: HTMLElement | null, key: string) => void) | undefined;
  enteringIds?: ReadonlySet<string> | undefined;
  nowMs?: number | undefined;
  onDragStateChange?: ((drag: DragState | null) => void) | undefined;
}

const HOUR_MS = 3_600_000;

/**
 * Hour rows and day columns. Positions come from the layout as fractions
 * of the day's absolute length; this component turns them into pixels
 * with the hour height from CSS. Structured so a virtualised variant
 * could replace it: it owns no item logic beyond placement and drag.
 */
export function TimeGrid(props: TimeGridProps): JSX.Element {
  const { days, timeZone, itemsById, registry, density, hourRange, slotMinutes, selectedId, focusedIso, onActivate, onItemChange, registerFlip, enteringIds, nowMs } = props;
  const [h0, h1] = hourRange;
  const rootRef = useRef<HTMLDivElement>(null);
  const [metrics, setMetrics] = useState({ hourHeight: 48, columnWidth: 0 });
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (el === null) return;
    const read = (): void => {
      const hh = Number.parseFloat(getComputedStyle(el).getPropertyValue('--cal-hour-height')) || 48;
      const col = el.querySelector<HTMLElement>('.cal-col');
      setMetrics({ hourHeight: hh, columnWidth: col?.getBoundingClientRect().width ?? 0 });
    };
    read();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [days.length]);
  const { drag, start } = useTimedDrag(onItemChange, { hourHeight: metrics.hourHeight, columnWidth: metrics.columnWidth, slotMinutes, columns: days.length });
  // Report drag state to the parent from an effect, never during render.
  const onDragStateChange = props.onDragStateChange;
  useEffect(() => {
    onDragStateChange?.(drag);
  }, [drag, onDragStateChange]);
  const visibleHours = h1 - h0;
  const gridHeight = visibleHours * metrics.hourHeight;
  const hourLabels = (date: CalendarDate): string[] => {
    const range = dayRangeOf(date, timeZone);
    const out: string[] = [];
    for (let i = h0; i < h1; i += 1) {
      const at = range.start.add({ hours: i });
      const local = toTimeZone(at, timeZone);
      out.push(`${String(local.hour).padStart(2, '0')}:00`);
    }
    return out;
  };
  const first = days[0];
  const labels = first === undefined ? [] : hourLabels(first.date);
  return (
    <div ref={rootRef} className="cal-timegrid" role="rowgroup" style={{ ['--cal-visible-hours' as string]: String(visibleHours) }}>
      <div className="cal-hours" aria-hidden="true">
        {labels.map((label, i) => (
          <div key={i} className="cal-hour-label" style={{ top: i * metrics.hourHeight }}>
            {label}
          </div>
        ))}
      </div>
      <div className="cal-cols" role="row" style={{ height: gridHeight }}>
        {days.map(({ date, placements }) => {
          const iso = isoOf(date);
          const range = dayRangeOf(date, timeZone);
          const dayMs = instantMs(range.end) - instantMs(range.start);
          const hoursInDay = dayMs / HOUR_MS;
          const toPx = (fraction: number): number => (fraction * hoursInDay - h0) * metrics.hourHeight;
          const minHeight = (slotMinutes / 60) * metrics.hourHeight;
          const nowTop = nowMs !== undefined && nowMs >= instantMs(range.start) && nowMs < instantMs(range.end) ? toPx((nowMs - instantMs(range.start)) / dayMs) : null;
          return (
            <div key={iso} className={`cal-col ${focusedIso === iso ? 'is-focused' : ''}`} role="gridcell" data-date={iso} aria-label={date.toString()}>
              {labels.map((_, i) => (
                <div key={i} className="cal-hour-line" style={{ top: i * metrics.hourHeight }} aria-hidden="true" />
              ))}
              {placements.map((p) => {
                const base = itemsById.get(p.itemId);
                if (base === undefined) return null;
                const dragging = drag !== null && drag.item.id === p.itemId;
                const item = dragging ? drag.tentative : base;
                let top = toPx(p.top);
                let height = Math.max(p.height * hoursInDay * metrics.hourHeight, minHeight);
                if (dragging) {
                  const s = Math.max(instantMs(item.start), instantMs(range.start));
                  const e = Math.min(instantMs(item.end), instantMs(range.end));
                  top = toPx((s - instantMs(range.start)) / dayMs);
                  height = Math.max(((e - s) / dayMs) * hoursInDay * metrics.hourHeight, minHeight);
                }
                const width = 100 / p.columnCount;
                const key = `${iso}:${p.itemId}`;
                return (
                  <ItemSlot
                    key={key}
                    item={item}
                    registry={registry}
                    density={density}
                    boxHint={{ width: metrics.columnWidth * (width / 100), height }}
                    className={`cal-timed ${dragging ? 'is-dragging' : ''} ${p.lane !== null ? 'has-lane' : ''}`}
                    style={{ top, height, left: `${p.column * width}%`, width: `calc(${width}% - 2px)` }}
                    isSelected={selectedId === p.itemId}
                    onActivate={onActivate}
                    onDragStart={onItemChange === undefined ? undefined : (it, e, mode) => start(it, e as PointerEvent<HTMLElement>, mode)}
                    resizable={onItemChange !== undefined}
                    registerFlip={registerFlip === undefined ? undefined : (el) => registerFlip(el, key)}
                    entering={enteringIds?.has(p.itemId) ?? false}
                    continuesBefore={p.clippedStart}
                    continuesAfter={p.clippedEnd}
                  />
                );
              })}
              {nowTop !== null ? (
                <div className="cal-now" style={{ top: nowTop }} aria-hidden="true">
                  <span className="cal-now__dot" />
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
