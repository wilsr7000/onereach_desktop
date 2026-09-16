/**
 * GPS for Life routine -- turn the user's Chore queue (the NEON graph, see
 * memory: `(:Child)-[:HAS_CHORE]->(:Chore)`) into the day's plan: the
 * morning routine, the rest of today's items, and what is overdue. Pure
 * functions; the graph read lives in chores-read.js.
 *
 * Chore shape (NEON :Chore):
 *   { id, title, status: pending|active|snoozed|completed,
 *     scheduled_at ISO (first / only occurrence), due_by ISO,
 *     priority 'P1'..'P3', recurrence_rule 'FREQ=DAILY' |
 *     'FREQ=WEEKLY;BYDAY=SU,WE' | 'ANYTIME' | null, energy_level 1-5, source }
 *
 * Also plans TaskItems from the graph TaskQueue ({ id, name, status,
 * priority (int), fire_at, notes }) as one-off items.
 */

'use strict';

const DAY_CODES = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
const OPEN_STATUSES = new Set(['pending', 'active', 'snoozed', 'queued', 'due']);

function parseRule(rule) {
  const r = typeof rule === 'string' ? rule.trim().toUpperCase() : '';
  if (!r) return { freq: 'once', byDay: [] };
  if (r === 'ANYTIME') return { freq: 'anytime', byDay: [] };
  const parts = Object.fromEntries(
    r.split(';').map((kv) => {
      const [k, v] = kv.split('=');
      return [k.trim(), (v || '').trim()];
    })
  );
  const freq = (parts.FREQ || '').toLowerCase();
  const byDay = (parts.BYDAY || '')
    .split(',')
    .map((d) => DAY_CODES[d.trim()])
    .filter((n) => Number.isInteger(n));
  if (freq === 'daily') return { freq: 'daily', byDay: [] };
  if (freq === 'weekly') return { freq: 'weekly', byDay };
  if (freq === 'monthly') return { freq: 'monthly', byDay: [] };
  return { freq: 'once', byDay: [] };
}

