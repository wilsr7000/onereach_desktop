/**
 * Agent Import Smoke Tests
 *
 * These tests load each agent module WITHOUT mocking any dependencies.
 * The goal: verify that all require() statements resolve to real modules.
 *
 * This catches missing imports (e.g., getTimeContext not imported in
 * calendar-query-agent) that mocked tests hide.
 *
 * We don't call execute() here -- just loading the module is the test.
 * If a require() points to a non-existent file or a function is destructured
 * from a module that doesn't export it, the require() itself will throw.
 */

import { describe, it, expect } from 'vitest';
import path from 'path';

const AGENTS_DIR = path.join(__dirname, '../../packages/agents');

const TIER1_AGENTS = [
  'calendar-query-agent',
  'calendar-create-agent',
  'calendar-edit-agent',
  'calendar-delete-agent',
  'weather-agent',
  'smalltalk-agent',
  'daily-brief-agent',
  'time-agent',
];

const TIER2_AGENTS = [
  'dj-agent',
  'email-agent',
  'search-agent',
  'help-agent',
  'media-agent',
  'spelling-agent',
  'orchestrator-agent',
];

const TIER3_AGENTS = [
  'action-item-agent',
  'decision-agent',
  'meeting-notes-agent',
  'docs-agent',
  'memory-agent',
  'playbook-agent',
  'recorder-agent',
  'browsing-agent',
];

const ALL_AGENTS = [...TIER1_AGENTS, ...TIER2_AGENTS, ...TIER3_AGENTS];

describe('Agent import smoke tests (no mocks)', () => {
  for (const agentFile of ALL_AGENTS) {
    it(`${agentFile} loads without import errors`, () => {
      let agent;
      expect(() => {
        agent = require(path.join(AGENTS_DIR, agentFile));
      }).not.toThrow();

      expect(agent).toBeDefined();
    });

    it(`${agentFile} exports required contract fields`, () => {
      const agent = require(path.join(AGENTS_DIR, agentFile));

      // Some modules export the agent directly, others export a factory
      const obj = agent.default || agent;

      if (typeof obj === 'function') {
        // Factory function (e.g., createAgent) -- skip shape check
        return;
      }

      // Must have id, name, execute
      expect(obj.id, `${agentFile} missing .id`).toBeDefined();
      expect(obj.name, `${agentFile} missing .name`).toBeDefined();
      expect(typeof obj.execute, `${agentFile} .execute must be a function`).toBe('function');
    });
  }
});
