/**
 * Flow log summaries (ADR-090 addendum, 2026-09-05) — pure.
 *
 * The deployer answers `GET /flows/<id>/logs?start&end` with events
 * `{ requestId, timestamp, message: { type: 'json', parsed: { type,
 * message?, sys?, step?: { stepId }, session?: { id }, data? } } }`.
 * A `requestId` is one execution. The summary is deterministic: how
 * many executions, how long, which steps, what went wrong; a model may
 * add a narrative on top, never instead.
 */

export interface FlowLogLine {
  atMs: number;
  requestId: string;
  /** START | vital | log | error … as the platform types it; 'text' for plain strings. */
  type: string;
  message: string;
  sys: string;
  stepId: string;
  sessionId: string;
  /** From a REPORT line: platform-billed duration and peak memory. */
  billedMs?: number;
  memoryMb?: number;
}

export interface FlowExecution {
  requestId: string;
  startMs: number;
  endMs: number;
  durationMs: number;
  lines: number;
  steps: string[];
  errors: string[];
  /** An END line was seen: the execution finished. */
  completed: boolean;
  billedMs: number | null;
  memoryMb: number | null;
}

export interface FlowLogSummary {
  lines: number;
  executions: FlowExecution[];
  firstMs: number | null;
  lastMs: number | null;
  errorCount: number;
  types: Record<string, number>;
  steps: string[];
  /** Up to 12 distinct human log messages, in order. */
  messages: string[];
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** One deployer event → line; null without a timestamp. */
export function parseLogEvent(raw: unknown): FlowLogLine | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const e = raw as Record<string, unknown>;
  const ts = e['timestamp'];
  const atMs = typeof ts === 'number' ? ts : Number.parseInt(str(ts), 10);
  if (!Number.isFinite(atMs)) return null;
  const m = e['message'];
  let type = 'text';
  let message = '';
  let sys = '';
  let stepId = '';
  let sessionId = '';
  if (typeof m === 'string') message = m;
  else if (typeof m === 'object' && m !== null) {
    const mm = m as Record<string, unknown>;
    const parsed = typeof mm['parsed'] === 'object' && mm['parsed'] !== null ? (mm['parsed'] as Record<string, unknown>) : mm;
    type = str(parsed['type']) || (typeof parsed['event'] === 'object' && parsed['event'] !== null ? 'event' : str(mm['type']) || 'json');
    const pm = parsed['message'];
    if (type === 'event' && typeof parsed['event'] === 'object' && parsed['event'] !== null) {
      const ev = parsed['event'] as Record<string, unknown>;
      message = [str(ev['EventCategory']), str(ev['Event'])].filter((x) => x.length > 0).join(' · ');
    } else message = typeof pm === 'string' ? pm : pm === undefined ? '' : JSON.stringify(pm).slice(0, 400);
    sys = str(parsed['sys']);
    const step = parsed['step'];
    stepId = typeof step === 'object' && step !== null ? str((step as Record<string, unknown>)['stepId']) : '';
    const session = parsed['session'];
    sessionId = typeof session === 'object' && session !== null ? str((session as Record<string, unknown>)['id']) : '';
  }
  const line: FlowLogLine = { atMs, requestId: str(e['requestId']), type, message, sys, stepId, sessionId };
  if (type === 'REPORT') {
    const d = /Billed Duration:\s*([\d.]+)\s*ms/i.exec(message) ?? /Duration:\s*([\d.]+)\s*ms/i.exec(message);
    const mem = /Max Memory Used:\s*(\d+)\s*MB/i.exec(message);
    if (d !== null) line.billedMs = Number.parseFloat(d[1] ?? '0');
    if (mem !== null) line.memoryMb = Number.parseInt(mem[1] ?? '0', 10);
  }
  return line;
}

const ERRORISH = /error|exception|fail|timeout|unhandled/i;

export function isErrorLine(line: FlowLogLine): boolean {
  return ERRORISH.test(line.type) || (line.type !== 'vital' && ERRORISH.test(line.message));
}

