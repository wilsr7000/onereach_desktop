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
type SpaceEventsView = LiteCalendarSpaceEvents;
type SpaceEventDay = LiteCalendarSpaceEventDay;
type SpaceEvent = LiteCalendarSpaceEvent;
type LogSummary = LiteCalendarFlowLogSummary;

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
  /** false when the flow is not armed: its runs are drawn dimmed (they would not fire). */
  armed: boolean;
  eventId: string;
  flowLabel: string;
  eventName: string;
  botLabel: string;
  color: string;
  timeZone: string;
  description: string;
  times: number[];
}

export function groupRuns(occurrences: Occurrence[], armedById?: ReadonlyMap<string, boolean>): RunGroup[] {
  const map = new Map<string, RunGroup>();
  for (const o of occurrences) {
    const k = `${o.flowId}|${o.eventId}`;
    let g = map.get(k);
    if (g === undefined) {
      g = { flowId: o.flowId, botId: o.botId, armed: armedById?.get(o.flowId) ?? true, eventId: o.eventId, flowLabel: o.flowLabel, eventName: o.eventName, botLabel: o.botLabel, color: o.color, timeZone: o.timeZone, description: o.description, times: [] };
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
  /** Space events per day (ADR-090 addendum); a day with events gets a link that opens the events modal. */
  eventDays?: ReadonlyMap<string, SpaceEventDay> | undefined;
  onEvents?: ((day: SpaceEventDay) => void) | undefined;
  /** flowId → armed; unarmed runs are drawn dimmed. */
  armedById?: ReadonlyMap<string, boolean> | undefined;
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
    const groups = groupRuns(days.get(key) ?? [], opts.armedById);
    const shown = groups.slice(0, 4);
    for (const g of shown) {
      const chip = el('div', `cal-chip${g.armed ? '' : ' is-unarmed'}`);
      if (g.color.length > 0) chip.style.borderLeftColor = g.color;
      // A single run shows its time; a series shows its count instead (the title carries the span).
      if (g.times.length === 1) chip.appendChild(el('span', 'cal-chip-time', fmtTime(g.times[0] ?? 0)));
      chip.appendChild(el('span', 'cal-chip-text', `${g.eventName} · ${g.flowLabel}`));
      if (g.times.length > 1) chip.appendChild(el('span', 'cal-chip-count', `×${g.times.length}`));
      chip.title = `${g.flowLabel} — ${g.eventName}: ${describeSeries(g.times)} (${g.botLabel})${g.armed ? '' : '\nNot armed: this run would not fire.'}${g.description.length > 0 ? `\n${g.description}` : ''}`;
      cell.appendChild(chip);
    }
    if (groups.length > shown.length) cell.appendChild(el('div', 'cal-more', `+${groups.length - shown.length} more`));
    const eventDay = opts.eventDays?.get(key);
    if (eventDay !== undefined && eventDay.total > 0) cell.appendChild(buildDayEventsLink(eventDay, () => opts.onEvents?.(eventDay)));
    cell.setAttribute('aria-label', `${d.toDateString()}: ${groups.length === 0 ? 'no scheduled runs' : `${groups.length} scheduled flow${groups.length === 1 ? '' : 's'}`}`);
    cell.addEventListener('click', () => opts.onSelect(key));
    grid.appendChild(cell);
  }
  return grid;
}

export interface DayPaneOptions {
  key: string;
  onPick: (group: RunGroup) => void;
  armedById?: ReadonlyMap<string, boolean> | undefined;
  /** Every scheduled flow in the account, for the "in this account" list under the day. */
  flows?: readonly Scheduled[] | undefined;
  onPickFlow?: ((flow: Scheduled) => void) | undefined;
}

/** The selected day's runs, collapsed per (flow, event). */
export function buildDayPane(occurrences: Occurrence[], opts: DayPaneOptions): HTMLElement {
  const pane = el('div', 'cal-day-pane');
  const [y, m, d] = opts.key.split('-').map((v) => Number.parseInt(v, 10)) as [number, number, number];
  pane.appendChild(el('h3', undefined, new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })));
  const groups = groupRuns(occurrences, opts.armedById);
  const flowsList = (): void => {
    const flows = opts.flows ?? [];
    if (flows.length === 0) return;
    const armed = flows.filter((f) => f.armed).length;
    pane.appendChild(el('h4', undefined, `In this account · ${flows.length} scheduled, ${armed} armed, ${flows.length - armed} not armed`));
    const ul = el('ul', 'cal-flows');
    for (const f of [...flows].sort((a, b) => Number(b.armed) - Number(a.armed) || a.flowLabel.localeCompare(b.flowLabel))) {
      const li = el('li', `cal-flows__row${f.armed ? '' : ' is-unarmed'}`);
      li.dataset['flowId'] = f.flowId;
      li.appendChild(el('span', 'cal-flows__name', f.flowLabel));
      li.appendChild(el('span', `cal-badge ${f.armed ? 'is-on' : 'is-off'}`, f.armed ? 'armed' : f.active ? 'active · no trigger' : 'not armed'));
      li.appendChild(el('span', 'cal-flows__bot', f.botLabel));
      li.addEventListener('click', () => opts.onPickFlow?.(f));
      ul.appendChild(li);
    }
    pane.appendChild(ul);
  };
  if (groups.length === 0) {
    pane.appendChild(el('div', 'cal-empty', 'No scheduled runs this day.'));
    flowsList();
    return pane;
  }
  pane.appendChild(el('h4', undefined, `${groups.length} scheduled flow${groups.length === 1 ? '' : 's'}`));
  for (const g of groups) {
    const row = el('div', `cal-run${g.armed ? '' : ' is-unarmed'}`);
    row.dataset['flowId'] = g.flowId;
    row.appendChild(el('div', 'cal-run-time', fmtTime(g.times[0] ?? 0)));
    const body = el('div');
    const name = el('div', 'cal-run-flow', g.flowLabel);
    if (!g.armed) name.appendChild(el('span', 'cal-badge is-off', 'not armed'));
    body.appendChild(name);
    body.appendChild(el('div', 'cal-run-meta', `${g.eventName} · ${describeSeries(g.times)} · ${g.botLabel}`));
    if (g.description.length > 0) body.appendChild(el('div', 'cal-run-desc', g.description));
    row.appendChild(body);
    row.addEventListener('click', () => opts.onPick(g));
    pane.appendChild(row);
  }
  flowsList();
  return pane;
}

