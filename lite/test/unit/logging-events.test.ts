/**
 * Logging events tests -- focused on the internal pieces (matchPattern,
 * serializeError, Span lifecycle) without going through the LoggingApi
 * public surface.
 */

import { describe, it, expect } from 'vitest';
import {
  matchPattern,
  serializeError,
  Span,
} from '../../logging/events.js';
import { LiteError } from '../../errors.js';

describe('matchPattern', () => {
  it('* matches anything', () => {
    expect(matchPattern('*', 'kv.set')).toBe(true);
    expect(matchPattern('*', '')).toBe(true);
    expect(matchPattern('*', 'a.b.c.d.e')).toBe(true);
  });

  it('exact match', () => {
    expect(matchPattern('kv.set', 'kv.set')).toBe(true);
    expect(matchPattern('kv.set', 'kv.get')).toBe(false);
    expect(matchPattern('kv.set', 'kv.set.start')).toBe(false);
  });

  it('prefix.* matches anything starting with the prefix', () => {
    expect(matchPattern('kv.*', 'kv.set')).toBe(true);
    expect(matchPattern('kv.*', 'kv.set.start')).toBe(true);
    expect(matchPattern('kv.*', 'kv')).toBe(false); // requires the trailing dot
    expect(matchPattern('kv.*', 'bug-report.save')).toBe(false);
  });

  it('*.suffix matches anything ending with the suffix', () => {
    expect(matchPattern('*.fail', 'kv.set.fail')).toBe(true);
    expect(matchPattern('*.fail', 'op.fail')).toBe(true);
    expect(matchPattern('*.fail', 'kv.set')).toBe(false);
    expect(matchPattern('*.fail', 'failed')).toBe(false);
  });

  it('prefix.*.suffix matches both ends with anything in between', () => {
    expect(matchPattern('kv.*.fail', 'kv.set.fail')).toBe(true);
    expect(matchPattern('kv.*.fail', 'kv.delete.fail')).toBe(true);
    expect(matchPattern('kv.*.fail', 'bug-report.set.fail')).toBe(false);
    expect(matchPattern('kv.*.fail', 'kv.set.finish')).toBe(false);
  });

  it('rejects pattern with no star and no exact match', () => {
    expect(matchPattern('kv.set', 'kv.SET')).toBe(false); // case-sensitive
  });
});

describe('serializeError', () => {
  it('LiteError surfaces code, message, remediation, context, name', () => {
    const err = new LiteError({
      code: 'TEST_X',
      message: 'broke',
      context: { op: 'sample', count: 3 },
      remediation: 'try again',
    });
    const out = serializeError(err);
    expect(out.code).toBe('TEST_X');
    expect(out.message).toBe('broke');
    expect(out.remediation).toBe('try again');
    expect(out.context).toEqual({ op: 'sample', count: 3 });
    expect(out.name).toBe('LiteError');
  });

  it('plain Error gets code=UNKNOWN with name preserved', () => {
    const out = serializeError(new TypeError('not a function'));
    expect(out.code).toBe('UNKNOWN');
    expect(out.message).toBe('not a function');
    expect(out.name).toBe('TypeError');
  });

  it('non-Error value gets code=UNKNOWN and stringified message', () => {
    expect(serializeError('a string').message).toBe('a string');
    expect(serializeError({ x: 1 }).message).toBe('{"x":1}');
    expect(serializeError(42).message).toBe('42');
  });

  it('handles unserializable values gracefully', () => {
    const circular: Record<string, unknown> = { name: 'cyclical' };
    circular['self'] = circular;
    const out = serializeError(circular);
    expect(out.code).toBe('UNKNOWN');
    expect(typeof out.message).toBe('string');
    expect(out.message.length).toBeGreaterThan(0);
  });
});

describe('Span lifecycle', () => {
  function makeSpan(opts: { startedAt?: number; spanId?: string } = {}): {
    span: Span;
    emitted: Array<{ name: string; level: string; spanId: string; durationMs?: number; data?: unknown; error?: unknown }>;
    advance: (ms: number) => void;
  } {
    let now = opts.startedAt ?? 1000;
    const emitted: Array<{ name: string; level: string; spanId: string; durationMs?: number; data?: unknown; error?: unknown }> = [];
    const span = new Span({
      name: 'op',
      spanId: opts.spanId ?? 'span-1',
      startedAt: now,
      now: () => now,
      emit: (record) => emitted.push(record),
      serializeError,
    });
    return {
      span,
      emitted,
      advance: (ms: number) => {
        now += ms;
      },
    };
  }

  it('finish emits op.finish with durationMs computed from now()', () => {
    const { span, emitted, advance } = makeSpan();
    advance(50);
    span.finish();
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.name).toBe('op.finish');
    expect(emitted[0]?.spanId).toBe('span-1');
    expect(emitted[0]?.durationMs).toBe(50);
  });

  it('fail emits op.fail with serialized error and durationMs', () => {
    const { span, emitted, advance } = makeSpan();
    advance(123);
    span.fail(
      new LiteError({
        code: 'X_BAD',
        message: 'broke',
        remediation: 'fix it',
      })
    );
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.name).toBe('op.fail');
    expect(emitted[0]?.level).toBe('error');
    expect(emitted[0]?.durationMs).toBe(123);
    expect((emitted[0]?.error as { code?: string })?.code).toBe('X_BAD');
  });

  it('finish then finish is a no-op (idempotent)', () => {
    const { span, emitted } = makeSpan();
    span.finish();
    span.finish();
    expect(emitted).toHaveLength(1);
  });

  it('finish then fail is a no-op (idempotent)', () => {
    const { span, emitted } = makeSpan();
    span.finish();
    span.fail(new Error('after finish'));
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.name).toBe('op.finish');
  });

  it('fail then finish is a no-op (idempotent)', () => {
    const { span, emitted } = makeSpan();
    span.fail(new Error('first'));
    span.finish();
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.name).toBe('op.fail');
  });

  it('exposes the spanId publicly', () => {
    const { span } = makeSpan({ spanId: 'my-id' });
    expect(span.id).toBe('my-id');
    expect(span.name).toBe('op');
  });
});
