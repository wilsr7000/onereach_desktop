import { useLayoutEffect, useRef } from 'react';

/**
 * FLIP: measure every keyed element before and after a render and animate
 * the difference with a transform, so items glide to their new slot after
 * a drag, a data change, or navigation. Uses the Web Animations API when
 * present; a no-op under reduced motion or in environments without it.
 */
export function useFlip(deps: readonly unknown[], enabled: boolean, durationMs = 220): (el: HTMLElement | null, key: string) => void {
  const nodes = useRef(new Map<string, HTMLElement>());
  const previous = useRef(new Map<string, DOMRect>());
  const register = (el: HTMLElement | null, key: string): void => {
    if (el === null) nodes.current.delete(key);
    else nodes.current.set(key, el);
  };
  useLayoutEffect(() => {
    const before = previous.current;
    const after = new Map<string, DOMRect>();
    for (const [key, el] of nodes.current) after.set(key, el.getBoundingClientRect());
    if (enabled) {
      for (const [key, el] of nodes.current) {
        const b = before.get(key);
        const a = after.get(key);
        if (b === undefined || a === undefined || typeof el.animate !== 'function') continue;
        const dx = b.left - a.left;
        const dy = b.top - a.top;
        const sx = a.width > 0 ? b.width / a.width : 1;
        const sy = a.height > 0 ? b.height / a.height : 1;
        if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5 && Math.abs(sx - 1) < 0.01 && Math.abs(sy - 1) < 0.01) continue;
        el.animate([{ transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`, transformOrigin: 'top left' }, { transform: 'none', transformOrigin: 'top left' }], { duration: durationMs, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' });
      }
    }
    previous.current = after;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return register;
}
