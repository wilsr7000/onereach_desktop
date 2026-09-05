import { useEffect, useState } from 'react';

export type MotionPreference = 'auto' | 'reduced' | 'none';

/** True when motion should be reduced: the OS preference, or the calendar's `motion` prop. */
export function useReducedMotion(preference: MotionPreference = 'auto'): boolean {
  const [system, setSystem] = useState<boolean>(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  });
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = (): void => setSystem(mq.matches);
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
  }, []);
  return preference === 'none' || preference === 'reduced' || system;
}
