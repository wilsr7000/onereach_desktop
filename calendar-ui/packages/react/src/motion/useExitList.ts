import { useEffect, useRef, useState } from 'react';

export interface ExitEntry<T> {
  key: string;
  value: T;
  leaving: boolean;
}

/** Keeps removed entries around for `holdMs` so they can fade out; new entries are marked as entering by the caller. */
export function useExitList<T>(entries: ReadonlyArray<{ key: string; value: T }>, holdMs: number): ExitEntry<T>[] {
  const [leaving, setLeaving] = useState<Map<string, T>>(new Map());
  const seen = useRef(new Map<string, T>());
  useEffect(() => {
    const current = new Map(entries.map((e) => [e.key, e.value] as const));
    const gone = new Map<string, T>();
    for (const [key, value] of seen.current) if (!current.has(key)) gone.set(key, value);
    seen.current = current;
    if (gone.size === 0 || holdMs <= 0) return;
    setLeaving((prev) => new Map([...prev, ...gone]));
    const timer = window.setTimeout(() => setLeaving((prev) => { const next = new Map(prev); for (const k of gone.keys()) next.delete(k); return next; }), holdMs);
    return () => window.clearTimeout(timer);
  }, [entries, holdMs]);
  const out: ExitEntry<T>[] = entries.map((e) => ({ key: e.key, value: e.value, leaving: false }));
  for (const [key, value] of leaving) if (!entries.some((e) => e.key === key)) out.push({ key, value, leaving: true });
  return out;
}
