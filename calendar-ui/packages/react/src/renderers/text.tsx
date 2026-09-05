import type { CalendarItem } from '@calendar/core';
import type { CompactProps, ExpandedProps, ItemRenderer } from '../registry.js';

export interface TextPayload {
  title: string;
  body?: string;
  color?: string;
}

function Compact({ item, density, box }: CompactProps<TextPayload>): JSX.Element {
  const single = density === 'month' || box.height < 36;
  return (
    <div className={`cal-text ${single ? 'cal-text--single' : 'cal-text--multi'}`} style={item.payload.color !== undefined ? { ['--cal-item-accent' as string]: item.payload.color } : undefined}>
      <span className="cal-text__title">{item.payload.title}</span>
      {!single && item.payload.body !== undefined ? <span className="cal-text__body">{item.payload.body}</span> : null}
    </div>
  );
}

function Expanded({ item, onClose }: ExpandedProps<TextPayload>): JSX.Element {
  return (
    <div className="cal-expanded">
      <h3 className="cal-expanded__title">{item.payload.title}</h3>
      {item.payload.body !== undefined ? <p className="cal-expanded__body">{item.payload.body}</p> : null}
      <p className="cal-expanded__when">
        {item.allDay ? 'All day' : `${item.start.toDate().toLocaleString()} – ${item.end.toDate().toLocaleTimeString()}`}
      </p>
      <button type="button" className="cal-btn" onClick={onClose}>
        Close
      </button>
    </div>
  );
}

export const textRenderer: ItemRenderer<TextPayload> = {
  type: 'text',
  Compact,
  Expanded,
  minCompactHeight: 18,
  getLabel: (item: CalendarItem<TextPayload>) => item.payload.title,
  color: (item) => item.payload.color ?? 'var(--cal-accent)',
};
