/**
 * Feedback Loop Tests
 *
 * Verifies post-deployment tracking, outcome evaluation,
 * and effectiveness memory.
 *
 * Run:  npx vitest run test/unit/agent-learning/feedback-loop.test.js
 */

import { describe, it, expect, beforeEach } from 'vitest';

const { FeedbackLoop } = require('../../../lib/agent-learning/feedback-loop');

describe('FeedbackLoop', () => {
  let loop;

  beforeEach(() => {
    loop = new FeedbackLoop();
  });

  describe('recordDeployment', () => {
    it('records a deployment and returns an id', () => {
      const id = loop.recordDeployment({
        agentId: 'agent-1',
        improvementType: 'prompt',
        specificIssue: 'fails on city names',
        preMetrics: { failureRate: 0.4, rephraseRate: 0.2, uiSpecRate: 0, avgResponseTimeMs: 2000 },
      });
      expect(id).toBeTruthy();
      expect(loop.getPendingCount()).toBe(1);
    });

    it('limits stored records', () => {
      for (let i = 0; i < 210; i++) {
        loop.recordDeployment({
          agentId: `a-${i}`, improvementType: 'prompt',
          preMetrics: { failureRate: 0.5 },
        });
      }
      expect(loop.getAllRecords().length).toBeLessThanOrEqual(200);
    });
  });

  describe('evaluatePendingDeployments', () => {
    it('marks effective when failure rate drops significantly', () => {
      loop.recordDeployment({
        agentId: 'agent-1', improvementType: 'prompt',
        specificIssue: 'test issue',
        preMetrics: { failureRate: 0.5, rephraseRate: 0.3, uiSpecRate: 0, avgResponseTimeMs: 2000 },
      });

      // Backdate the deployment so cooldown has passed
      loop._deployments[0].deployedAt = Date.now() - 10 * 60 * 1000;

      const getWindow = () => ({
        interactions: [
          { timestamp: Date.now() - 1000, success: true },
          { timestamp: Date.now() - 2000, success: true },
          { timestamp: Date.now() - 3000, success: false },
        ],
        failureRate: 0.15,
        rephraseRate: 0.1,
        uiSpecRate: 0,
        avgResponseTimeMs: 1500,
      });

      const evaluated = loop.evaluatePendingDeployments(getWindow);
      expect(evaluated).toBe(1);

      const record = loop.getAllRecords()[0];
      expect(record.outcome).toBe('effective');
      expect(record.delta.failureRate).toBeLessThan(0);
    });

    it('marks degraded when failure rate increases significantly', () => {
      loop.recordDeployment({
        agentId: 'agent-1', improvementType: 'routing',
        preMetrics: { failureRate: 0.2, rephraseRate: 0.1, uiSpecRate: 0, avgResponseTimeMs: 1000 },
      });
      loop._deployments[0].deployedAt = Date.now() - 10 * 60 * 1000;

      const getWindow = () => ({
        interactions: Array(5).fill({ timestamp: Date.now(), success: false }),
        failureRate: 0.6,
        rephraseRate: 0.4,
        uiSpecRate: 0,
        avgResponseTimeMs: 3000,
      });

      loop.evaluatePendingDeployments(getWindow);
      expect(loop.getAllRecords()[0].outcome).toBe('degraded');
    });

    it('skips deployments within cooldown period', () => {
      loop.recordDeployment({
        agentId: 'agent-1', improvementType: 'prompt',
        preMetrics: { failureRate: 0.5 },
      });

      const evaluated = loop.evaluatePendingDeployments(() => ({
        interactions: Array(5).fill({ timestamp: Date.now(), success: true }),
        failureRate: 0.1,
      }));

      expect(evaluated).toBe(0);
    });
  });

  describe('effectiveness memory', () => {
    it('tracks effectiveness scores by fix type', () => {
      loop.recordDeployment({
        agentId: 'a', improvementType: 'prompt', specificIssue: 'test',
        preMetrics: { failureRate: 0.5, rephraseRate: 0.3, uiSpecRate: 0, avgResponseTimeMs: 2000 },
      });
      loop._deployments[0].deployedAt = Date.now() - 10 * 60 * 1000;
      loop.evaluatePendingDeployments(() => ({
        interactions: Array(5).fill({ timestamp: Date.now(), success: true }),
        failureRate: 0.1, rephraseRate: 0.05, uiSpecRate: 0, avgResponseTimeMs: 1000,
      }));

      loop.recordDeployment({
        agentId: 'b', improvementType: 'prompt', specificIssue: 'another',
        preMetrics: { failureRate: 0.4, rephraseRate: 0.2, uiSpecRate: 0, avgResponseTimeMs: 1500 },
      });
      loop._deployments[1].deployedAt = Date.now() - 10 * 60 * 1000;
      loop.evaluatePendingDeployments(() => ({
        interactions: Array(5).fill({ timestamp: Date.now(), success: true }),
        failureRate: 0.1, rephraseRate: 0.05, uiSpecRate: 0, avgResponseTimeMs: 1000,
      }));

      expect(loop.getEffectivenessScore('prompt')).toBeGreaterThan(0.5);
    });

    it('returns 0.5 for unknown fix types', () => {
      expect(loop.getEffectivenessScore('unknown-type')).toBe(0.5);
    });

    it('returns ranked fix types', () => {
      // Record and evaluate two types
      for (const type of ['prompt', 'routing']) {
        loop.recordDeployment({
          agentId: 'a', improvementType: type, specificIssue: 'test',
          preMetrics: { failureRate: 0.5, rephraseRate: 0.3, uiSpecRate: 0, avgResponseTimeMs: 2000 },
        });
        loop.recordDeployment({
          agentId: 'b', improvementType: type, specificIssue: 'test2',
          preMetrics: { failureRate: 0.4, rephraseRate: 0.2, uiSpecRate: 0, avgResponseTimeMs: 1500 },
        });
      }

      // Backdate all
      for (const d of loop._deployments) d.deployedAt = Date.now() - 10 * 60 * 1000;

      loop.evaluatePendingDeployments(() => ({
        interactions: Array(5).fill({ timestamp: Date.now(), success: true }),
        failureRate: 0.1, rephraseRate: 0.05, uiSpecRate: 0, avgResponseTimeMs: 1000,
      }));

      const ranked = loop.getRankedFixTypes();
      expect(ranked.length).toBeGreaterThan(0);
      expect(ranked[0]).toHaveProperty('type');
      expect(ranked[0]).toHaveProperty('effectivenessRate');
    });
  });

  describe('getPatternContext', () => {
    it('returns null when no patterns exist', () => {
      expect(loop.getPatternContext('prompt', 'timeout')).toBeNull();
    });
  });

  describe('clear', () => {
    it('resets all state', () => {
      loop.recordDeployment({
        agentId: 'a', improvementType: 'prompt',
        preMetrics: { failureRate: 0.5 },
      });
      loop.clear();
      expect(loop.getAllRecords()).toHaveLength(0);
      expect(loop.getPendingCount()).toBe(0);
    });
  });
});