export interface DetailOptions {
  nowMs: number;
  upcoming: Occurrence[];
  onOpen: (flow: Scheduled) => void;
  onBack: () => void;
  /** Arm or disarm through the deployer; resolves with the refreshed flow (null when it vanished). */
  onSetArmed?: ((flow: Scheduled, armed: boolean) => Promise<Scheduled | null>) | undefined;
  /** Space, playbook and journey-map links, fetched when the pane opens; buttons open each. */
  onLinks?: ((flow: Scheduled) => Promise<LiteCalendarFlowLinks | null>) | undefined;
  onOpenSpace?: ((spaceId: string) => void) | undefined;
  onOpenPlaybook?: ((playbookId: string) => void) | undefined;
  onOpenJourney?: ((journeyId: string) => void) | undefined;
  /** Fetch a past run's log summary when its button is clicked (never before). */
  onLogSummary?: ((run: { fromMs: number; toMs: number }) => Promise<LogSummary | null>) | undefined;
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
  if (flow.description.length > 0) pane.appendChild(el('p', 'cal-description', flow.description));
  else pane.appendChild(el('p', 'cal-description cal-muted', 'No description on this flow. Add one in Designer so the calendar can say what it does.'));
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
  const ends = flow.events.map((ev) => (ev.end === null ? null : Date.parse(`${ev.end.date}T${ev.end.time.length > 0 ? ev.end.time : '23:59:59'}`)));
  const allEnded = ends.length > 0 && ends.every((e) => e !== null && Number.isFinite(e) && e < opts.nowMs);
  if (allEnded) {
    const last = Math.max(...ends.map((e) => e ?? 0));
    pane.appendChild(el('p', `cal-note ${flow.armed ? 'is-warn' : ''}`, flow.armed ? `Every schedule window ended (last on ${new Date(last).toLocaleDateString()}), yet the platform still holds a trigger for this flow. Check its logs below; it may be firing regardless.` : `Every schedule window ended (last on ${new Date(last).toLocaleDateString()}). Extend the window in Designer before arming.`));
  }
  // Arm / disarm, with an inline confirmation: this changes the account.
  const armRow = el('div', 'cal-arm');
  const armBtn = el('button', `cal-btn ${flow.active ? 'cal-btn-quiet' : 'cal-btn-primary'}`, flow.active ? 'Disarm' : 'Arm');
  armBtn.type = 'button';
  armBtn.id = 'cal-arm';
  armBtn.disabled = opts.onSetArmed === undefined;
  armBtn.title = flow.active ? 'Deactivate this flow: it stops firing until armed again.' : 'Activate this flow so its schedule fires.';
  const confirm = el('div', 'cal-arm__confirm');
  confirm.hidden = true;
  const question = el('span', undefined, flow.active ? `Disarm ${flow.flowLabel}? It stops firing until you arm it again.` : `Arm ${flow.flowLabel}? Its schedule will start firing.`);
  const yes = el('button', 'cal-btn cal-btn-primary', flow.active ? 'Yes, disarm' : 'Yes, arm');
  yes.type = 'button';
  yes.id = 'cal-arm-confirm';
  const no = el('button', 'cal-btn cal-btn-quiet', 'Cancel');
  no.type = 'button';
  confirm.append(question, yes, no);
  armBtn.addEventListener('click', () => {
    confirm.hidden = !confirm.hidden;
    if (!confirm.hidden) yes.focus();
  });
  no.addEventListener('click', () => {
    confirm.hidden = true;
    armBtn.focus();
  });
  yes.addEventListener('click', () => {
    const run = opts.onSetArmed;
    if (run === undefined) return;
    yes.disabled = true;
    no.disabled = true;
    armBtn.disabled = true;
    question.textContent = flow.active ? 'Disarming… the platform confirms in a few seconds.' : 'Arming… the platform confirms in a few seconds.';
    void run(flow, !flow.active).catch(() => null);
  });
  armRow.append(armBtn, confirm);
  pane.appendChild(armRow);
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
  // Past runs: the log summary is fetched only when asked.
  const past = opts.upcoming.filter((o) => o.flowId === flow.flowId && o.atMs < opts.nowMs).sort((a, b) => b.atMs - a.atMs).slice(0, 6);
  pane.appendChild(el('h4', undefined, 'Past runs'));
  const runsWrap = el('div', 'cal-runs');
  const runWindow = (atMs: number, nextMs: number | null): { fromMs: number; toMs: number } => ({ fromMs: atMs - 60_000, toMs: Math.min(nextMs ?? atMs + 15 * 60_000, atMs + 15 * 60_000) });
  const summaryBlock = (result: LogSummary): HTMLElement => {
    const box = el('div', 'cal-logsum');
    box.appendChild(el('p', 'cal-logsum__narrative', result.narrative));
    if (result.aiNarrative !== null) box.appendChild(el('p', 'cal-logsum__ai', result.aiNarrative));
    else if (result.aiError !== undefined) box.appendChild(el('p', 'cal-muted', `Model narrative unavailable: ${result.aiError}`));
    const s = result.summary;
    if (s.executions.length > 0) {
      const ul = el('ul', 'cal-logsum__runs');
      for (const ex of s.executions.slice(0, 8)) {
        const li = el('li', undefined, `${fmtTime(ex.startMs)} · ${ex.completed ? 'finished' : 'no END line'} · ${ex.billedMs !== null ? `${Math.round(ex.billedMs)} ms billed` : `${ex.durationMs} ms`}${ex.errors.length > 0 ? ` · ${ex.errors.length} error${ex.errors.length === 1 ? '' : 's'}` : ''}`);
        if (ex.errors.length > 0) li.classList.add('has-errors');
        ul.appendChild(li);
      }
      if (s.executions.length > 8) ul.appendChild(el('li', 'cal-muted', `… ${s.executions.length - 8} more`));
      box.appendChild(ul);
    }
    if (s.messages.length > 0) box.appendChild(el('p', 'cal-logsum__messages', s.messages.slice(0, 6).join(' · ')));
    if (result.truncated) box.appendChild(el('p', 'cal-muted', 'Log window cut at the cap; the counts above are partial.'));
    return box;
  };
  const addRun = (label: string, win: { fromMs: number; toMs: number }): void => {
    const row = el('div', 'cal-run-row');
    row.appendChild(el('span', 'cal-run-row__when', label));
    const btn = el('button', 'cal-btn cal-btn-quiet cal-logsum-btn', 'Get log summary');
    btn.type = 'button';
    btn.dataset['fromMs'] = String(win.fromMs);
    btn.disabled = opts.onLogSummary === undefined;
    if (opts.onLogSummary === undefined) btn.title = 'Log summaries need the calendar bridge.';
    const slot = el('div', 'cal-logsum-slot');
    btn.addEventListener('click', () => {
      const fetch = opts.onLogSummary;
      if (fetch === undefined) return;
      btn.disabled = true;
      btn.textContent = 'Fetching logs…';
      slot.replaceChildren();
      void fetch(win).then((result) => {
        btn.textContent = 'Refresh log summary';
        btn.disabled = false;
        slot.replaceChildren(result === null ? el('p', 'cal-muted', 'Logs could not be fetched.') : summaryBlock(result));
      });
    });
    row.appendChild(btn);
    runsWrap.appendChild(row);
    runsWrap.appendChild(slot);
  };
  if (past.length === 0) {
    runsWrap.appendChild(el('p', 'cal-muted', 'No past runs in the loaded window.'));
    addRun('Latest logs (last 24 h)', { fromMs: opts.nowMs - 24 * 3600_000, toMs: opts.nowMs });
  } else {
    past.forEach((o, i) => {
      const next = i === 0 ? null : past[i - 1]?.atMs ?? null;
      addRun(`${fmtDateTime(o.atMs)} · ${o.eventName}`, runWindow(o.atMs, next));
    });
  }
  pane.appendChild(runsWrap);
  const actions = el('div', 'cal-side-actions');
  const open = el('button', 'cal-btn cal-btn-primary', 'Open in GSX Designer');
  open.type = 'button';
  open.id = 'cal-open-flow';
  open.addEventListener('click', () => opts.onOpen(flow));
  actions.appendChild(open);
  pane.appendChild(actions);
  if (opts.onLinks !== undefined) {
    const links = el('section', 'cal-links');
    links.id = 'cal-links';
    links.setAttribute('aria-live', 'polite');
    links.appendChild(el('div', 'cal-links__pending', 'Looking for its Space, playbook and journey map…'));
    pane.appendChild(links);
    const unavailable = (): void => links.replaceChildren(el('div', 'cal-links__none', 'Space, playbook and journey-map links are unavailable right now.'));
    const button = (label: string, title: string, data: Record<string, string>, onClick: () => void): HTMLButtonElement => {
      const btn = el('button', 'cal-btn cal-links__btn', label);
      btn.type = 'button';
      btn.title = title;
      for (const [k, v] of Object.entries(data)) btn.dataset[k] = v;
      btn.addEventListener('click', onClick);
      return btn;
    };
    opts
      .onLinks(flow)
      .then((r) => {
        if (r === null) {
          unavailable();
          return;
        }
        links.replaceChildren();
        const total = r.spaces.length + r.playbooks.length + r.journeys.length;
        if (total === 0) {
          links.appendChild(el('div', 'cal-links__none', r.unavailable ? `No Space, playbook or journey map found (${r.reason ?? 'a source could not be read'}).` : 'This flow is in no Space, and no playbook or journey map is linked to it.'));
          return;
        }
        links.appendChild(el('h4', undefined, 'Space, playbook & journey map'));
        for (const sp of r.spaces) {
          const why = sp.via === 'asset' ? `This flow is an item in the ${sp.name} Space${sp.assetTitle !== null && sp.assetTitle.length > 0 ? ` (“${sp.assetTitle}”)` : ''}.` : sp.via === 'playbook' ? `The playbook that built this flow lives in the ${sp.name} Space.` : `The ${sp.name} Space is named like this flow's GSX space.`;
          links.appendChild(button(`${sp.via === 'asset' ? 'In Space' : 'Near Space'} · ${sp.name}`, why, { spaceId: sp.id, via: sp.via }, () => opts.onOpenSpace?.(sp.id)));
        }
        for (const p of r.playbooks) {
          links.appendChild(button(`Open playbook · ${p.title}`, `Built this flow${p.builtAtMs !== null ? ` on ${new Date(p.builtAtMs).toLocaleDateString()}` : ''}${p.spaceName !== null && p.spaceName.length > 0 ? ` · in the ${p.spaceName} Space` : ''}.`, { playbookId: p.id }, () => opts.onOpenPlaybook?.(p.id)));
        }
        for (const j of r.journeys) {
          const why = j.via === 'asset' ? `In the ${j.spaceName} Space, where this flow is an item.` : j.via === 'playbook' ? `In the ${j.spaceName} Space, beside the playbook that built this flow.` : `In the ${j.spaceName} Space, named like this flow's GSX space.`;
          links.appendChild(button(`Open journey map · ${j.title}`, why, { journeyId: j.id, via: j.via }, () => opts.onOpenJourney?.(j.id)));
        }
        if (r.unavailable && r.reason !== undefined) links.appendChild(el('div', 'cal-links__note', `Some sources could not be read: ${r.reason}`));
      })
      .catch(unavailable);
  }
  return pane;
}

