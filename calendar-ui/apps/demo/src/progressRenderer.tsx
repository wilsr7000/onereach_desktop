import type { CompactProps, ItemRenderer } from '@calendar/react';

/** A fourth item type, registered only here: proof that the core needs no change for a new type. */
export interface ProgressPayload {
  label: string;
  fraction: number;
}

function Compact({ item, box }: CompactProps<ProgressPayload>): JSX.Element {
  const pct = Math.round(Math.max(0, Math.min(1, item.payload.fraction)) * 100);
  return (
    <div className="demo-progress" style={{ height: box.height }}>
      <span className="demo-progress__label">{item.payload.label}</span>
      <span className="demo-progress__track"><span className="demo-progress__fill" style={{ width: `${pct}%` }} /></span>
      {box.height > 30 ? <span className="demo-progress__pct">{pct}%</span> : null}
    </div>
  );
}

export const progressRenderer: ItemRenderer<ProgressPayload> = {
  type: 'progress',
  Compact,
  minCompactHeight: 18,
  getLabel: (item) => `${item.payload.label}, ${Math.round(item.payload.fraction * 100)}%`,
  color: () => '#b26a00',
};
