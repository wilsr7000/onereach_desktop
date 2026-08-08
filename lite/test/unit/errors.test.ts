import { describe, it, expect } from 'vitest';
import {
  LiteError,
  isLiteError,
  wrapAsLiteError,
  envelopeIpcError,
  wrapIpcHandler,
  type LiteErrorJSON,
} from '../../errors.js';
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

// ---------------------------------------------------------------------------
// IPC error envelopes (2026-08-08 hardening review catch-all)
// ---------------------------------------------------------------------------

/** Parse the wire message back into the marker payload, preload-style. */
function parseEnvelope(err: Error, marker: string): LiteErrorJSON | null {
  const jsonStart = err.message.indexOf('{');
  if (jsonStart < 0) return null;
  try {
    const parsed = JSON.parse(err.message.slice(jsonStart)) as Record<string, LiteErrorJSON>;
    return parsed[marker] ?? null;
  } catch {
    return null;
  }
}

describe('envelopeIpcError', () => {
  it('envelopes a LiteError with its stable code preserved', () => {
    const typed = new KVError({
      code: KV_ERROR_CODES.TIMEOUT,
      message: 'KV get timed out after 5000ms',
      remediation: 'Check your network and try again.',
    });
    const wire = envelopeIpcError('__kvError', typed);
    const payload = parseEnvelope(wire, '__kvError');
    expect(payload).not.toBeNull();
    expect(payload?.code).toBe('KV_TIMEOUT');
    expect(payload?.message).toBe('KV get timed out after 5000ms');
    expect(payload?.remediation).toBe('Check your network and try again.');
  });

  it('envelopes a plain Error as UNKNOWN with the message preserved', () => {
    const wire = envelopeIpcError('__neonError', new Error('cypher must be a string'));
    const payload = parseEnvelope(wire, '__neonError');
    expect(payload?.code).toBe('UNKNOWN');
    expect(payload?.message).toBe('cypher must be a string');
  });

  it('envelopes a non-Error throw (string) as UNKNOWN', () => {
    const wire = envelopeIpcError('__toolsError', 'boom');
    const payload = parseEnvelope(wire, '__toolsError');
    expect(payload?.code).toBe('UNKNOWN');
    expect(payload?.message).toBe('boom');
  });

  it('passes an already-enveloped error through untouched (no double wrap)', () => {
    const first = envelopeIpcError('__idwError', new Error('raw'));
    const second = envelopeIpcError('__idwError', first);
    expect(second).toBe(first);
    // Parsing still yields the ORIGINAL payload, not UNKNOWN-of-JSON.
    const payload = parseEnvelope(second, '__idwError');
    expect(payload?.message).toBe('raw');
  });

  it('survives simulating the Electron IPC round trip (prefixed message)', () => {
    const wire = envelopeIpcError('__mainWindowError', new Error('view is gone'));
    // Electron re-throws in the renderer with this prefix; parseError
    // implementations skip to the first `{`.
    const rendererSide = new Error(
      `Error invoking remote method 'lite:main-window:open-tab': Error: ${wire.message}`
    );
    const payload = parseEnvelope(rendererSide, '__mainWindowError');
    expect(payload?.code).toBe('UNKNOWN');
    expect(payload?.message).toBe('view is gone');
  });

  it('falls back to a minimal envelope when context is unserializable', () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    const typed = new LiteError({
      code: 'TEST_CIRCULAR',
      message: 'has circular context',
      context: circular,
    });
    const wire = envelopeIpcError('__kvError', typed);
    const payload = parseEnvelope(wire, '__kvError');
    expect(payload?.code).toBe('UNKNOWN');
    expect(payload?.message).toBe('has circular context');
  });
});

describe('wrapIpcHandler', () => {
  it('passes through the resolved value untouched', async () => {
    const handler = wrapIpcHandler('__kvError', async (a: number, b: number) => a + b);
    await expect(handler(2, 3)).resolves.toBe(5);
  });

  it('envelopes a typed error thrown by the handler (code preserved)', async () => {
    const handler = wrapIpcHandler('__kvError', async () => {
      throw new KVError({ code: KV_ERROR_CODES.HTTP, message: 'HTTP 503' });
    });
    const err = await handler().catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    const payload = parseEnvelope(err as Error, '__kvError');
    expect(payload?.code).toBe('KV_HTTP');
  });

  it('envelopes a synchronous validation throw as UNKNOWN', async () => {
    const handler = wrapIpcHandler('__neonError', (): string => {
      throw new Error('id must be a non-empty string');
    });
    const err = await handler().catch((e: unknown) => e as Error);
    const payload = parseEnvelope(err as Error, '__neonError');
    expect(payload?.code).toBe('UNKNOWN');
    expect(payload?.message).toBe('id must be a non-empty string');
  });

  it('does not double-wrap handlers that already threw an envelope', async () => {
    const handler = wrapIpcHandler('__neonError', async () => {
      // The hand-built envelope pattern that predates the wrapper
      // (e.g. neon QUERY_NAMED unknown-name rejection).
      throw new Error(
        JSON.stringify({
          __neonError: {
            name: 'NeonError',
            code: 'NEON_INVALID_INPUT',
            message: 'Unknown named query: nope',
            context: {},
            remediation: 'Register it in the owning module.',
          },
        })
      );
    });
    const err = await handler().catch((e: unknown) => e as Error);
    const payload = parseEnvelope(err as Error, '__neonError');
    expect(payload?.code).toBe('NEON_INVALID_INPUT');
    expect(payload?.message).toBe('Unknown named query: nope');
  });
});
