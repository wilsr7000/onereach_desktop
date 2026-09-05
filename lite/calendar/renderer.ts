/**
 * Calendar renderer (ADR-090): the account's scheduled flows on a month
 * grid, a day pane, and a detail pane that opens the flow in GSX
 * Designer. Pure builders are exported for tests; the page boots only
 * when the calendar DOM is present.
 */
type Bridge = NonNullable<NonNullable<typeof window.lite>['calendar']>;
type Occurrence = LiteCalendarOccurrence;
type Scheduled = LiteCalendarScheduledFlow;
type Snapshot = LiteCalendarSnapshot;

export interface DayKey {
  year: number;
  month: number; // 1..12
  day: number;
}

export const dayKey = (d: DayKey): string => `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;
export const keyOf = (ms: number): string => {
  const d = new Date(ms);
  return dayKey({ year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() });
};
const fmtTime = (ms: number): string => new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
const fmtDateTime = (ms: number): string => new Date(ms).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined && className.length > 0) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Runs of one (flow, event) on one day, collapsed. */
export interface RunGroup {
  flowId: string;
  botId: string;
  eventId: string;
  flowLabel: string;
  eventName: string;
  botLabel: string;
  color: string;
  timeZone: string;
  times: number[];
}

export function groupRuns(occurrences: Occurrence[]): RunGroup[] {
  const map = new Map<string, RunGroup>();
  for (const o of occurrences) {
    const k = `${o.flowId}|${o.eventId}`;
    let g = map.get(k);
    if (g === undefined) {
      g = { flowId: o.flowId, botId: o.botId, eventId: o.eventId, flowLabel: o.flowLabel, eventName: o.eventName, botLabel: o.botLabel, color: o.color, timeZone: o.timeZone, times: [] };
      map.set(k, g);
    }
    g.times.push(o.atMs);
  }
  const out = [...map.values()];
  for (const g of out) g.times.sort((a, b) => a - b);
  out.sort((a, b) => (a.times[0] ?? 0) - (b.times[0] ?? 0) || a.flowLabel.localeCompare(b.flowLabel));
  return out;
}

/** "every 5 min, 00:00–23:55 (288 runs)" for a uniform series, else "N runs, 09:00–17:30". */
export function describeSeries(times: number[]): string {
  if (times.length === 0) return 'no runs';
  if (times.length === 1) return fmtTime(times[0] ?? 0);
  const first = times[0] ?? 0;
  const last = times[times.length - 1] ?? 0;
  const gaps = new Set<number>();
  for (let i = 1; i < times.length; i += 1) gaps.add((times[i] ?? 0) - (times[i - 1] ?? 0));
  const span = `${fmtTime(first)}–${fmtTime(last)}`;
  if (gaps.size === 1) {
    const gap = [...gaps][0] ?? 0;
    const minutes = Math.round(gap / 60000);
    const every = minutes % 60 === 0 ? `${minutes / 60} h` : `${minutes} min`;
    return `every ${every}, ${span} (${times.length} runs)`;
  }
  return `${times.length} runs, ${span}`;
}

/** Bucket occurrences by local day. */
export function byDay(occurrences: Occurrence[]): Map<string, Occurrence[]> {
  const map = new Map<string, Occurrence[]>();
  for (const o of occurrences) {
    const k = keyOf(o.atMs);
    const list = map.get(k);
    if (list === undefined) map.set(k, [o]);
    else list.push(o);
  }
  return map;
}

export interface GridOptions {
  year: number;
  month: number; // 1..12
  selected: string | null;
  today: string;
  onSelect: (key: string) => void;
}

/** The 6×7 month grid; each cell lists its runs collapsed per (flow, event). */
export function buildMonthGrid(occurrences: Occurrence[], opts: GridOptions): HTMLElement {
  const grid = el('div', 'cal-grid');
  grid.setAttribute('role', 'grid');
  const first = new Date(opts.year, opts.month - 1, 1);
  const start = new Date(first);
  start.setDate(1 - first.getDay());
  const days = byDay(occurrences);
  for (let i = 0; i < 42; i += 1) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    const key = dayKey({ year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() });
    const outside = d.getMonth() !== opts.month - 1;
    const cell = el('button', `cal-day${outside ? ' is-outside' : ''}${key === opts.today ? ' is-today' : ''}${key === opts.selected ? ' is-selected' : ''}`);
    cell.type = 'button';
    cell.dataset['day'] = key;
    cell.setAttribute('role', 'gridcell');
    cell.appendChild(el('span', 'cal-day-num', String(d.getDate())));
    const groups = groupRuns(days.get(key) ?? []);
    const shown = groups.slice(0, 4);
    for (const g of shown) {
      const chip = el('div', 'cal-chip');
      if (g.color.length > 0) chip.style.borderLeftColor = g.color;
      // A single run shows its time; a series shows its count instead (the title carries the span).
      if (g.times.length === 1) chip.appendChild(el('span', 'cal-chip-time', fmtTime(g.times[0] ?? 0)));
      chip.appendChild(el('span', 'cal-chip-text', `${g.eventName} · ${g.flowLabel}`));
      if (g.times.length > 1) chip.appendChild(el('span', 'cal-chip-count', `×${g.times.length}`));
      chip.title = `${g.flowLabel} — ${g.eventName}: ${describeSeries(g.times)} (${g.botLabel})`;
      cell.appendChild(chip);
    }
    if (groups.length > shown.length) cell.appendChild(el('div', 'cal-more', `+${groups.length - shown.length} more`));
    cell.setAttribute('aria-label', `${d.toDateString()}: ${groups.length === 0 ? 'no scheduled runs' : `${groups.length} scheduled flow${groups.length === 1 ? '' : 's'}`}`);
    cell.addEventListener('click', () => opts.onSelect(key));
    grid.appendChild(cell);
  }
  return grid;
}

export interface DayPaneOptions {
  key: string;
  onPick: (group: RunGroup) => void;
}

/** The selected day's runs, collapsed per (flow, event). */
export function buildDayPane(occurrences: Occurrence[], opts: DayPaneOptions): HTMLElement {
  const pane = el('div', 'cal-day-pane');
  const [y, m, d] = opts.key.split('-').map((v) => Number.parseInt(v, 10)) as [number, number, number];
  pane.appendChild(el('h3', undefined, new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })));
  const groups = groupRuns(occurrences);
  if (groups.length === 0) {
    pane.appendChild(el('div', 'cal-empty', 'No scheduled runs this day.'));
    return pane;
  }
  pane.appendChild(el('h4', undefined, `${groups.length} scheduled flow${groups.length === 1 ? '' : 's'}`));
  for (const g of groups) {
    const row = el('div', 'cal-run');
    row.dataset['flowId'] = g.flowId;
    row.appendChild(el('div', 'cal-run-time', fmtTime(g.times[0] ?? 0)));
    const body = el('div');
    body.appendChild(el('div', 'cal-run-flow', g.flowLabel));
    body.appendChild(el('div', 'cal-run-meta', `${g.eventName} · ${describeSeries(g.times)} · ${g.botLabel}`));
    row.appendChild(body);
    row.addEventListener('click', () => opts.onPick(g));
    pane.appendChild(row);
  }
  return pane;
}

export interface DetailOptions {
  nowMs: number;
  upcoming: Occurrence[];
  onOpen: (flow: Scheduled) => void;
  onBack: () => void;
}

const stateBadge = (flow: Scheduled): HTMLElement =>
  el('span', `cal-badge ${flow.armed ? 'is-on' : 'is-off'}`, flow.armed ? 'armed' : flow.active ? 'active · no schedule trigger' : 'not active');

/** One scheduled flow: its events, activation state, next runs, and the door to Designer. */
export function buildDetail(flow: Scheduled, opts: DetailOptions): HTMLElement {
  const pane = el('div', 'cal-detail');
  const back = el('button', 'cal-btn', '‹ Day');
  back.type = 'button';
  back.addEventListener('click', () => opts.onBack());
  pane.appendChild(back);
  const title = el('h3', undefined, flow.flowLabel);
  title.appendChild(stateBadge(flow));
  pane.appendChild(title);
  pane.appendChild(el('div', 'cal-muted', `${flow.botLabel} · ${flow.stepLabel}`));
  const row = (k: string, v: string | HTMLElement): void => {
    const r = el('div', 'cal-detail-row');
    r.appendChild(el('span', 'k', k));
    const val = el('span', 'v');
    if (typeof v === 'string') val.textContent = v;
    else val.appendChild(v);
    r.appendChild(val);
    pane.appendChild(r);
  };
  pane.appendChild(el('h4', undefined, 'Activation'));
  row('State', flow.armed ? 'Active; the Event Manager holds its schedule trigger.' : flow.active ? 'Active, but the deployment carries no schedule trigger.' : 'Not active: the schedule is authored but nothing will fire until the flow is activated.');
  if (flow.activatedMs > 0) row('Activated', fmtDateTime(flow.activatedMs));
  if (flow.nextFireMs !== null) row('Next fire (recorded)', fmtDateTime(flow.nextFireMs));
  pane.appendChild(el('h4', undefined, `Schedule${flow.events.length === 1 ? '' : 's'}`));
  for (const ev of flow.events) {
    const box = el('div', 'cal-event');
    const head = el('div');
    const sw = el('span', 'cal-swatch');
    if (ev.color.length > 0) sw.style.background = ev.color;
    head.appendChild(sw);
    head.appendChild(document.createTextNode(ev.name));
    box.appendChild(head);
    const r1 = el('div', 'cal-detail-row');
    r1.appendChild(el('span', 'k', 'Recurs'));
    r1.appendChild(el('span', 'v', ev.recurring ? (ev.preview.length > 0 ? ev.preview : 'on a schedule') : 'once'));
    box.appendChild(r1);
    const r2 = el('div', 'cal-detail-row');
    r2.appendChild(el('span', 'k', 'Time zone'));
    r2.appendChild(el('span', 'v', ev.timeZone));
    box.appendChild(r2);
    if (ev.start !== null || ev.end !== null) {
      const r3 = el('div', 'cal-detail-row');
      r3.appendChild(el('span', 'k', 'Window'));
      r3.appendChild(el('span', 'v', `${ev.start !== null ? `${ev.start.date} ${ev.start.time}` : 'open'} → ${ev.end !== null ? `${ev.end.date} ${ev.end.time}` : 'open'}`));
      box.appendChild(r3);
    }
    for (const c of ev.cron) {
      const r4 = el('div', 'cal-detail-row');
      r4.appendChild(el('span', 'k', 'Cron'));
      const v = el('span', 'v');
      v.appendChild(el('code', undefined, c));
      r4.appendChild(v);
      box.appendChild(r4);
    }
    if (ev.runAtActivation) box.appendChild(el('div', 'cal-muted', 'Also runs once at activation.'));
    pane.appendChild(box);
  }
  pane.appendChild(el('h4', undefined, 'Next runs'));
  const next = opts.upcoming.filter((o) => o.flowId === flow.flowId && o.atMs >= opts.nowMs).slice(0, 6);
  if (next.length === 0) pane.appendChild(el('div', 'cal-empty', 'No upcoming runs in the loaded window.'));
  else {
    const ul = el('ul', 'cal-list');
    for (const o of next) ul.appendChild(el('li', undefined, `${fmtDateTime(o.atMs)} · ${o.eventName}`));
    pane.appendChild(ul);
  }
  const actions = el('div', 'cal-side-actions');
  const open = el('button', 'cal-btn cal-btn-primary', 'Open in GSX Designer');
  open.type = 'button';
  open.id = 'cal-open-flow';
  open.addEventListener('click', () => opts.onOpen(flow));
  actions.appendChild(open);
  pane.appendChild(actions);
  return pane;
}

/** The header summary line. */
export function summaryText(snapshot: Snapshot | null, monthRuns: number): string {
  if (snapshot === null) return 'scheduled flows';
  const armed = snapshot.scheduled.filter((f) => f.armed).length;
  return `${snapshot.scheduled.length} scheduled flow${snapshot.scheduled.length === 1 ? '' : 's'} · ${armed} armed · ${monthRuns} run${monthRuns === 1 ? '' : 's'} this month`;
}

// ── Page ──────────────────────────────────────────────────────────────
const $ = (id: string): HTMLElement | null => document.getElementById(id);
const bridge = (): Bridge | null => window.lite?.calendar ?? null;

interface PageState {
  year: number;
  month: number;
  selected: string | null;
  snapshot: Snapshot | null;
  occurrences: Occurrence[];
  detail: Scheduled | null;
  busy: boolean;
}

function boot(): void {
  if ($('cal-grid') === null) return;
  const now = new Date();
  const state: PageState = { year: now.getFullYear(), month: now.getMonth() + 1, selected: keyOf(now.getTime()), snapshot: null, occurrences: [], detail: null, busy: false };
  const weekdays = $('cal-weekdays');
  if (weekdays !== null) weekdays.replaceChildren(...WEEKDAYS.map((w) => el('span', undefined, w)));

  const banner = (text: string, kind: '' | 'is-error' | 'is-warn'): void => {
    const b = $('cal-banner');
    if (b === null) return;
    b.textContent = text;
    b.className = `cal-banner ${kind}`.trim();
    b.hidden = text.length === 0;
  };
  const toast = (text: string): void => {
    const t = $('cal-toast');
    if (t === null) return;
    t.textContent = text;
    t.hidden = false;
    window.setTimeout(() => {
      t.hidden = true;
    }, 2600);
  };

  const render = (): void => {
    const today = keyOf(Date.now());
    const monthLabel = $('cal-month');
    if (monthLabel !== null) monthLabel.textContent = `${MONTHS[state.month - 1] ?? ''} ${state.year}`;
    const monthRuns = state.occurrences.filter((o) => {
      const d = new Date(o.atMs);
      return d.getFullYear() === state.year && d.getMonth() + 1 === state.month;
    }).length;
    const sub = $('cal-subtitle');
    if (sub !== null) sub.textContent = summaryText(state.snapshot, monthRuns);
    const g = buildMonthGrid(state.occurrences, {
      year: state.year,
      month: state.month,
      selected: state.selected,
      today,
      onSelect: (key) => {
        state.selected = key;
        state.detail = null;
        render();
      },
    });
    // Look the grid up fresh: the node is replaced on every render.
    const current = $('cal-grid');
    if (current === null) return;
    g.id = 'cal-grid';
    current.replaceWith(g);
    const side = $('cal-side');
    if (side === null) return;
    if (state.detail !== null) {
      side.replaceChildren(
        buildDetail(state.detail, {
          nowMs: Date.now(),
          upcoming: state.occurrences,
          onBack: () => {
            state.detail = null;
            render();
          },
          onOpen: (flow) => {
            const b = bridge();
            if (b === null) return;
            void b.openFlow({ flowId: flow.flowId, botId: flow.botId }).then((r) => {
              if (r.ok !== true) toast(r.error?.message ?? 'Could not open the flow.');
            });
          },
        })
      );
      return;
    }
    if (state.selected === null) {
      side.replaceChildren(el('div', 'cal-empty', 'Select a day to see its scheduled runs.'));
      return;
    }
    const sel = state.selected;
    const dayOccs = state.occurrences.filter((o) => keyOf(o.atMs) === sel);
    side.replaceChildren(
      buildDayPane(dayOccs, {
        key: sel,
        onPick: (group) => {
          state.detail = state.snapshot?.scheduled.find((f) => f.flowId === group.flowId) ?? null;
          render();
        },
      })
    );
    if (state.snapshot !== null && state.snapshot.scheduled.length === 0) {
      const empty = el('div', 'cal-empty');
      empty.style.marginTop = '14px';
      empty.textContent = 'No scheduled flows in this account. In GSX Designer, add a "Schedule execution" step to a flow and activate it.';
      side.appendChild(empty);
    }
  };

  const load = async (refresh = false): Promise<void> => {
    const b = bridge();
    if (b === null || state.busy) return;
    state.busy = true;
    const status = $('cal-status');
    if (status !== null) status.textContent = refresh ? 'Refreshing from GSX…' : 'Loading…';
    try {
      const from = new Date(state.year, state.month - 1, 1);
      from.setDate(from.getDate() - 7);
      const to = new Date(state.year, state.month, 1);
      to.setDate(to.getDate() + 7);
      const res = await b.occurrences({ fromMs: from.getTime(), toMs: to.getTime(), refresh });
      if (res.ok !== true || res.value === undefined) {
        const e = res.error;
        banner(e === undefined ? 'The calendar could not load.' : `${e.message}${e.remediation.length > 0 ? ` ${e.remediation}` : ''}`, 'is-error');
        if (status !== null) status.textContent = '';
        return;
      }
      state.snapshot = res.value.snapshot;
      state.occurrences = res.value.occurrences;
      const errs = res.value.snapshot.errors;
      banner(
        res.value.truncated ? 'Too many runs to show them all; the window was cut.' : errs.length > 0 ? `${errs.length} bot${errs.length === 1 ? '' : 's'} could not be listed: ${errs.map((e) => e.botLabel).join(', ')}.` : '',
        res.value.truncated || errs.length > 0 ? 'is-warn' : ''
      );
      if (status !== null) {
        const age = Math.max(0, Math.round((Date.now() - res.value.snapshot.fetchedAtMs) / 60000));
        status.textContent = `${res.value.snapshot.env} · ${res.value.snapshot.botCount} bots · ${res.value.snapshot.flowCount} flows · ${res.value.snapshot.activeDeployments} active · ${age === 0 ? 'just now' : `${age} min ago`}`;
      }
      render();
    } finally {
      state.busy = false;
    }
  };

  const shift = (delta: number): void => {
    let m = state.month + delta;
    let y = state.year;
    if (m < 1) {
      m = 12;
      y -= 1;
    } else if (m > 12) {
      m = 1;
      y += 1;
    }
    state.year = y;
    state.month = m;
    state.detail = null;
    render();
    void load();
  };
  $('cal-prev')?.addEventListener('click', () => shift(-1));
  $('cal-next')?.addEventListener('click', () => shift(1));
  $('cal-today')?.addEventListener('click', () => {
    const t = new Date();
    state.year = t.getFullYear();
    state.month = t.getMonth() + 1;
    state.selected = keyOf(t.getTime());
    state.detail = null;
    render();
    void load();
  });
  $('cal-refresh')?.addEventListener('click', () => void load(true));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft' && !e.metaKey && !e.ctrlKey) shift(-1);
    else if (e.key === 'ArrowRight' && !e.metaKey && !e.ctrlKey) shift(1);
    else if (e.key === 'r' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void load(true);
    }
  });
  render();
  void load();
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
}
