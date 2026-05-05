import { describe, it, expect } from 'vitest';
import { redact, bucketFor, REDACTION_PATTERNS } from '../../bug-report-redaction-patterns.js';

describe('redact', () => {
  it('returns input unchanged when no patterns match', () => {
    const input = 'this is a normal message with no secrets';
    const result = redact(input);
    expect(result.text).toBe(input);
    expect(result.totalCount).toBe(0);
    expect(result.counts).toEqual({});
  });

  it('masks OpenAI keys', () => {
    const input = 'my key is sk-abc123XYZ456789012345 and that is bad';
    const result = redact(input);
    expect(result.text).toContain('[REDACTED:OPENAI_KEY]');
    expect(result.text).not.toContain('sk-abc123XYZ456789012345');
    expect(result.counts.OPENAI_KEY).toBe(1);
    expect(result.totalCount).toBe(1);
  });

  it('masks AWS access keys', () => {
    const result = redact('AWS key: AKIAIOSFODNN7EXAMPLE');
    expect(result.text).toContain('[REDACTED:AWS_ACCESS_KEY]');
    expect(result.counts.AWS_ACCESS_KEY).toBe(1);
  });

  it('masks GitHub PATs', () => {
    const result = redact('token=ghp_1234567890abcdefghij1234567890abcdefgh');
    expect(result.text).toContain('[REDACTED:GITHUB_PAT]');
    expect(result.counts.GITHUB_PAT).toBe(1);
  });

  it('masks JWTs', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const result = redact(`bearer ${jwt}`);
    expect(result.counts.JWT).toBeGreaterThanOrEqual(1);
    expect(result.text).toContain('[REDACTED:JWT]');
  });

  it('masks Bearer tokens', () => {
    const result = redact('Authorization: Bearer abcDEF123-_=');
    expect(result.text).toContain('[REDACTED:BEARER_TOKEN]');
    expect(result.counts.BEARER_TOKEN).toBe(1);
  });

  it('masks env-var idioms', () => {
    const result = redact('OPENAI_API_KEY=sk-secretvalue123\nANTHROPIC_API_KEY=other');
    expect(result.text).toContain('[REDACTED:API_KEY_ENV]');
    // ANTHROPIC_API_KEY=other matches API_KEY_ENV; sk-secretvalue123 may also match OPENAI_KEY
    expect(result.totalCount).toBeGreaterThanOrEqual(2);
  });

  it('masks multiple patterns in one input', () => {
    const input = `
      My OpenAI key: sk-abcdefghijklmnopqrstuvwx
      My AWS key: AKIAIOSFODNN7EXAMPLE
      My GitHub PAT: ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
    `;
    const result = redact(input);
    expect(result.totalCount).toBeGreaterThanOrEqual(3);
    expect(result.counts.OPENAI_KEY).toBeGreaterThanOrEqual(1);
    expect(result.counts.AWS_ACCESS_KEY).toBeGreaterThanOrEqual(1);
    expect(result.counts.GITHUB_PAT).toBeGreaterThanOrEqual(1);
  });

  it('does not false-positive on benign strings that look key-shaped', () => {
    // 'skater' starts with sk- but is too short for the OpenAI pattern (needs 20+ chars after sk-)
    const result = redact('the skater is going to skate at the AKIA-themed park');
    expect(result.totalCount).toBe(0);
  });

  it('handles empty input', () => {
    const result = redact('');
    expect(result.text).toBe('');
    expect(result.totalCount).toBe(0);
  });

  it('all global regex patterns reset state per call (no stickiness across invocations)', () => {
    const input = 'AKIAIOSFODNN7EXAMPLE';
    const r1 = redact(input);
    const r2 = redact(input);
    expect(r1.totalCount).toBe(r2.totalCount);
    expect(r1.text).toBe(r2.text);
  });
});

describe('bucketFor', () => {
  it.each([
    [0, 'none'],
    [1, 'low'],
    [2, 'low'],
    [3, 'medium'],
    [10, 'medium'],
    [11, 'high'],
    [100, 'high'],
  ])('count %d -> bucket %s', (count, expected) => {
    expect(bucketFor(count)).toBe(expected);
  });
});

describe('REDACTION_PATTERNS', () => {
  it('every pattern uses the global flag', () => {
    for (const { kind, pattern } of REDACTION_PATTERNS) {
      expect(pattern.flags).toContain('g');
      // Confirm the regex was specified with the global flag (each kind uses /.../g)
      void kind; // silence unused-var lint in environments that flag _ params
    }
  });

  it('every pattern has a non-empty kind name suitable for [REDACTED:KIND]', () => {
    for (const { kind } of REDACTION_PATTERNS) {
      expect(kind).toMatch(/^[A-Z][A-Z0-9_]*$/);
    }
  });
});