/** "3 events · 2 Spaces": the day's Space-events link. Its own button, so it never selects the day. */
/** Sunday-first start of the week holding a day key. */
export function weekStartOf(key: string): Date {
  const [y, m, d] = key.split('-').map(Number);
  const date = new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1);
  date.setDate(date.getDate() - date.getDay());
  return date;
}

export type CalendarView = 'month' | 'week' | 'day';

/** The heading for a view. */
export function titleFor(view: CalendarView, year: number, month: number, selected: string | null): string {
  if (view === 'month') return `${MONTHS[month - 1] ?? ''} ${year}`;
  const key = selected ?? dayKey({ year, month, day: 1 });
  const [y, m, d] = key.split('-').map(Number);
  if (view === 'day') return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  const start = weekStartOf(key);
  const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6);
  const f = (x: Date, withYear: boolean): string => x.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(withYear ? { year: 'numeric' } : {}) });
  return `${f(start, start.getFullYear() !== end.getFullYear())} – ${f(end, true)}`;
}

/** [from, to) of what a view shows. */
export function rangeFor(view: CalendarView, year: number, month: number, selected: string | null): { fromMs: number; toMs: number } {
  if (view === 'month') return { fromMs: new Date(year, month - 1, 1).getTime(), toMs: new Date(year, month, 1).getTime() };
  const key = selected ?? dayKey({ year, month, day: 1 });
  const [y, m, d] = key.split('-').map(Number);
  if (view === 'day') return { fromMs: new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1).getTime(), toMs: new Date(y ?? 1970, (m ?? 1) - 1, (d ?? 1) + 1).getTime() };
  const start = weekStartOf(key);
  return { fromMs: start.getTime(), toMs: new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7).getTime() };
}

