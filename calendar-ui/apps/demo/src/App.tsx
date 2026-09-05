import { useCallback, useMemo, useState } from 'react';
import { CalendarDate, today as todayIn, now as nowIn } from '@internationalized/date';
import type { CalendarItem, View, WeekStartsOn } from '@calendar/core';
import { Calendar, buttonRenderer, createRegistry, svgRenderer, textRenderer, type CalendarStatus, type MotionPreference } from '@calendar/react';
import { progressRenderer } from './progressRenderer.js';
import { seedItems, TZ } from './seed.js';

const registry = createRegistry().register(textRenderer).register(buttonRenderer).register(svgRenderer).register(progressRenderer);

export function App(): JSX.Element {
  const [view, setView] = useState<View>('month');
  const [anchor, setAnchor] = useState(() => new CalendarDate(2026, 9, 4));
  const [weekStartsOn, setWeekStartsOn] = useState<WeekStartsOn>(0);
  const [status, setStatus] = useState<CalendarStatus>('idle');
  const [motion, setMotion] = useState<MotionPreference>('auto');
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [clicks, setClicks] = useState<Record<string, number>>({});
  const [editable, setEditable] = useState(true);
  const onButton = useCallback((label: string) => setClicks((c) => ({ ...c, [label]: (c[label] ?? 0) + 1 })), []);
  const [items, setItems] = useState<CalendarItem[]>(() => seedItems(onButton));
  const shown = useMemo(() => (status === 'loading' ? [] : items), [items, status]);
  const onItemChange = useCallback((next: CalendarItem) => setItems((list) => list.map((i) => (i.id === next.id ? next : i))), []);
  const nav = (delta: number): void => setAnchor((a) => (view === 'month' ? a.add({ months: delta }) : a.add({ days: delta * (view === 'week' ? 7 : 1) })));
  const label = view === 'month' ? anchor.toDate(TZ).toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: TZ }) : anchor.toDate(TZ).toLocaleDateString(undefined, { dateStyle: 'medium', timeZone: TZ });
  return (
    <div className="demo" data-theme={theme}>
      <header className="demo-bar">
        <div className="demo-group">
          <button type="button" onClick={() => nav(-1)} aria-label="Previous">‹</button>
          <button type="button" onClick={() => setAnchor(todayIn(TZ))}>Today</button>
          <button type="button" onClick={() => nav(1)} aria-label="Next">›</button>
          <strong className="demo-title">{label}</strong>
        </div>
        <div className="demo-group" role="group" aria-label="View">
          {(['month', 'week', 'day'] as const).map((v) => (
            <button key={v} type="button" className={view === v ? 'is-on' : ''} onClick={() => setView(v)}>{v}</button>
          ))}
        </div>
        <div className="demo-group">
          <label>week starts <select value={weekStartsOn} onChange={(e) => setWeekStartsOn(Number(e.target.value) as WeekStartsOn)}><option value={0}>Sunday</option><option value={1}>Monday</option><option value={6}>Saturday</option></select></label>
          <label>status <select value={status} onChange={(e) => setStatus(e.target.value as CalendarStatus)}><option value="idle">idle</option><option value="loading">loading</option><option value="refreshing">refreshing</option><option value="error">error</option></select></label>
          <label>motion <select value={motion} onChange={(e) => setMotion(e.target.value as MotionPreference)}><option value="auto">auto</option><option value="reduced">reduced</option><option value="none">none</option></select></label>
          <label><input type="checkbox" checked={editable} onChange={(e) => setEditable(e.target.checked)} /> drag &amp; resize</label>
          <button type="button" onClick={() => setTheme((t) => (t === 'light' ? 'dark' : 'light'))}>{theme === 'light' ? 'dark' : 'light'} theme</button>
        </div>
        <div className="demo-group demo-counter" aria-live="polite">
          {Object.keys(clicks).length === 0 ? 'button items not clicked yet' : Object.entries(clicks).map(([k, v]) => `${k} ×${v}`).join(' · ')}
        </div>
      </header>
      <main className="demo-main">
        <Calendar items={shown} registry={registry} view={view} anchorDate={anchor} timeZone={TZ} weekStartsOn={weekStartsOn} hourRange={[0, 24]} slotMinutes={15} status={status} errorMessage="Could not reach the schedule service. Showing what was loaded." motion={motion} today={todayIn(TZ)} nowMs={nowIn(TZ).toDate().getTime()} onNavigate={(d, v) => { setAnchor(d); setView(v); }} onItemActivate={() => undefined} {...(editable ? { onItemChange } : {})} className={`demo-cal`} />
      </main>
      <footer className="demo-foot">
        Text, button and svg renderers ship with the library; <code>progress</code> is registered by this demo only. <code>video</code> is deliberately unregistered. Drag timed items in week and day views; drag all-day bars between days in month and week.
      </footer>
    </div>
  );
}
