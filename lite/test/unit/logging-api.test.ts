/**
 * LoggingApi tests.
 *
 * Structured per Rule 12 / HARNESS.md:
 *   1. `runApiConformanceContract` on LoggingApi
 *   2. `runErrorConformanceContract` on LoggingError
 *   3. Module-specific behavior tests via FakeLogging override
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  getLoggingApi,
  _resetLoggingApiForTesting,
  _setLoggingApiForTesting,
  type LoggingApi,
  LoggingError,
  LOGGING_ERROR_CODES,
} from '../../logging/api.js';
import { LoggingStore } from '../../logging/store.js';
import {
  runApiConformanceContract,
  runErrorConformanceContract,
} from '../harness/conformance.js';
import { FakeLogging, FakeQueue } from '../harness/index.js';

// 1. Conformance contract -- runs the uniform suite.
runApiConformanceContract<LoggingApi>({
  name: 'LoggingApi',
  getInstance: getLoggingApi,
  resetForTesting: _resetLoggingApiForTesting,
  setForTesting: _setLoggingApiForTesting,
  expectedMethods: ['debug', 'info', 'warn', 'error', 'event', 'start', 'onEvent', 'recent'],
});

// 2. Error class conformance.
runErrorConformanceContract<LoggingError>({
  name: 'LoggingError',
  ErrorClass: LoggingError,
  codeEnum: LOGGING_ERROR_CODES,
  modulePrefix: 'LOGGING_',
  constructErrorWithCode: (code) =>
    new LoggingError({
      code: code as never,
      message: 'sample',
      context: { op: 'sample' },
    }),
});

// 3. Module-specific behavior tests using FakeLogging.

describe('LoggingApi log methods route to the underlying logger', () => {
  let fake: FakeLogging;

  beforeEach(() => {
    _resetLoggingApiForTesting();
    fake = new FakeLogging();
    _setLoggingApiForTesting(fake);
  });

  it('debug records the call', () => {
    getLoggingApi().debug('cat', 'msg', { x: 1 });
    expect(fake.logs).toEqual([{ level: 'debug', category: 'cat', message: 'msg', data: { x: 1 } }]);
  });

  it('info, warn, error all route to recorded logs', () => {
    const api = getLoggingApi();
    api.info('cat', 'm1');
    api.warn('cat', 'm2');
    api.error('cat', 'm3');
    expect(fake.logs.map((l) => l.level)).toEqual(['info', 'warn', 'error']);
  });
});

describe('LoggingApi event method', () => {
  let fake: FakeLogging;

  beforeEach(() => {
    _resetLoggingApiForTesting();
    fake = new FakeLogging();
    _setLoggingApiForTesting(fake);
  });

  it('event() emits a single record with the right name and category', () => {
    getLoggingApi().event('kv.set', { key: 'x' });
    expect(fake.events).toHaveLength(1);
    expect(fake.events[0]?.name).toBe('kv.set');
    expect(fake.events[0]?.category).toBe('kv');
    expect(fake.events[0]?.data).toEqual({ key: 'x' });
  });

  it('event() defaults to info level; explicit level is honored', () => {
    const api = getLoggingApi();
    api.event('ev.one');
    api.event('ev.two', undefined, 'warn');
    api.event('ev.three', undefined, 'error');
    expect(fake.events.map((e) => e.level)).toEqual(['info', 'warn', 'error']);
  });

  it('event() with single-segment name uses the whole name as category', () => {
    getLoggingApi().event('booted');
    expect(fake.events[0]?.category).toBe('booted');
  });
});

describe('LoggingApi spans', () => {
  let fake: FakeLogging;

  beforeEach(() => {
    _resetLoggingApiForTesting();
    fake = new FakeLogging();
    _setLoggingApiForTesting(fake);
  });

  it('start() emits <name>.start with a spanId', () => {
    const span = getLoggingApi().start('kv.set', { key: 'x' });
    expect(fake.events).toHaveLength(1);
    expect(fake.events[0]?.name).toBe('kv.set.start');
    expect(fake.events[0]?.spanId).toBe(span.id);
    expect(fake.events[0]?.data).toEqual({ key: 'x' });
  });

  it('span.finish() emits <name>.finish with same spanId and a durationMs', () => {
    const span = getLoggingApi().start('kv.set');
    span.finish({ ok: true });
    expect(fake.events).toHaveLength(2);
    expect(fake.events[1]?.name).toBe('kv.set.finish');
    expect(fake.events[1]?.spanId).toBe(span.id);
    expect(typeof fake.events[1]?.durationMs).toBe('number');
    expect(fake.events[1]?.data).toEqual({ ok: true });
  });

  it('span.fail() emits <name>.fail with serialized error payload', () => {
    const span = getLoggingApi().start('kv.set');
    span.fail(new Error('boom'));
    expect(fake.events[1]?.name).toBe('kv.set.fail');
    expect(fake.events[1]?.error?.code).toBe('UNKNOWN');
    expect(fake.events[1]?.error?.message).toBe('boom');
    expect(fake.events[1]?.level).toBe('error');
  });

  it('span.fail() on a LiteError preserves the structured fields', () => {
    const span = getLoggingApi().start('kv.set');
    const err = new LoggingError({
      code: LOGGING_ERROR_CODES.INVALID_PATTERN,
      message: 'bad pattern',
      context: { pattern: '' },
      remediation: 'pass a non-empty pattern',
    });
    span.fail(err);
    const emitted = fake.events[1]?.error;
    expect(emitted?.code).toBe('LOGGING_INVALID_PATTERN');
    expect(emitted?.message).toBe('bad pattern');
    expect(emitted?.remediation).toBe('pass a non-empty pattern');
    expect(emitted?.context).toEqual({ pattern: '' });
  });

  it('span finish/fail are idempotent (try/finally is safe)', () => {
    const span = getLoggingApi().start('op');
    span.finish();
    span.finish(); // ignored
    span.fail(new Error('after finish')); // ignored
    expect(fake.events).toHaveLength(2); // start + finish only
  });

  it('span.fail() after start emits exactly two events (no .finish)', () => {
    const span = getLoggingApi().start('op');
    span.fail(new Error('x'));
    expect(fake.events.map((e) => e.name)).toEqual(['op.start', 'op.fail']);
  });
});

describe('LoggingApi onEvent subscription', () => {
  let fake: FakeLogging;

  beforeEach(() => {
    _resetLoggingApiForTesting();
    fake = new FakeLogging();
    _setLoggingApiForTesting(fake);
  });

  it('delivers events matching the pattern', () => {
    const received: string[] = [];
    getLoggingApi().onEvent('kv.*', (ev) => received.push(ev.name));
    getLoggingApi().event('kv.set');
    getLoggingApi().event('kv.get');
    getLoggingApi().event('bug-report.save'); // does not match
    expect(received).toEqual(['kv.set', 'kv.get']);
  });

  it('returns an unsubscribe that detaches the handler', () => {
    const received: string[] = [];
    const unsub = getLoggingApi().onEvent('*', (ev) => received.push(ev.name));
    getLoggingApi().event('one');
    unsub();
    getLoggingApi().event('two');
    expect(received).toEqual(['one']);
  });
});

describe('LoggingApi recent() ring buffer', () => {
  let fake: FakeLogging;

  beforeEach(() => {
    _resetLoggingApiForTesting();
    fake = new FakeLogging();
    _setLoggingApiForTesting(fake);
  });

  it('returns matching events newest-first', () => {
    const api = getLoggingApi();
    api.event('a.1');
    api.event('a.2');
    api.event('b.1');
    api.event('a.3');
    expect(api.recent('a.*').map((e) => e.name)).toEqual(['a.3', 'a.2', 'a.1']);
  });

  it('respects the limit', () => {
    const api = getLoggingApi();
    for (let i = 0; i < 100; i++) api.event(`x.${i}`);
    expect(api.recent('x.*', 5).map((e) => e.name)).toEqual([
      'x.99',
      'x.98',
      'x.97',
      'x.96',
      'x.95',
    ]);
  });

  it('returns [] when no event matches', () => {
    const api = getLoggingApi();
    api.event('a.1');
    expect(api.recent('z.*')).toEqual([]);
  });
});

describe('LoggingApi error paths', () => {
  // Validation tests need a real LoggingStore (FakeLogging is permissive)
  // but should NOT touch the lib queue on disk -- inject one with a
  // FakeQueue so the test stays hermetic. Without this seam the test
  // depends on the test-runner cwd resolving the lib path.
  beforeEach(() => {
    _resetLoggingApiForTesting();
    _setLoggingApiForTesting(new LoggingStore({ queue: new FakeQueue() }));
  });

  it('event() with empty name throws LoggingError', () => {
    const api = getLoggingApi();
    expect(() => api.event('')).toThrow(LoggingError);
    expect(() => api.event(' has space')).toThrow(/Invalid event name/);
  });

  it('recent() with empty pattern throws LoggingError', () => {
    const api = getLoggingApi();
    expect(() => api.recent('')).toThrow(LoggingError);
  });

  it('onEvent() with empty pattern throws LoggingError', () => {
    const api = getLoggingApi();
    expect(() => api.onEvent('', () => undefined)).toThrow(LoggingError);
  });
});