const runChip = (g: RunGroup, className: string, label: string): HTMLButtonElement => {
  const chip = el('button', `cal-chip ${className}${g.armed ? '' : ' is-unarmed'}`);
  chip.type = 'button';
  chip.style.borderLeftColor = g.color;
  chip.dataset['flowId'] = g.flowId;
  chip.appendChild(el('span', 'cal-chip-when', g.times.length > 1 ? `${fmtTime(g.times[0] ?? 0)} ×${g.times.length}` : fmtTime(g.times[0] ?? 0)));
  chip.appendChild(el('span', 'cal-chip-name', label));
  chip.title = `${g.flowLabel} — ${g.eventName}: ${describeSeries(g.times)} (${g.botLabel})${g.armed ? '' : '\nNot armed: this run would not fire.'}${g.description.length > 0 ? `\n${g.description}` : ''}`;
  return chip;
};

export interface WeekViewOptions {
  anchorKey: string;
  selected: string | null;
  today: string;
  onSelect: (key: string) => void;
  onPick: (group: RunGroup) => void;
  eventDays?: ReadonlyMap<string, SpaceEventDay> | undefined;
  onEvents?: ((day: SpaceEventDay) => void) | undefined;
  armedById?: ReadonlyMap<string, boolean> | undefined;
}

