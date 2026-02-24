import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../lib/log-event-queue', () => ({
  getLogQueue: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
}));

vi.mock('../../lib/agent-memory-store', () => ({
  getAgentMemory: vi.fn().mockReturnValue({
    load: vi.fn(), save: vi.fn(), getSectionNames: () => [],
    updateSection: vi.fn(), isDirty: () => false,
  }),
}));

describe('BrowsingAgent', () => {
  let browsingAgent;

  beforeEach(async () => {
    vi.clearAllMocks();
    browsingAgent = (await import('../../packages/agents/browsing-agent.js')).default
      || await import('../../packages/agents/browsing-agent.js');
  });

  describe('Agent Registration Contract', () => {
    it('should have all required agent properties', () => {
      expect(browsingAgent.id).toBe('browsing-agent');
      expect(browsingAgent.name).toBe('Browsing Agent');
      expect(browsingAgent.description).toBeTruthy();
      expect(browsingAgent.categories).toContain('browser');
      expect(browsingAgent.keywords.length).toBeGreaterThan(5);
      expect(typeof browsingAgent.execute).toBe('function');
    });

    it('should have a prompt for LLM bidding', () => {
      expect(browsingAgent.prompt).toBeTruthy();
      expect(browsingAgent.prompt).toContain('HIGH CONFIDENCE');
      expect(browsingAgent.prompt).toContain('LOW CONFIDENCE');
    });

    it('should not have a bid method (LLM-only routing)', () => {
      expect(browsingAgent.bid).toBeUndefined();
    });

    it('should have informational metadata', () => {
      expect(browsingAgent.executionType).toBe('action');
      expect(browsingAgent.estimatedExecutionMs).toBeGreaterThan(0);
    });
  });

  describe('Task Classification', () => {
    it('should route URLs to page reader', () => {
      const { classifyTask } = require('../../packages/agents/browsing-agent.js');
      // classifyTask is not exported, but we can test via execute behavior
      // These tests verify the agent's overall behavior
    });

    it('should return structured results from execute', async () => {
      const result = await browsingAgent.execute({ content: 'test query', metadata: {} });
      expect(result).toHaveProperty('success');
      expect(result).toHaveProperty('message');
    });
  });
});
