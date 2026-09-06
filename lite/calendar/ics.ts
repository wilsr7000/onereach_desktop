/**
 * iCalendar export (ADR-090): the runs in a window as RFC 5545 VEVENTs.
 * Pure. A (flow, event) that fires more than `collapseAt` times on one
 * day becomes a single all-day marker ("×288, every 5 min") so a
 * calendar app is not buried under hundreds of dots.
 */
export interface IcsRun {
  atMs: number;
  flowId: string;
  botLabel: string;
  flowLabel: string;
  description: string;
  eventId: string;
  eventName: string;
  timeZone: string;
}

export interface IcsOptions {
  /** X-WR-CALNAME. */
  name: string;
  nowMs: number;
  /** Runs per (flow, event, day) above which the day collapses into one marker (default 12). */
  collapseAt?: number;
  prodId?: string;
}

export interface IcsBuild {
  text: string;
  /** VEVENTs written. */
  events: number;
  /** Days collapsed into a single marker. */
  collapsed: number;
}

const pad = (n: number, w = 2): string => String(n).padStart(w, '0');

/** A UTC date-time in iCalendar form. */
export const icsUtc = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
};

/** Text escaped for a property value. */
export const icsEscape = (s: string): string => s.replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

/** Content lines fold at 75 octets; continuation lines start with one space. */
export function foldLine(line: string): string {
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= 75) return line;
  const out: string[] = [];
  let current = '';
  let currentBytes = 0;
  for (const ch of line) {
    const n = new TextEncoder().encode(ch).length;
    const limit = out.length === 0 ? 75 : 74;
    if (currentBytes + n > limit) {
      out.push(current);
      current = '';
      currentBytes = 0;
    }
    current += ch;
    currentBytes += n;
  }
  if (current.length > 0) out.push(current);
  return out.join('\r\n ');
}

/** The local day (YYYY-MM-DD) of an instant in a zone; UTC when the zone is unknown. */
export function dayIn(ms: number, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString().slice(0, 10);
  }
}

function cadence(times: number[]): string {
  if (times.length < 2) return '';
  const sorted = [...times].sort((a, b) => a - b);
  const gaps = new Set<number>();
  for (let i = 1; i < sorted.length; i += 1) gaps.add(Math.round((sorted[i]! - sorted[i - 1]!) / 60_000));
  if (gaps.size !== 1) return 'at mixed times';
  const m = [...gaps][0]!;
  return m % 60 === 0 ? `every ${m / 60} h` : `every ${m} min`;
}

export function buildIcs(runs: readonly IcsRun[], opts: IcsOptions): IcsBuild {
  const collapseAt = opts.collapseAt ?? 12;
  const groups = new Map<string, IcsRun[]>();
  for (const r of runs) {
    const k = `${r.flowId}|${r.eventId}|${dayIn(r.atMs, r.timeZone)}`;
    const g = groups.get(k);
    if (g === undefined) groups.set(k, [r]);
    else g.push(r);
  }
  const stamp = icsUtc(opts.nowMs);
  const events: Array<{ atMs: number; lines: string[] }> = [];
  let collapsed = 0;
  for (const [k, g] of groups) {
    const first = g[0]!;
    const common = [`CATEGORIES:${icsEscape(first.botLabel)}`, `X-OR-FLOW-ID:${first.flowId}`, `X-OR-EVENT-ID:${first.eventId}`];
    if (g.length > collapseAt) {
      collapsed += 1;
      const day = k.split('|')[2]!.replace(/-/g, '');
      const next = new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(4, 6)) - 1, Number(day.slice(6, 8)) + 1));
      const nextDay = `${next.getUTCFullYear()}${pad(next.getUTCMonth() + 1)}${pad(next.getUTCDate())}`;
      const times = g.map((r) => r.atMs);
      events.push({
        atMs: Math.min(...times),
        lines: [
          'BEGIN:VEVENT',
          `UID:${first.flowId}.${first.eventId}.${day}.day@onereach-lite`,
          `DTSTAMP:${stamp}`,
          `DTSTART;VALUE=DATE:${day}`,
          `DTEND;VALUE=DATE:${nextDay}`,
          `SUMMARY:${icsEscape(`${first.flowLabel} · ${first.eventName} ×${g.length}`)}`,
          `DESCRIPTION:${icsEscape(`${g.length} runs on this day ${cadence(times)} (${first.botLabel}).${first.description.length > 0 ? `\n${first.description}` : ''}`)}`,
          ...common,
          'END:VEVENT',
        ],
      });
      continue;
    }
    for (const r of g) {
      events.push({
        atMs: r.atMs,
        lines: [
          'BEGIN:VEVENT',
          `UID:${r.flowId}.${r.eventId}.${r.atMs}@onereach-lite`,
          `DTSTAMP:${stamp}`,
          `DTSTART:${icsUtc(r.atMs)}`,
          `SUMMARY:${icsEscape(`${r.flowLabel} · ${r.eventName}`)}`,
          `DESCRIPTION:${icsEscape(`${r.botLabel}${r.description.length > 0 ? `\n${r.description}` : ''}`)}`,
          ...common,
          'END:VEVENT',
        ],
      });
    }
  }
  events.sort((a, b) => a.atMs - b.atMs);
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${opts.prodId ?? '-//Onereach.ai Lite//Calendar//EN'}`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${icsEscape(opts.name)}`,
    ...events.flatMap((e) => e.lines),
    'END:VCALENDAR',
  ];
  return { text: `${lines.map(foldLine).join('\r\n')}\r\n`, events: events.length, collapsed };
}