/** Seven columns for the week of the anchor day; every run of each day, in time order. */
export function buildWeekView(occurrences: Occurrence[], opts: WeekViewOptions): HTMLElement {
  const grid = el('div', 'cal-week');
  grid.setAttribute('role', 'grid');
  grid.setAttribute('aria-label', 'Scheduled runs by day this week');
  const days = byDay(occurrences);
  const start = weekStartOf(opts.anchorKey);
  for (let i = 0; i < 7; i += 1) {
    const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    const key = keyOf(date.getTime());
    const col = el('div', `cal-week__day${key === opts.today ? ' is-today' : ''}${key === opts.selected ? ' is-selected' : ''}`);
    col.setAttribute('role', 'gridcell');
    col.dataset['key'] = key;
    const head = el('button', 'cal-week__head');
    head.type = 'button';
    head.appendChild(el('span', 'cal-week__weekday', WEEKDAYS[date.getDay()] ?? ''));
    head.appendChild(el('span', 'cal-week__date', String(date.getDate())));
    head.setAttribute('aria-label', date.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }));
    head.addEventListener('click', () => opts.onSelect(key));
    col.appendChild(head);
    const eventDay = opts.eventDays?.get(key);
    if (eventDay !== undefined && eventDay.total > 0) col.appendChild(buildDayEventsLink(eventDay, () => opts.onEvents?.(eventDay)));
    const groups = groupRuns(days.get(key) ?? [], opts.armedById);
    if (groups.length === 0) col.appendChild(el('div', 'cal-week__none', '—'));
    for (const g of groups) {
      const chip = runChip(g, 'cal-week__chip', g.flowLabel);
      chip.addEventListener('click', () => {
        opts.onSelect(key);
        opts.onPick(g);
      });
      col.appendChild(chip);
    }
    grid.appendChild(col);
  }
  return grid;
}

export interface DayViewOptions {
  key: string;
  today: string;
  onPick: (group: RunGroup) => void;
  eventDays?: ReadonlyMap<string, SpaceEventDay> | undefined;
  onEvents?: ((day: SpaceEventDay) => void) | undefined;
  armedById?: ReadonlyMap<string, boolean> | undefined;
}

/** One day by the hour; runs grouped per hour and per (flow, event). */
export function buildDayView(occurrences: Occurrence[], opts: DayViewOptions): HTMLElement {
  const view = el('div', `cal-dayview${opts.key === opts.today ? ' is-today' : ''}`);
  view.setAttribute('role', 'grid');
  view.setAttribute('aria-label', 'Scheduled runs by hour');
  const eventDay = opts.eventDays?.get(opts.key);
  if (eventDay !== undefined && eventDay.total > 0) view.appendChild(buildDayEventsLink(eventDay, () => opts.onEvents?.(eventDay)));
  const mine = occurrences.filter((o) => keyOf(o.atMs) === opts.key);
  const byHour = new Map<number, Occurrence[]>();
  for (const o of mine) {
    const h = new Date(o.atMs).getHours();
    const list = byHour.get(h);
    if (list === undefined) byHour.set(h, [o]);
    else list.push(o);
  }
  if (mine.length === 0) view.appendChild(el('div', 'cal-empty', 'No scheduled runs this day.'));
  for (let h = 0; h < 24; h += 1) {
    const runs = byHour.get(h) ?? [];
    const row = el('div', `cal-dayview__hour${runs.length > 0 ? ' has-runs' : ''}`);
    row.setAttribute('role', 'row');
    row.dataset['hour'] = String(h);
    row.appendChild(el('div', 'cal-dayview__label', `${String(h).padStart(2, '0')}:00`));
    const cell = el('div', 'cal-dayview__cell');
    cell.setAttribute('role', 'gridcell');
    for (const g of groupRuns(runs, opts.armedById)) {
      const chip = runChip(g, 'cal-dayview__chip', `${g.flowLabel} · ${g.eventName}`);
      chip.addEventListener('click', () => opts.onPick(g));
      cell.appendChild(chip);
    }
    row.appendChild(cell);
    view.appendChild(row);
  }
  return view;
}

