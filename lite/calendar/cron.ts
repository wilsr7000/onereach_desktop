/**
 * Quartz-style cron evaluation in a time zone (ADR-090).
 *
 * GSX's "Schedule execution" step stores expressions such as
 *   `0,5,10 0,1,2 1/1 * ? *`          → min hour dom month dow year
 *   `0 0 12 ? * MON-FRI *`             → sec min hour dom month dow year
 * Supported per field: `*`, `?`, lists, ranges, steps (`a/b`, `*\/b`),
 * month and day names, `L` (last day of month / last weekday `5L`),
 * `n#k` (k-th weekday). `W` is read as the plain day. Quartz weekdays:
 * SUN=1 … SAT=7. Instants are produced for a time zone with the
 * two-pass offset method (a wall time that does not exist on a DST day
 * is skipped).
 */

export interface CronSpec {
  seconds: number[];
  minutes: number[];
  hours: number[];
  /** null = `?` / `*` (no constraint); else a predicate on (dom, daysInMonth). */
  dayOfMonth: ((dom: number, daysInMonth: number) => boolean) | null;
  months: Set<number>;
  /** null = `?` / `*`; else predicate on (dow 1..7 Quartz, dom, daysInMonth). */
  dayOfWeek: ((dow: number, dom: number, daysInMonth: number) => boolean) | null;
  years: Set<number> | null;
  source: string;
}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

function names(token: string, kind: 'month' | 'dow'): string {
  const list = kind === 'month' ? MONTHS : DAYS;
  return token.toUpperCase().replace(/[A-Z]{3}/g, (m) => {
    const i = list.indexOf(m);
    return i === -1 ? m : String(i + 1);
  });
}

/** Expand a numeric field (`*`, lists, ranges, steps) into sorted unique values within [lo, hi]. */
export function expandField(token: string, lo: number, hi: number): number[] {
  const out = new Set<number>();
  for (const part of token.split(',')) {
    const p = part.trim();
    if (p.length === 0) continue;
    const [rangePart, stepPart] = p.split('/');
    const step = stepPart !== undefined ? Number.parseInt(stepPart, 10) : 1;
    if (!Number.isFinite(step) || step <= 0) throw new Error(`bad step in "${token}"`);
    let start: number;
    let end: number;
    if (rangePart === '*' || rangePart === '?') {
      start = lo;
      end = hi;
    } else if (rangePart !== undefined && rangePart.includes('-')) {
      const [a, b] = rangePart.split('-');
      start = Number.parseInt(a ?? '', 10);
      end = Number.parseInt(b ?? '', 10);
    } else {
      start = Number.parseInt(rangePart ?? '', 10);
      end = stepPart !== undefined ? hi : start;
    }
    if (!Number.isFinite(start) || !Number.isFinite(end)) throw new Error(`bad value in "${token}"`);
    if (start > end) {
      // Wrapping range (e.g. FRI-MON).
      for (let v = start; v <= hi; v += step) out.add(v);
      for (let v = lo; v <= end; v += step) out.add(v);
    } else {
      for (let v = Math.max(lo, start); v <= Math.min(hi, end); v += step) out.add(v);
    }
  }
  return [...out].sort((a, b) => a - b);
}

function parseDayOfMonth(token: string): CronSpec['dayOfMonth'] {
  const t = token.trim().toUpperCase();
  if (t === '?' || t === '*') return null;
  if (t === 'L') return (dom, dim) => dom === dim;
  const lastOffset = /^L-(\d+)$/.exec(t);
  if (lastOffset !== null) {
    const off = Number.parseInt(lastOffset[1] ?? '0', 10);
    return (dom, dim) => dom === dim - off;
  }
  const values = new Set(expandField(t.replace(/W/g, ''), 1, 31));
  return (dom) => values.has(dom);
}

function parseDayOfWeek(token: string): CronSpec['dayOfWeek'] {
  const t = names(token.trim(), 'dow').toUpperCase();
  if (t === '?' || t === '*') return null;
  const nth = /^(\d)#(\d)$/.exec(t);
  if (nth !== null) {
    const wanted = Number.parseInt(nth[1] ?? '1', 10);
    const k = Number.parseInt(nth[2] ?? '1', 10);
    return (dow, dom) => dow === wanted && Math.ceil(dom / 7) === k;
  }
  const last = /^(\d)L$/.exec(t);
  if (last !== null) {
    const wanted = Number.parseInt(last[1] ?? '1', 10);
    return (dow, dom, dim) => dow === wanted && dom + 7 > dim;
  }
  if (t === 'L') return (dow) => dow === 7;
  const values = new Set(expandField(t, 1, 7));
  return (dow) => values.has(dow);
}

