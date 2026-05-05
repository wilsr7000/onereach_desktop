import { describe, it, expect } from 'vitest';
import { LiteError, isLiteError, wrapAsLiteError } from '../../errors.js';
import { KVError, KV_ERROR_CODES } from '../../kv/api.js';
import { BugReportError, BUG_REPORT_ERROR_CODES } from '../../bug-report/api.js';

describe('LiteError', () => {
  it('constructs with code, message, context, remediation', () => {
    const err = new LiteError({
      code: 'TEST_X',
      message: 'something broke',
      context: { foo: 'bar', count: 3 },
      remediation: 'Try again with a hat on.',
    });
    expect(err.code).toBe('TEST_X');
    expect(err.message).toBe('something broke');
    expect(err.context).toEqual({ foo: 'bar', count: 3 });
    expect(err.remediation).toBe('Try again with a hat on.');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(LiteError);
  });

  it('uses default remediation when none provided', () => {
    const err = new LiteError({ code: 'TEST_X', message: 'broke' });
    expect(err.remediation).toMatch(/file a bug report/i);
  });

  it('freezes context so callers cannot mutate it after the fact', () => {
    const err = new LiteError({
      code: 'TEST_X',
      message: 'broke',
      context: { foo: 'bar' },
    });
    expect(() => {
      (err.context as Record<string, unknown>)['foo'] = 'mutated';
    }).toThrow();
  });

  it('preserves the cause chain via standard Error.cause', () => {
    const root = new Error('TCP reset');
    const err = new LiteError({
      code: 'TEST_X',
      message: 'broke',
      cause: root,
    });
    expect(err.cause).toBe(root);
  });

  it('formatForLog includes code, context, remediation, cause', () => {
    const err = new LiteError({
      code: 'TEST_X',
      message: 'broke',
      context: { op: 'save' },
      remediation: 'try again',
      cause: new Error('socket hung up'),
    });
    const log = err.formatForLog();
    expect(log).toContain('[TEST_X]');
    expect(log).toContain('broke');
    expect(log).toContain('"op":"save"');
    expect(log).toContain('try again');
    expect(log).toContain('socket hung up');
  });

  it('formatForLog truncates long context strings', () => {
    const longBody = 'x'.repeat(500);
    const err = new LiteError({
      code: 'TEST_X',
      message: 'broke',
      context: { body: longBody },
    });
    const log = err.formatForLog();
    expect(log).toContain('truncated');
    expect(log.length).toBeLessThan(500); // overall log line stays compact
  });

  it('formatForUser combines message + remediation when present', () => {
    const err = new LiteError({
      code: 'TEST_X',
      message: 'KV get timed out after 5000ms',
      remediation: 'Check your network.',
    });
    expect(err.formatForUser()).toBe('KV get timed out after 5000ms Check your network.');
  });

  it('formatForUser falls back to message alone when remediation is the default', () => {
    const err = new LiteError({ code: 'TEST_X', message: 'broke' });
    expect(err.formatForUser()).toBe('broke');
  });

  it('toJSON serializes the full structured shape', () => {
    const err = new LiteError({
      code: 'TEST_X',
      message: 'broke',
      context: { op: 'save', count: 3 },
      remediation: 'try again',
      cause: new Error('inner'),
    });
    const json = err.toJSON();
    expect(json.name).toBe('LiteError');
    expect(json.code).toBe('TEST_X');
    expect(json.message).toBe('broke');
    expect(json.context).toEqual({ op: 'save', count: 3 });
    expect(json.remediation).toBe('try again');
    expect(json.cause).toContain('inner');
  });

  it('isLiteError is a true type-guard', () => {
    expect(isLiteError(new LiteError({ code: 'X', message: 'y' }))).toBe(true);
    expect(isLiteError(new Error('plain'))).toBe(false);
    expect(isLiteError('string')).toBe(false);
    expect(isLiteError(null)).toBe(false);
    expect(isLiteError(undefined)).toBe(false);
  });
});

describe('wrapAsLiteError', () => {
  it('wraps a plain Error into a LiteError preserving the cause', () => {
    const root = new Error('inner');
    const wrapped = wrapAsLiteError(root, {
      code: 'WRAP_X',
      message: 'outer wrap',
      remediation: 'do the thing',
    });
    expect(wrapped).toBeInstanceOf(LiteError);
    expect(wrapped.code).toBe('WRAP_X');
    expect(wrapped.cause).toBe(root);
  });

  it('passes through if input is already a LiteError (no double-wrap)', () => {
    const original = new LiteError({ code: 'A', message: 'orig' });
    const wrapped = wrapAsLiteError(original, { code: 'B', message: 'outer' });
    expect(wrapped).toBe(original);
  });
});

describe('KVError', () => {
  it('is a LiteError subclass', () => {
    const err = new KVError({
      code: KV_ERROR_CODES.TIMEOUT,
      message: 'KV get timed out after 5000ms',
      context: { op: 'get', collection: 'lite-bugs', key: 'x' },
    });
    expect(err).toBeInstanceOf(LiteError);
    expect(err).toBeInstanceOf(KVError);
    expect(err.name).toBe('KVError');
    expect(err.code).toBe('KV_TIMEOUT');
  });

  it('mirrors status and responseBody onto convenience fields and into context', () => {
    const err = new KVError({
      code: KV_ERROR_CODES.HTTP,
      message: 'KV set failed: HTTP 500',
      status: 500,
      responseBody: 'internal server error',
      context: { op: 'set', collection: 'lite-bugs', key: 'x' },
      remediation: 'try later',
    });
    expect(err.status).toBe(500);
    expect(err.responseBody).toBe('internal server error');
    expect(err.context['status']).toBe(500);
    expect(err.context['body']).toBe('internal server error');
  });

  it('truncates very large response bodies in context to keep logs readable', () => {
    const huge = 'x'.repeat(1000);
    const err = new KVError({
      code: KV_ERROR_CODES.HTTP,
      message: 'failed',
      status: 500,
      responseBody: huge,
    });
    expect(typeof err.context['body']).toBe('string');
    expect((err.context['body'] as string).length).toBeLessThanOrEqual(200);
  });
});

describe('BugReportError', () => {
  it('is a LiteError subclass', () => {
    const err = new BugReportError({
      code: BUG_REPORT_ERROR_CODES.NOT_FOUND,
      message: 'Bug report not found: x',
      context: { op: 'read', key: 'x' },
    });
    expect(err).toBeInstanceOf(LiteError);
    expect(err).toBeInstanceOf(BugReportError);
    expect(err.name).toBe('BugReportError');
    expect(err.code).toBe('BR_NOT_FOUND');
  });

  it('exposes a code that can be branched on', () => {
    const err = new BugReportError({
      code: BUG_REPORT_ERROR_CODES.SAVE_FAILED,
      message: 'save failed',
      cause: new Error('underlying KV problem'),
    });
    expect(err.code).toBe('BR_SAVE_FAILED');
    // Consumers branch on `.code`, not on prose.
    if (err.code === BUG_REPORT_ERROR_CODES.SAVE_FAILED) {
      expect(true).toBe(true);
    } else {
      throw new Error('code branching failed');
    }
  });
});
