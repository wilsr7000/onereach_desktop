import type { CalendarItem } from '@calendar/core';
import type { MouseEvent } from 'react';
import type { CompactProps, ItemRenderer } from '../registry.js';

export interface ButtonPayload {
  label: string;
  onClick: (item: CalendarItem<ButtonPayload>) => void;
  color?: string;
}

/**
 * A real <button>. Its click is its own: it marks the event as handled
 * with preventDefault(), and the calendar's slot ignores handled events.
 * No stopPropagation, so anything above (analytics, focus management)
 * still sees the click.
 */
function Compact({ item, box }: CompactProps<ButtonPayload>): JSX.Element {
  const onClick = (e: MouseEvent<HTMLButtonElement>): void => {
    e.preventDefault();
    item.payload.onClick(item);
  };
  return (
    <button type="button" className={`cal-button ${box.height < 28 ? 'cal-button--slim' : ''}`} onClick={onClick} style={item.payload.color !== undefined ? { ['--cal-item-accent' as string]: item.payload.color } : undefined}>
      {item.payload.label}
    </button>
  );
}

export const buttonRenderer: ItemRenderer<ButtonPayload> = {
  type: 'button',
  Compact,
  minCompactHeight: 22,
  getLabel: (item) => item.payload.label,
  color: (item) => item.payload.color ?? 'var(--cal-accent-2)',
};
