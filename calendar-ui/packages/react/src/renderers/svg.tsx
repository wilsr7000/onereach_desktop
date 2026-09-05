import { isValidElement, useMemo, type ReactNode } from 'react';
import type { CompactProps, ItemRenderer } from '../registry.js';
import { sanitizeSvg, svgAspectRatio } from './svg-sanitize.js';

export interface SvgPayload {
  /** An SVG document string (sanitised) or a React node (rendered as given). */
  svg: string | ReactNode;
  /** Aspect ratio for React-node payloads (string payloads read their viewBox). Default 1. */
  aspectRatio?: number;
  title?: string;
}

/** Scaled to fit the box at a fixed aspect ratio, centered, never distorted. */
function Compact({ item, box }: CompactProps<SvgPayload>): JSX.Element {
  const payload = item.payload;
  const isString = typeof payload.svg === 'string';
  const ratio = isString ? svgAspectRatio(payload.svg as string) : payload.aspectRatio ?? 1;
  const width = Math.min(box.width, box.height * ratio);
  const height = width / ratio;
  const html = useMemo(() => (isString ? sanitizeSvg(payload.svg as string) : ''), [isString, payload.svg]);
  const style = { width: `${Math.max(0, width)}px`, height: `${Math.max(0, height)}px` };
  if (isString) return <div className="cal-svg" role="img" aria-label={payload.title ?? 'graphic'} style={style} dangerouslySetInnerHTML={{ __html: html }} />;
  return (
    <div className="cal-svg" role="img" aria-label={payload.title ?? 'graphic'} style={style}>
      {isValidElement(payload.svg) ? payload.svg : null}
    </div>
  );
}

export const svgRenderer: ItemRenderer<SvgPayload> = {
  type: 'svg',
  Compact,
  minCompactHeight: 16,
  getLabel: (item) => item.payload.title ?? 'graphic',
};
