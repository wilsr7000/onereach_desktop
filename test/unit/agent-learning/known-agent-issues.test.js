/**
 * Known Agent Issues Registry Tests
 *
 * Pure logic tests -- no mocks needed beyond basic context shapes.
 *
 * Run:  npx vitest run test/unit/agent-learning/known-agent-issues.test.js
 */

import { describe, it, expect } from 'vitest';

const { KNOWN_AGENT_ISSUES, runKnownIssueChecks } = require('../../../lib/agent-learning/known-agent-issues');

function makeCtx(overrides = {}) {
  return {
    agent: { estimatedExecutionMs: 5000, memory: { enabled: false }, ...overrides.agent },
    interactions: overrides.interactions || [],
    failureRate: overrides.failureRate ?? 0,
    rephraseRate: overrides.rephraseRate ?? 0,
    uiSpecRate: overrides.uiSpecRate ?? 0,
    routingAccuracy: overrides.routingAccuracy ?? 1.0,
    avgResponseTimeMs: overrides.avgResponseTimeMs ?? 1000,
    memoryWrites: overrides.memoryWrites ?? 0,
  };
}

describe('Known Agent Issues', () => {
  it('has at least 5 registered issues', () => {
    expect(KNOWN_AGENT_ISSUES.length).toBeGreaterThanOrEqual(5);
  });

  it('every issue has required fields', () => {
    for (const issue of KNOWN_AGENT_ISSUES) {
      expect(issue.id).toBeTruthy();
      expect(issue.title).toBeTruthy();
      expect(typeof issue.detect).toBe('function');
      expect(issue.fix === null || typeof issue.fix === 'function').toBe(true);
    }
  });

  describe('KAI-001: Timeout', () => {
    it('detects when failure rate > 0.3 and 2+ timeout errors', () => {
      const ctx = makeCtx({
        failureRate: 0.4,
        interactions: [
          { error: 'Agent timed out after 30s', success: false },
          { error: 'Agent timed out after 30s', success: false },
          { error: null, success: true },
        ],
      });

      const results = runKnownIssueChecks(ctx);
      const kai001 = results.find((r) => r.id === 'KAI-001');
      expect(kai001).toBeTruthy();
      expect(kai001.fix).toBeTruthy();
      expect(kai001.fix.patch.estimatedExecutionMs).toBe(10000);
    });

    it('does not detect with low failure rate', () => {
      const ctx = makeCtx({
        failureRate: 0.1,
        interactions: [
          { error: 'Agent timed out after 30s', success: false },
          { error: 'Agent timed out after 30s', success: false },
        ],
      });

      const results = runKnownIssueChecks(ctx);
      const kai001 = results.find((r) => r.id === 'KAI-001');
      expect(kai001).toBeFalsy();
    });

    it('caps timeout at 60000ms', () => {
      const ctx = makeCtx({
        agent: { estimatedExecutionMs: 50000 },
        failureRate: 0.5,
        interactions: [
          { error: 'timed out', success: false },
          { error: 'timed out', success: false },
          { error: 'timed out', success: false },
        ],
      });

      const results = runKnownIssueChecks(ctx);
      const kai001 = results.find((r) => r.id === 'KAI-001');
      expect(kai001.fix.patch.estimatedExecutionMs).toBe(60000);
    });
  });

  describe('KAI-002: Routing confusion', () => {
    it('detects when routing accuracy < 0.6', () => {
      const ctx = makeCtx({
        routingAccuracy: 0.4,
        interactions: Array(5).fill({ success: true }),
      });

      const results = runKnownIssueChecks(ctx);
      const kai002 = results.find((r) => r.id === 'KAI-002');
      expect(kai002).toBeTruthy();
      expect(kai002.needsEscalation).toBe(true);
    });
  });

  describe('KAI-003: Empty message', () => {
    it('detects when 3+ interactions return no/generic message', () => {
      const ctx = makeCtx({
        interactions: [
          { message: 'Done', success: true },
          { message: '', success: true },
          { message: 'All done', success: true },
          { message: null, success: true },
          { message: 'Good response', success: true },
        ],
      });

      const results = runKnownIssueChecks(ctx);
      const kai003 = results.find((r) => r.id === 'KAI-003');
      expect(kai003).toBeTruthy();
      expect(kai003.needsEscalation).toBe(true);
    });
  });

  describe('KAI-005: No UI when applicable', () => {
    it('detects when uiSpecRate is 0 and agent has long successful messages', () => {
      const ctx = makeCtx({
        uiSpecRate: 0,
        interactions: [
          { success: true, message: 'A'.repeat(150) },
          { success: true, message: 'B'.repeat(150) },
          { success: true, message: 'short' },
          { success: true, message: 'C'.repeat(150) },
          { success: false, message: 'error' },
        ],
      });

      const results = runKnownIssueChecks(ctx);
      const kai005 = results.find((r) => r.id === 'KAI-005');
      expect(kai005).toBeTruthy();
    });

    it('does not detect when agent already uses UI', () => {
      const ctx = makeCtx({
        uiSpecRate: 0.5,
        interactions: Array(6).fill({ success: true, message: 'A'.repeat(150) }),
      });

      const results = runKnownIssueChecks(ctx);
      const kai005 = results.find((r) => r.id === 'KAI-005');
      expect(kai005).toBeFalsy();
    });
  });

  describe('runKnownIssueChecks', () => {
    it('returns empty array when no issues detected', () => {
      const ctx = makeCtx({ interactions: [{ success: true, message: 'ok' }] });
      const results = runKnownIssueChecks(ctx);
      expect(results).toEqual([]);
    });

    it('handles detect function throwing', () => {
      const ctx = makeCtx();
      ctx.interactions = null; // will cause .filter to throw in some detectors
      const results = runKnownIssueChecks(ctx);
      expect(Array.isArray(results)).toBe(true);
    });
  });
});