export function summarizeFlowLogs(lines: readonly FlowLogLine[]): FlowLogSummary {
  const byReq = new Map<string, FlowLogLine[]>();
  const types: Record<string, number> = {};
  const steps = new Set<string>();
  const messages: string[] = [];
  const seenMsg = new Set<string>();
  const sorted = [...lines].sort((a, b) => a.atMs - b.atMs);
  for (const l of sorted) {
    const key = l.requestId.length > 0 ? l.requestId : '(no request)';
    const list = byReq.get(key);
    if (list === undefined) byReq.set(key, [l]);
    else list.push(l);
    types[l.type] = (types[l.type] ?? 0) + 1;
    if (l.stepId.length > 0) steps.add(l.stepId);
    if (l.type !== 'vital' && l.message.length > 0 && messages.length < 12 && !seenMsg.has(l.message)) {
      seenMsg.add(l.message);
      messages.push(l.message);
    }
  }
  const executions: FlowExecution[] = [...byReq.entries()].map(([requestId, ls]) => {
    const startMs = ls[0]?.atMs ?? 0;
    const endMs = ls[ls.length - 1]?.atMs ?? startMs;
    const report = ls.find((l) => l.type === 'REPORT');
    return {
      requestId,
      startMs,
      endMs,
      durationMs: Math.max(0, endMs - startMs),
      lines: ls.length,
      steps: [...new Set(ls.map((l) => l.stepId).filter((s) => s.length > 0))],
      errors: ls.filter(isErrorLine).map((l) => (l.message.length > 0 ? l.message : l.type)).slice(0, 5),
      completed: ls.some((l) => l.type === 'END'),
      billedMs: report?.billedMs ?? null,
      memoryMb: report?.memoryMb ?? null,
    };
  });
  executions.sort((a, b) => a.startMs - b.startMs);
  return {
    lines: sorted.length,
    executions,
    firstMs: sorted[0]?.atMs ?? null,
    lastMs: sorted[sorted.length - 1]?.atMs ?? null,
    errorCount: sorted.filter(isErrorLine).length,
    types,
    steps: [...steps],
    messages,
  };
}

const fmtDuration = (ms: number): string => (ms < 1000 ? `${ms} ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 60_000)} min`);

/** The deterministic one-paragraph narrative. */
export function narrativeOf(summary: FlowLogSummary): string {
  if (summary.lines === 0) return 'No log lines in this window: the flow did not run, or its logs have expired.';
  const n = summary.executions.length;
  const durations = summary.executions.map((e) => e.durationMs);
  const avg = durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : 0;
  const parts = [`${n} execution${n === 1 ? '' : 's'}, ${summary.lines} log line${summary.lines === 1 ? '' : 's'}`];
  const billed = summary.executions.map((e) => e.billedMs).filter((b): b is number => b !== null);
  if (billed.length > 0) parts.push(`${billed.length === 1 ? 'billed' : 'averaging'} ${fmtDuration(Math.round(billed.reduce((x, y) => x + y, 0) / billed.length))}`);
  else if (n > 0) parts.push(`${n === 1 ? 'took' : 'averaging'} ${fmtDuration(Math.round(avg))}`);
  const mem = summary.executions.map((e) => e.memoryMb).filter((b): b is number => b !== null);
  if (mem.length > 0) parts.push(`peak memory ${Math.max(...mem)} MB`);
  if (summary.steps.length > 0) parts.push(`${summary.steps.length} step${summary.steps.length === 1 ? '' : 's'} touched`);
  parts.push(summary.errorCount === 0 ? 'no errors' : `${summary.errorCount} error line${summary.errorCount === 1 ? '' : 's'}`);
  const unfinished = summary.executions.filter((e) => !e.completed).length;
  if (n > 0 && unfinished > 0 && billed.length > 0) parts.push(`${unfinished} without an END line`);
  return `${parts.join(', ')}.`;
}

/** Compact text of the log for a model: one line per entry, capped. */
export function logExcerpt(lines: readonly FlowLogLine[], cap = 150): string {
  const picked = lines.filter((l) => l.type !== 'vital').slice(-cap);
  return picked.map((l) => `${new Date(l.atMs).toISOString()} [${l.type}]${l.stepId.length > 0 ? ` step ${l.stepId.slice(0, 8)}` : ''} ${l.message}`.trim()).join('\n');
}
