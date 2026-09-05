/** ADR-090 addendum — flow log summaries, the pure part. */
import { describe, it, expect } from 'vitest';
import { isErrorLine, logExcerpt, narrativeOf, parseLogEvent, summarizeFlowLogs } from '../../calendar/logs.js';

const ev = (requestId: string, timestamp: number, parsed: Record<string, unknown>) => ({ requestId, timestamp, message: { type: 'json', parsed } });

describe('flow log summaries', () => {
  it('parses the deployer event shape, plain strings too', () => {
    const l = parseLogEvent(ev('r1', 1000, { type: 'vital', sys: 'ssn.del', step: { stepId: 's1' }, session: { id: 'sess' }, data: { key: 'x' } }))!;
    expect(l).toMatchObject({ atMs: 1000, requestId: 'r1', type: 'vital', sys: 'ssn.del', stepId: 's1', sessionId: 'sess', message: '' });
    expect(parseLogEvent({ requestId: 'r1', timestamp: '2000', message: 'plain text' })).toMatchObject({ type: 'text', message: 'plain text' });
    expect(parseLogEvent({ requestId: 'r1', message: {} })).toBeNull();
    expect(parseLogEvent(ev('r', 5, { type: 'log', message: { a: 1 } }))?.message).toBe('{"a":1}');
  });
  it('groups lines into executions by request id, measures duration, collects steps and errors', () => {
    const lines = [
      ev('r1', 1000, { type: 'START', message: 'Version: 1' }),
      ev('r1', 1400, { type: 'log', message: 'fetching report', step: { stepId: 'aaa' } }),
      ev('r1', 2200, { type: 'vital', sys: 'cb.ok', step: { stepId: 'bbb' } }),
      ev('r2', 5000, { type: 'START', message: 'Version: 1' }),
      ev('r2', 5300, { type: 'error', message: 'Request failed: 500', step: { stepId: 'aaa' } }),
    ].map(parseLogEvent).filter((l): l is NonNullable<typeof l> => l !== null);
    const s = summarizeFlowLogs(lines);
    expect(s.lines).toBe(5);
    expect(s.executions.map((e) => [e.requestId, e.durationMs, e.lines])).toEqual([['r1', 1200, 3], ['r2', 300, 2]]);
    expect(s.executions[0]?.steps).toEqual(['aaa', 'bbb']);
    expect(s.executions[1]?.errors).toEqual(['Request failed: 500']);
    expect(s.errorCount).toBe(1);
    expect(s.types).toEqual({ START: 2, log: 1, vital: 1, error: 1 });
    expect(s.steps).toEqual(['aaa', 'bbb']);
    expect(s.messages).toEqual(['Version: 1', 'fetching report', 'Request failed: 500']);
    expect(isErrorLine({ atMs: 0, requestId: '', type: 'vital', message: 'error in vital is not an error', sys: '', stepId: '', sessionId: '' })).toBe(false);
  });
  it('reads the platform REPORT line, untyped reporting events, and END completion', () => {
    const lines = [
      ev('r1', 1000, { type: 'START', message: 'Version: 1' }),
      ev('r1', 1050, { event: { Event: 'Session', EventCategory: 'Bot', EventValue: { SessionId: 'x' } } }),
      ev('r1', 1200, { type: 'END' }),
      ev('r1', 1210, { type: 'REPORT', message: 'Duration: 215.77 ms Billed Duration: 216 ms Memory Size: 1024 MB Max Memory Used: 142 MB ' }),
      ev('r2', 5000, { type: 'START', message: 'Version: 1' }),
    ].map(parseLogEvent).filter((l): l is NonNullable<typeof l> => l !== null);
    expect(lines[1]).toMatchObject({ type: 'event', message: 'Bot · Session' });
    expect(lines[3]).toMatchObject({ type: 'REPORT', billedMs: 216, memoryMb: 142 });
    const s = summarizeFlowLogs(lines);
    expect(s.executions[0]).toMatchObject({ requestId: 'r1', completed: true, billedMs: 216, memoryMb: 142 });
    expect(s.executions[1]).toMatchObject({ requestId: 'r2', completed: false, billedMs: null });
    expect(narrativeOf(s)).toBe('2 executions, 5 log lines, billed 216 ms, peak memory 142 MB, no errors, 1 without an END line.');
  });
  it('writes a plain narrative and a compact excerpt without vitals', () => {
    const lines = [ev('r1', 1000, { type: 'START', message: 'go' }), ev('r1', 3500, { type: 'log', message: 'done', step: { stepId: 'abcdefgh-1' } }), ev('r1', 3600, { type: 'vital', sys: 'cb.ok' })].map(parseLogEvent).filter((l): l is NonNullable<typeof l> => l !== null);
    const s = summarizeFlowLogs(lines);
    expect(narrativeOf(s)).toBe('1 execution, 3 log lines, took 2.6 s, 1 step touched, no errors.');
    expect(narrativeOf(summarizeFlowLogs([]))).toContain('did not run');
    const x = logExcerpt(lines);
    expect(x.split('\n')).toHaveLength(2);
    expect(x).toContain('[log] step abcdefgh done');
  });
});