export function buildDayEventsLink(day: SpaceEventDay, onClick: () => void): HTMLElement {
  const link = el('button', 'cal-day-events', `${day.total} event${day.total === 1 ? '' : 's'} · ${day.spaces.length} Space${day.spaces.length === 1 ? '' : 's'}`);
  link.type = 'button';
  link.dataset['day'] = day.date;
  link.title = day.spaces.map((s) => `${s.spaceName}: ${s.count}`).join('\n');
  link.setAttribute('aria-label', `${day.total} Space events on ${day.date}; open the list`);
  link.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  return link;
}

const KIND_LABEL: Record<string, string> = { added: 'added', updated: 'updated', edited: 'edited', restored: 'restored' };
const authorLabel = (a: string): string => (a.startsWith('device_') ? 'a device' : a.length > 0 ? a : 'someone');

export interface EventsModalOptions {
  day: SpaceEventDay;
  events: readonly SpaceEvent[];
  onClose: () => void;
  onOpenSpace?: ((spaceId: string) => void) | undefined;
}

/**
 * The events modal for one day: how many, by Space, then every event.
 * Closable by ×, Escape and the backdrop; focus lands on the close
 * button and returns to the day link on close.
 */
export function buildSpaceEventsModal(opts: EventsModalOptions): HTMLElement {
  const { day, events, onClose } = opts;
  const backdrop = el('div', 'cal-modal-backdrop');
  backdrop.dataset['testid'] = 'cal-events-modal';
  const dialog = el('div', 'cal-modal');
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  const [y, m, d] = day.date.split('-').map((v) => Number.parseInt(v, 10)) as [number, number, number];
  const title = new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  dialog.setAttribute('aria-label', `Space events on ${title}`);
  const head = el('div', 'cal-modal__head');
  head.appendChild(el('h3', 'cal-modal__title', title));
  const close = el('button', 'cal-modal__close', '×');
  close.type = 'button';
  close.setAttribute('aria-label', 'Close');
  close.addEventListener('click', () => onClose());
  head.appendChild(close);
  dialog.appendChild(head);
  dialog.appendChild(el('p', 'cal-modal__summary', `${day.total} event${day.total === 1 ? '' : 's'} across ${day.spaces.length} Space${day.spaces.length === 1 ? '' : 's'}`));
  const byKey = (e: SpaceEvent): string => (e.spaceId.length > 0 ? e.spaceId : `name:${e.spaceName}`);
  for (const s of day.spaces) {
    const group = el('section', 'cal-modal__space');
    const gh = el('div', 'cal-modal__space-head');
    gh.appendChild(el('span', 'cal-modal__space-name', s.spaceName));
    gh.appendChild(el('span', 'cal-modal__space-count', `${s.count} event${s.count === 1 ? '' : 's'}`));
    if (opts.onOpenSpace !== undefined && s.spaceId.length > 0) {
      const open = el('button', 'cal-btn cal-btn-quiet', 'Open Space');
      open.type = 'button';
      open.title = 'Opens the Spaces window on this Space.';
      open.addEventListener('click', () => opts.onOpenSpace?.(s.spaceId));
      gh.appendChild(open);
    }
    group.appendChild(gh);
    const list = el('ul', 'cal-modal__events');
    const key = s.spaceId.length > 0 ? s.spaceId : `name:${s.spaceName}`;
    for (const e of events.filter((x) => byKey(x) === key).sort((a, b) => a.atMs - b.atMs)) {
      const li = el('li', 'cal-modal__event');
      li.appendChild(el('span', 'cal-modal__time', fmtTime(e.atMs)));
      const what = el('span', 'cal-modal__what');
      what.textContent = `${e.itemTitle.length > 0 ? e.itemTitle : e.itemKind.length > 0 ? `a ${e.itemKind}` : 'an item'} ${KIND_LABEL[e.kind] ?? e.kind}`;
      li.appendChild(what);
      li.appendChild(el('span', 'cal-modal__who', `by ${authorLabel(e.author)}`));
      list.appendChild(li);
    }
    group.appendChild(list);
    dialog.appendChild(group);
  }
  backdrop.appendChild(dialog);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) onClose();
  });
  dialog.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  });
  return backdrop;
}

/** The header summary line. */
export function summaryText(snapshot: Snapshot | null, monthRuns: number, monthEvents = 0): string {
  if (snapshot === null) return 'scheduled flows';
  const armed = snapshot.scheduled.filter((f) => f.armed).length;
  const events = monthEvents > 0 ? ` · ${monthEvents} Space event${monthEvents === 1 ? '' : 's'}` : '';
  return `${snapshot.scheduled.length} scheduled flow${snapshot.scheduled.length === 1 ? '' : 's'} · ${armed} armed · ${monthRuns} run${monthRuns === 1 ? '' : 's'} this month${events}`;
}

// ── Page ──────────────────────────────────────────────────────────────
const $ = (id: string): HTMLElement | null => document.getElementById(id);
const bridge = (): Bridge | null => window.lite?.calendar ?? null;