/** Parse a Quartz expression (5, 6 or 7 fields). */
export function parseCron(expression: string): CronSpec {
  const tokens = expression.trim().split(/\s+/);
  let sec = '0';
  let min: string;
  let hour: string;
  let dom: string;
  let mon: string;
  let dow: string;
  let year = '*';
  if (tokens.length === 7) [sec, min, hour, dom, mon, dow, year] = tokens as [string, string, string, string, string, string, string];
  else if (tokens.length === 6) [min, hour, dom, mon, dow, year] = tokens as [string, string, string, string, string, string];
  else if (tokens.length === 5) [min, hour, dom, mon, dow] = tokens as [string, string, string, string, string];
  else throw new Error(`cron needs 5–7 fields: "${expression}"`);
  const monthsList = expandField(names(mon, 'month'), 1, 12);
  return {
    seconds: expandField(sec, 0, 59),
    minutes: expandField(min, 0, 59),
    hours: expandField(hour, 0, 23),
    dayOfMonth: parseDayOfMonth(dom),
    months: new Set(monthsList),
    dayOfWeek: parseDayOfWeek(dow),
    years: year === '*' ? null : new Set(expandField(year, 1970, 2199)),
    source: expression,
  };
}

// ── time zones ────────────────────────────────────────────────────────
const fmtCache = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (f === undefined) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', weekday: 'short' });
    fmtCache.set(tz, f);
  }
  return f;
}

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** Quartz weekday: SUN=1 … SAT=7. */
  dow: number;
}

/** Wall-clock parts of an instant in a time zone. */
export function zonedParts(ms: number, tz: string): ZonedParts {
  const parts = formatter(tz).formatToParts(new Date(ms));
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '0';
  const hour = Number.parseInt(get('hour'), 10);
  return {
    year: Number.parseInt(get('year'), 10),
    month: Number.parseInt(get('month'), 10),
    day: Number.parseInt(get('day'), 10),
    hour: hour === 24 ? 0 : hour,
    minute: Number.parseInt(get('minute'), 10),
    second: Number.parseInt(get('second'), 10),
    dow: DAYS.indexOf(get('weekday').toUpperCase().slice(0, 3)) + 1,
  };
}

/** The instant for a wall time in a time zone, or null when that wall time does not exist (DST gap). */
export function zonedTimeToUtc(year: number, month: number, day: number, hour: number, minute: number, second: number, tz: string): number | null {
  const asUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  let guess = asUtc;
  for (let i = 0; i < 3; i += 1) {
    const p = zonedParts(guess, tz);
    const seen = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    const diff = asUtc - seen;
    if (diff === 0) return guess;
    guess += diff;
  }
  const check = zonedParts(guess, tz);
  return check.year === year && check.month === month && check.day === day && check.hour === hour && check.minute === minute ? guess : null;
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export interface OccurrenceWindow {
  fromMs: number;
  toMs: number;
  /** Stop after this many instants (default 5000). */
  limit?: number;
}

/**
 * Every instant the expression fires within [fromMs, toMs], evaluated in
 * `tz`, ascending. Days are walked in the zone; each matching day yields
 * its hour × minute × second grid.
 */
export function cronOccurrences(expression: string | CronSpec, tz: string, window: OccurrenceWindow): number[] {
  const spec = typeof expression === 'string' ? parseCron(expression) : expression;
  const limit = window.limit ?? 5000;
  const out: number[] = [];
  const start = zonedParts(window.fromMs, tz);
  let y = start.year;
  let m = start.month;
  let d = start.day;
  const endParts = zonedParts(window.toMs, tz);
  const endKey = endParts.year * 10000 + endParts.month * 100 + endParts.day;
  let guard = 0;
  while (y * 10000 + m * 100 + d <= endKey && guard < 100000) {
    guard += 1;
    const dim = daysInMonth(y, m);
    const dayMatches =
      spec.months.has(m) &&
      (spec.years === null || spec.years.has(y)) &&
      (spec.dayOfMonth === null || spec.dayOfMonth(d, dim)) &&
      (spec.dayOfWeek === null || spec.dayOfWeek(new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 1, d, dim));
    if (dayMatches) {
      for (const h of spec.hours) {
        for (const mi of spec.minutes) {
          for (const s of spec.seconds) {
            const at = zonedTimeToUtc(y, m, d, h, mi, s, tz);
            if (at === null || at < window.fromMs || at > window.toMs) continue;
            out.push(at);
            if (out.length >= limit) return out;
          }
        }
      }
    }
    d += 1;
    if (d > dim) {
      d = 1;
      m += 1;
      if (m > 12) {
        m = 1;
        y += 1;
      }
    }
  }
  return out;
}

/** A schedule bound ("2019-10-09", "00:00[:00]") as an instant in the zone, or null. */
export function boundToMs(bound: { date: string; time: string } | null, tz: string, endOfDayWhenNoTime = false): number | null {
  if (bound === null || !/^\d{4}-\d{2}-\d{2}$/.test(bound.date)) return null;
  const [y, m, d] = bound.date.split('-').map((v) => Number.parseInt(v, 10)) as [number, number, number];
  const t = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(bound.time.trim());
  const hh = t !== null ? Number.parseInt(t[1] ?? '0', 10) : endOfDayWhenNoTime ? 23 : 0;
  const mm = t !== null ? Number.parseInt(t[2] ?? '0', 10) : endOfDayWhenNoTime ? 59 : 0;
  const ss = t !== null && t[3] !== undefined ? Number.parseInt(t[3], 10) : endOfDayWhenNoTime ? 59 : 0;
  return zonedTimeToUtc(y, m, d, hh, mm, ss, tz);
}