function localDayStart(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function sameLocalDay(a, b) {
  const x = new Date(a);
  const y = new Date(b);
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
}

function parseDate(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** True when a placeholder "no real time" stamp (the seed rows use 2000-01-01). */
function isPlaceholderDate(d) {
  return !!d && d.getFullYear() < 2010;
}

/** Local minutes-since-midnight of the chore's scheduled clock time, or null. */
function timeOfDay(chore) {
  const d = parseDate(chore && chore.scheduled_at);
  if (!d || isPlaceholderDate(d)) return null;
  return d.getHours() * 60 + d.getMinutes();
}

/** Does this chore have an occurrence on `day` (local)? */
function occursOn(chore, day) {
  const rule = parseRule(chore && chore.recurrence_rule);
  const first = parseDate(chore && chore.scheduled_at);
  const dayStart = localDayStart(day);
  if (rule.freq === 'anytime') return true;
  if (!first || isPlaceholderDate(first)) return rule.freq !== 'once';
  const firstDay = localDayStart(first);
  if (dayStart < firstDay) return false;
  if (rule.freq === 'daily') return true;
  if (rule.freq === 'weekly') {
    const days = rule.byDay.length ? rule.byDay : [first.getDay()];
    return days.includes(dayStart.getDay());
  }
  if (rule.freq === 'monthly') return dayStart.getDate() === first.getDate();
  return sameLocalDay(first, dayStart);
}

function isOpen(chore) {
  const s = String((chore && chore.status) || 'pending').toLowerCase();
  return OPEN_STATUSES.has(s);
}

function fmtClock(minutes) {
  if (minutes === null || minutes === undefined) return null;
  const h24 = Math.floor(minutes / 60);
  const m = minutes % 60;
  const mer = h24 >= 12 ? 'PM' : 'AM';
  const h = h24 % 12 || 12;
  return `${h}:${String(m).padStart(2, '0')} ${mer}`;
}

function spokenClock(minutes) {
  if (minutes === null || minutes === undefined) return null;
  const h24 = Math.floor(minutes / 60);
  const m = minutes % 60;
  const mer = h24 >= 12 ? 'PM' : 'AM';
  const h = h24 % 12 || 12;
  return m === 0 ? `${h} ${mer}` : `${h}:${String(m).padStart(2, '0')} ${mer}`;
}

function priorityLabel(p) {
  if (typeof p === 'number') return p >= 9 ? 'urgent' : p >= 7 ? 'high' : p <= 3 ? 'low' : null;
  const s = String(p || '').toUpperCase();
  if (s === 'P1') return 'high';
  if (s === 'P3') return 'low';
  return null;
}

/**
 * Compress one planned item for screen + voice.
 * @param {Object} entry - { chore, minutes, kind: 'morning'|'later'|'anytime'|'overdue'|'alarm', overdueDays? }
 */
function compressItem(entry) {
  const { chore, minutes, kind } = entry;
  const title = String((chore && (chore.title || chore.name)) || '').trim() || 'Untitled task';
  const pri = priorityLabel(chore && chore.priority);
  const energy = Number.isFinite(Number(chore && chore.energy_level)) ? Number(chore.energy_level) : null;
  const clock = fmtClock(minutes);
  const spokenWhen = spokenClock(minutes);

  const lineParts = [];
  if (kind === 'overdue') lineParts.push(`overdue ${entry.overdueDays} day${entry.overdueDays === 1 ? '' : 's'}`);
  else if (kind === 'anytime') lineParts.push('anytime');
  else if (clock) lineParts.push(clock);
  lineParts.push(title);
  if (pri) lineParts.push(pri === 'high' ? 'high priority' : pri === 'urgent' ? 'urgent' : 'low priority');
  if (energy !== null && energy >= 4) lineParts.push(`energy ${energy}`);
  if (chore && String(chore.status || '').toLowerCase() === 'snoozed') lineParts.push('snoozed');
  const line = lineParts.join(' · ');

  let spoken;
  if (kind === 'overdue') spoken = `${title}, overdue by ${entry.overdueDays} day${entry.overdueDays === 1 ? '' : 's'}.`;
  else if (kind === 'anytime') spoken = `${title}, whenever you have a moment.`;
  else if (spokenWhen) spoken = `${spokenWhen}, ${title}${pri === 'high' || pri === 'urgent' ? ', high priority' : ''}.`;
  else spoken = `${title}.`;

  return { title, kind, time: clock, minutes, priority: pri, energy, line, spoken, id: chore && chore.id };
}

/**
 * Plan the day.
 *
 * @param {Array} chores - open + completed chores (completed ones are counted, not listed)
 * @param {Object} [opts]
 * @param {Date} [opts.day] - the target day (default: today)
 * @param {Date} [opts.now] - current time (default: new Date())
 * @param {Array} [opts.taskItems] - graph TaskItems (one-offs / alarms)
 * @returns {{ morning: Array, later: Array, anytime: Array, overdue: Array, doneToday: number, items: Array }}
 */
function planDay(chores, opts = {}) {
  const day = opts.day ? new Date(opts.day) : new Date();
  const now = opts.now ? new Date(opts.now) : new Date();
  const dayStart = localDayStart(day);
  const isToday = sameLocalDay(day, now);

  const morning = [];
  const later = [];
  const anytime = [];
  const overdue = [];
  let doneToday = 0;

  for (const chore of Array.isArray(chores) ? chores : []) {
    if (!chore) continue;
    const title = String(chore.title || '').trim();
    if (!title) continue; // an untitled seed row says nothing useful
    const status = String(chore.status || 'pending').toLowerCase();
    if (status === 'completed') {
      const done = parseDate(chore.completed_at || chore.updated_at);
      if (done && sameLocalDay(done, day)) doneToday += 1;
      continue;
    }
    if (!isOpen(chore)) continue;

    const rule = parseRule(chore.recurrence_rule);
    if (rule.freq === 'once') {
      const due = parseDate(chore.due_by) || parseDate(chore.scheduled_at);
      if (due && !isPlaceholderDate(due) && localDayStart(due) < dayStart) {
        const overdueDays = Math.round((dayStart - localDayStart(due)) / 86400000);
        overdue.push(compressItem({ chore, minutes: null, kind: 'overdue', overdueDays }));
        continue;
      }
      // A one-off is on today's plan when it is scheduled OR due today (a
      // due date with no scheduled time still counts).
      const dueToday = !!due && !isPlaceholderDate(due) && sameLocalDay(due, day);
      if (!dueToday && !occursOn(chore, day)) continue;
      const scheduledMinutes = timeOfDay(chore);
      const minutes = scheduledMinutes !== null ? scheduledMinutes : dueToday ? due.getHours() * 60 + due.getMinutes() : null;
      const entry = compressItem({ chore, minutes, kind: minutes !== null && minutes < 12 * 60 ? 'morning' : 'later' });
      (entry.kind === 'morning' ? morning : later).push(entry);
      continue;
    }
    if (rule.freq === 'anytime') {
      anytime.push(compressItem({ chore, minutes: null, kind: 'anytime' }));
      continue;
    }
    if (!occursOn(chore, day)) continue;
    const minutes = timeOfDay(chore);
    const entry = compressItem({ chore, minutes, kind: minutes !== null && minutes < 12 * 60 ? 'morning' : 'later' });
    (entry.kind === 'morning' ? morning : later).push(entry);
  }

  for (const t of Array.isArray(opts.taskItems) ? opts.taskItems : []) {
    if (!t || !isOpen(t)) continue;
    const fire = parseDate(t.fire_at);
    if (fire && !sameLocalDay(fire, day)) {
      if (localDayStart(fire) < dayStart) {
        const overdueDays = Math.round((dayStart - localDayStart(fire)) / 86400000);
        overdue.push(compressItem({ chore: t, minutes: null, kind: 'overdue', overdueDays }));
      }
      continue;
    }
    const minutes = fire ? fire.getHours() * 60 + fire.getMinutes() : null;
    if (minutes === null) {
      anytime.push(compressItem({ chore: t, minutes: null, kind: 'anytime' }));
      continue;
    }
    const entry = compressItem({ chore: t, minutes, kind: minutes < 12 * 60 ? 'morning' : 'later' });
    (entry.kind === 'morning' ? morning : later).push(entry);
  }

  const byTime = (a, b) => (a.minutes ?? 1e9) - (b.minutes ?? 1e9);
  morning.sort(byTime);
  later.sort(byTime);
  overdue.sort((a, b) => b.kind === 'overdue' && a.kind === 'overdue' ? 0 : 0);

  return {
    day: dayStart.toISOString(),
    isToday,
    morning,
    later,
    anytime,
    overdue,
    doneToday,
    items: [...morning, ...later, ...anytime, ...overdue],
  };
}

/**
 * The Tasks section text for the composer + { line, spoken } items for the
 * dayView. Keeps the spoken list short: the morning routine in full, the
 * rest of the day counted with the first two named, overdue counted.
 */
function buildTasksBriefText(plan, opts = {}) {
  const label = opts.dateLabel || 'today';
  const lines = [];
  const items = [];
  const total = plan.morning.length + plan.later.length + plan.anytime.length;

  if (total === 0 && plan.overdue.length === 0) {
    const headline = `No tasks queued ${label}.`;
    return { headline, content: headline, items };
  }

  const headline = `${total} task${total !== 1 ? 's' : ''} ${label}${
    plan.morning.length ? ` (${plan.morning.length} in your morning routine)` : ''
  }${plan.overdue.length ? `, ${plan.overdue.length} overdue` : ''}.`;
  lines.push(headline);

  if (plan.morning.length) {
    lines.push('Morning routine (in order):');
    for (const it of plan.morning) {
      lines.push(`- ${it.line}`);
      items.push({ line: it.line, spoken: it.spoken, kind: 'morning' });
    }
  }
  if (plan.later.length) {
    lines.push('Later today:');
    for (const it of plan.later) {
      lines.push(`- ${it.line}`);
      items.push({ line: it.line, spoken: it.spoken, kind: 'later' });
    }
  }
  if (plan.anytime.length) {
    lines.push(`Anytime: ${plan.anytime.map((it) => it.title).join('; ')}.`);
    for (const it of plan.anytime) items.push({ line: it.line, spoken: it.spoken, kind: 'anytime' });
  }
  if (plan.overdue.length) {
    const named = plan.overdue.slice(0, 2).map((it) => `${it.title} (${it.line.split(' · ')[0]})`);
    const more = plan.overdue.length > 2 ? `, and ${plan.overdue.length - 2} more` : '';
    lines.push(`Overdue one-offs: ${plan.overdue.length} — ${named.join(', ')}${more}.`);
    for (const it of plan.overdue) items.push({ line: it.line, spoken: it.spoken, kind: 'overdue' });
  }
  if (plan.doneToday) lines.push(`Already done today: ${plan.doneToday}.`);

  return { headline, content: lines.join('\n'), items };
}

module.exports = {
  parseRule,
  occursOn,
  timeOfDay,
  isOpen,
  compressItem,
  planDay,
  buildTasksBriefText,
  fmtClock,
  spokenClock,
};