interface PageState {
  year: number;
  month: number;
  /** Which flows' runs the grid shows. */
  filter: 'all' | 'armed' | 'unarmed';
  view: 'month' | 'week' | 'day';
  selected: string | null;
  snapshot: Snapshot | null;
  occurrences: Occurrence[];
  detail: Scheduled | null;
  busy: boolean;
  /** Space events for the loaded window (null until loaded, unavailable when the graph is not reachable). */
  spaceEvents: SpaceEventsView | null;
}

function boot(): void {
  if ($('cal-grid') === null) return;
  const now = new Date();
  const state: PageState = { year: now.getFullYear(), month: now.getMonth() + 1, filter: 'all', view: 'month', selected: keyOf(now.getTime()), snapshot: null, occurrences: [], detail: null, busy: false, spaceEvents: null };
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

  const openEventsModal = (day: SpaceEventDay): void => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const events = state.spaceEvents?.events ?? [];
    const modal = buildSpaceEventsModal({
      day,
      events,
      onClose: () => {
        modal.remove();
        opener?.focus();
      },
      onOpenSpace: (spaceId) => openSpace(spaceId),
    });
    document.body.appendChild(modal);
    modal.querySelector<HTMLElement>('.cal-modal__close')?.focus();
  };

  const openSpace = (spaceId: string): void => {
    const spaces = window.lite?.spaces;
    if (spaces?.open === undefined) {
      toast('Open Spaces from the main window to see this Space.');
      return;
    }
    void spaces.open({ spaceId }).catch(() => toast('Could not open Spaces.'));
  };

  const renderViewToggle = (): void => {
    const box = $('cal-view');
    if (box === null) return;
    box.replaceChildren(
      ...(['month', 'week', 'day'] as const).map((v) => {
        const b = el('button', `cal-btn cal-view__btn${state.view === v ? ' is-on' : ''}`, v === 'month' ? 'Month' : v === 'week' ? 'Week' : 'Day');
        b.type = 'button';
        b.dataset['view'] = v;
        b.setAttribute('aria-pressed', String(state.view === v));
        b.addEventListener('click', () => {
          state.view = v;
          render();
        });
        return b;
      })
    );
    const prev = $('cal-prev');
    const next = $('cal-next');
    const unit = state.view === 'month' ? 'month' : state.view === 'week' ? 'week' : 'day';
    if (prev !== null) prev.title = `Previous ${unit} (←)`;
    if (next !== null) next.title = `Next ${unit} (→)`;
  };

  const renderFilter = (): void => {
    const box = $('cal-filter');
    if (box === null) return;
    box.replaceChildren(
      ...(['all', 'armed', 'unarmed'] as const).map((f) => {
        const b = el('button', `cal-btn cal-filter__btn${state.filter === f ? ' is-on' : ''}`, f === 'all' ? 'All' : f === 'armed' ? 'Armed' : 'Not armed');
        b.type = 'button';
        b.dataset['filter'] = f;
        b.setAttribute('aria-pressed', String(state.filter === f));
        b.addEventListener('click', () => {
          state.filter = f;
          render();
        });
        return b;
      })
    );
  };

  const render = (): void => {
    const today = keyOf(Date.now());
    const monthLabel = $('cal-month');
    if (monthLabel !== null) monthLabel.textContent = titleFor(state.view, state.year, state.month, state.selected);
    const monthRuns = state.occurrences.filter((o) => {
      const d = new Date(o.atMs);
      return d.getFullYear() === state.year && d.getMonth() + 1 === state.month;
    }).length;
    const armedById = new Map((state.snapshot?.scheduled ?? []).map((f) => [f.flowId, f.armed] as const));
    const visible = state.occurrences.filter((o) => state.filter === 'all' || (state.filter === 'armed') === (armedById.get(o.flowId) ?? true));
    const eventDays = new Map((state.spaceEvents?.days ?? []).map((d) => [d.date, d] as const));
    const monthEvents = [...eventDays.values()].filter((d) => d.date.startsWith(`${state.year}-${String(state.month).padStart(2, '0')}-`)).reduce((n, d) => n + d.total, 0);
    const sub = $('cal-subtitle');
    if (sub !== null) sub.textContent = summaryText(state.snapshot, monthRuns, monthEvents);
    const onSelect = (key: string): void => {
      state.selected = key;
      state.detail = null;
      render();
    };
    const onPick = (group: RunGroup): void => {
      state.detail = state.snapshot?.scheduled.find((f) => f.flowId === group.flowId) ?? null;
      render();
    };
    const shared = { today, eventDays, onEvents: (day: SpaceEventDay) => openEventsModal(day), armedById };
    const anchor = state.selected ?? keyOf(Date.now());
    const g =
      state.view === 'month'
        ? buildMonthGrid(visible, { year: state.year, month: state.month, selected: state.selected, onSelect, ...shared })
        : state.view === 'week'
          ? buildWeekView(visible, { anchorKey: anchor, selected: state.selected, onSelect, onPick, ...shared })
          : buildDayView(visible, { key: anchor, onPick, ...shared });
    renderFilter();
    renderViewToggle();
    const weekdayRow = $('cal-weekdays');
    if (weekdayRow !== null) weekdayRow.hidden = state.view !== 'month';
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
          onSetArmed: async (flow, armed) => {
            const b = bridge();
            if (b === null) return null;
            const r = await b.setArmed({ flowId: flow.flowId, botId: flow.botId, armed });
            if (r.ok !== true || r.value === undefined) {
              toast(r.error?.message ?? 'The platform refused the change.');
              render();
              return null;
            }
            toast(armed ? `${flow.flowLabel} is armed.` : `${flow.flowLabel} is disarmed.`);
            await load(true);
            state.detail = state.snapshot?.scheduled.find((f) => f.flowId === flow.flowId) ?? r.value.flow;
            render();
            return r.value.flow;
          },
          onLinks: async (flow) => {
            const b = bridge();
            if (b === null) return null;
            const r = await b.flowLinks({ flowId: flow.flowId, botLabel: flow.botLabel });
            return r.ok === true && r.value !== undefined ? r.value : null;
          },
          onOpenSpace: (spaceId) => openSpace(spaceId),
          onOpenPlaybook: (id) => {
            const spaces = window.lite?.spaces;
            if (spaces?.openWiser === undefined) {
              toast('Open WISER Playbooks from the main window to see this playbook.');
              return;
            }
            void spaces.openWiser(id).catch(() => toast('Could not open the playbook.'));
          },
          onOpenJourney: (id) => {
            const spaces = window.lite?.spaces;
            if (spaces?.openJourneyMap === undefined) {
              toast('Open the Journey Map Builder from the main window to see this journey map.');
              return;
            }
            void spaces.openJourneyMap(id).catch(() => toast('Could not open the journey map.'));
          },
          onLogSummary: async (run) => {
            const b = bridge();
            const flow = state.detail;
            if (b === null || flow === null) return null;
            const r = await b.flowLogSummary({ flowId: flow.flowId, botId: flow.botId, fromMs: run.fromMs, toMs: run.toMs });
            if (r.ok !== true || r.value === undefined) {
              toast(r.error?.message ?? 'Logs could not be fetched.');
              return null;
            }
            return r.value;
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
    const dayOccs = visible.filter((o) => keyOf(o.atMs) === sel);
    side.replaceChildren(
      buildDayPane(dayOccs, {
        key: sel,
        onPick: (group) => {
          state.detail = state.snapshot?.scheduled.find((f) => f.flowId === group.flowId) ?? null;
          render();
        },
        armedById,
        flows: state.snapshot?.scheduled ?? [],
        onPickFlow: (flow) => {
          state.detail = flow;
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
      const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const [res, ev] = await Promise.all([b.occurrences({ fromMs: from.getTime(), toMs: to.getTime(), refresh }), b.spaceEvents({ fromMs: from.getTime(), toMs: to.getTime(), timeZone, refresh })]);
      state.spaceEvents = ev.ok === true && ev.value !== undefined ? ev.value : null;
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
        const scan = res.value.snapshot.scan;
        const read = scan === undefined ? '' : ` · ${scan.fetched + scan.bulk} read, ${scan.reused} from index`;
        status.textContent = `${res.value.snapshot.env} · ${res.value.snapshot.botCount} bots · ${res.value.snapshot.flowCount} flows · ${res.value.snapshot.activeDeployments} active${read} · ${age === 0 ? 'just now' : `${age} min ago`}`;
        status.title = status.textContent;
      }
      render();
    } finally {
      state.busy = false;
    }
  };

  const shift = (delta: number): void => {
    if (state.view !== 'month') {
      const key = state.selected ?? keyOf(Date.now());
      const [y, m0, d0] = key.split('-').map(Number);
      const next = new Date(y ?? 1970, (m0 ?? 1) - 1, (d0 ?? 1) + delta * (state.view === 'week' ? 7 : 1));
      const monthChanged = next.getFullYear() !== state.year || next.getMonth() + 1 !== state.month;
      state.selected = keyOf(next.getTime());
      state.year = next.getFullYear();
      state.month = next.getMonth() + 1;
      state.detail = null;
      render();
      if (monthChanged) void load();
      return;
    }
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
  $('cal-export')?.addEventListener('click', () => {
    const b = bridge();
    if (b === null) return;
    const { fromMs, toMs } = rangeFor(state.view, state.year, state.month, state.selected);
    const label = titleFor(state.view, state.year, state.month, state.selected);
    void b.exportIcs({ fromMs, toMs, armed: state.filter, name: `Scheduled flows · ${label}` }).then((r) => {
      if (r.ok !== true || r.value === undefined) toast(r.error?.message ?? 'The export failed.');
      else if (r.value.saved) toast(`Saved ${r.value.events} event${r.value.events === 1 ? '' : 's'} to ${r.value.path ?? 'the file'}.`);
    });
  });
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
