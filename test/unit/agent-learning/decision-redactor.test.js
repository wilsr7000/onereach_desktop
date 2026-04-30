/**
 * Decision Redactor tests (Phase 1 self-learning arbitration)
 *
 * Run: npx vitest run test/unit/agent-learning/decision-redactor.test.js
 */

import { describe, it, expect } from 'vitest';

const {
  redactString,
  redactDecision,
  PATTERNS,
} = require('../../../lib/agent-learning/decision-redactor');

describe('redactString', () => {
  it('returns empty string + empty counts for non-string input', () => {
    expect(redactString(null)).toEqual({ redacted: '', counts: {} });
    expect(redactString(undefined)).toEqual({ redacted: '', counts: {} });
    expect(redactString(42)).toEqual({ redacted: '', counts: {} });
  });

  it('returns input unchanged when no PII matches', () => {
    const r = redactString('what time is it');
    expect(r.redacted).toBe('what time is it');
    expect(r.counts).toEqual({});
  });

  it('redacts emails', () => {
    const r = redactString('contact alice@example.com please');
    expect(r.redacted).toBe('contact <EMAIL> please');
    expect(r.counts.EMAIL).toBe(1);
  });

  it('redacts URLs before emails (URL contains @)', () => {
    const r = redactString('see https://example.com/u@x for details');
    expect(r.redacted).toContain('<URL>');
    expect(r.redacted).not.toContain('example.com/u@x');
    expect(r.counts.URL).toBe(1);
  });

  it('redacts phone numbers in multiple formats', () => {
    expect(redactString('call 555-123-4567').redacted).toBe('call <PHONE>');
    expect(redactString('call (555) 123-4567').redacted).toBe('call <PHONE>');
    expect(redactString('call +1-555-123-4567').redacted).toBe('call <PHONE>');
  });

  it('redacts SSNs', () => {
    const r = redactString('ssn 123-45-6789');
    expect(r.redacted).toBe('ssn <SSN>');
    expect(r.counts.SSN).toBe(1);
  });

  it('redacts ISO dates', () => {
    const r = redactString('on 2026-04-27 the meeting');
    expect(r.redacted).toBe('on <DATE> the meeting');
  });

  it('redacts money amounts', () => {
    const r = redactString('pay $1,234.56 by Friday');
    expect(r.redacted).toBe('pay <MONEY> by Friday');
  });

  it('counts multiple hits of the same class', () => {
    const r = redactString('email a@x.com or b@y.com');
    expect(r.counts.EMAIL).toBe(2);
  });

  it('handles a string with mixed PII classes', () => {
    const r = redactString('alice@example.com lives at 123 Main Street');
    expect(r.redacted).toContain('<EMAIL>');
    expect(r.redacted).toContain('<ADDRESS>');
    expect(r.counts.EMAIL).toBe(1);
    expect(r.counts.ADDRESS).toBe(1);
  });
});

describe('redactDecision', () => {
  function makeDecision(overrides = {}) {
    return {
      type: 'arbitration-decision',
      taskId: 'task-1',
      content: 'email alice@example.com about the meeting',
      bids: [
        {
          agentId: 'a',
          agentName: 'Agent A',
          confidence: 0.9,
          score: 0.85,
          reasoning: 'I will send to alice@example.com via SMTP',
          won: true,
          busted: false,
        },
        {
          agentId: 'b',
          agentName: 'Agent B',
          confidence: 0.6,
          score: 0.55,
          reasoning: 'I can also email contacts',
          won: false,
          busted: false,
        },
      ],
      chosenWinner: 'a',
      executionMode: 'single',
      decisionPath: 'fast-path-dominant',
      outcome: {
        success: true,
        durationMs: 1200,
        bustCount: 0,
        reflectorScore: 0.8,
      },
      situationContext: {
        focusedWindow: 'mail',
        flowContext: { label: 'Send mail to bob@x.com', stepLabel: 'Compose' },
      },
      createdAt: 1700000000,
      updatedAt: 1700000000,
      ...overrides,
    };
  }

  it('returns input unchanged for non-object input', () => {
    expect(redactDecision(null).redacted).toBeNull();
    expect(redactDecision(undefined).redacted).toBeUndefined();
  });

  it('redacts task content', () => {
    const r = redactDecision(makeDecision());
    expect(r.redacted.content).toBe('email <EMAIL> about the meeting');
    expect(r.totalCounts.EMAIL).toBeGreaterThanOrEqual(1);
  });

  it('redacts each bid reasoning', () => {
    const r = redactDecision(makeDecision());
    expect(r.redacted.bids[0].reasoning).toBe('I will send to <EMAIL> via SMTP');
    expect(r.redacted.bids[1].reasoning).toBe('I can also email contacts'); // no PII
  });

  it('preserves all structural fields verbatim', () => {
    const original = makeDecision();
    const r = redactDecision(original);
    expect(r.redacted.taskId).toBe(original.taskId);
    expect(r.redacted.chosenWinner).toBe(original.chosenWinner);
    expect(r.redacted.executionMode).toBe(original.executionMode);
    expect(r.redacted.decisionPath).toBe(original.decisionPath);
    expect(r.redacted.bids[0].agentId).toBe('a');
    expect(r.redacted.bids[0].confidence).toBe(0.9);
    expect(r.redacted.bids[0].score).toBe(0.85);
    expect(r.redacted.bids[0].won).toBe(true);
    expect(r.redacted.outcome.success).toBe(true);
    expect(r.redacted.outcome.durationMs).toBe(1200);
    expect(r.redacted.outcome.reflectorScore).toBe(0.8);
    expect(r.redacted.createdAt).toBe(1700000000);
  });

  it('redacts situationContext flowContext labels', () => {
    const r = redactDecision(makeDecision());
    expect(r.redacted.situationContext.flowContext.label).toContain('<EMAIL>');
  });

  it('does not mutate the input object', () => {
    const original = makeDecision();
    const before = JSON.stringify(original);
    redactDecision(original);
    expect(JSON.stringify(original)).toBe(before);
  });

  it('aggregates total counts across all redacted fields', () => {
    const r = redactDecision(makeDecision());
    // content has 1 EMAIL, bid[0] has 1 EMAIL, flowContext.label has 1 EMAIL
    expect(r.totalCounts.EMAIL).toBe(3);
  });

  it('tolerates missing optional fields', () => {
    const minimal = {
      type: 'arbitration-decision',
      taskId: 't',
      content: 'no pii here',
      bids: [],
    };
    const r = redactDecision(minimal);
    expect(r.redacted.content).toBe('no pii here');
    expect(r.redacted.bids).toEqual([]);
    expect(r.totalCounts).toEqual({});
  });
});

describe('PATTERNS export', () => {
  it('exports a non-empty pattern array', () => {
    expect(Array.isArray(PATTERNS)).toBe(true);
    expect(PATTERNS.length).toBeGreaterThan(0);
    for (const p of PATTERNS) {
      expect(typeof p.name).toBe('string');
      expect(p.re).toBeInstanceOf(RegExp);
      expect(typeof p.token).toBe('string');
    }
  });
});
