import { useLayoutEffect, useState, type RefObject } from 'react';
import type { Box } from '../registry.js';

/** The rendered size of an element; falls back to the hint until a ResizeObserver reports. */
export function useElementSize(ref: RefObject<HTMLElement>, hint: Box): Box {
  const [size, setSize] = useState<Box | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null || typeof ResizeObserver === 'undefined') return;
    const read = (): void => {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 || rect.height > 0) setSize({ width: rect.width, height: rect.height });
    };
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size ?? hint;
}
