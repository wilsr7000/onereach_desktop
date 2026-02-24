import { describe, it, expect, vi, beforeEach } from 'vitest';

// Agent template uses require() internally, which doesn't work with vi.mock for CommonJS.
// We'll test at the public API level and accept that some internal calls go through real modules.

describe('BrowsingAgentTemplate', () => {
  let BrowsingAgentTemplate, createAgent;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    const module = await import('../../lib/browsing-agent-template.js');
    BrowsingAgentTemplate = module.BrowsingAgentTemplate;
    createAgent = module.createAgent;
  });

  describe('createAgent()', () => {
    it('should create an agent from a definition', () => {
      const agent = createAgent({
        id: 'test-agent',
        name: 'Test Agent',
        description: 'A test agent',
        categories: ['test'],
      });

      expect(agent).toBeInstanceOf(BrowsingAgentTemplate);
      expect(agent.id).toBe('test-agent');
      expect(agent.name).toBe('Test Agent');
    });

    it('should set sensible defaults', () => {
      const agent = createAgent({ id: 'minimal', name: 'Minimal' });

      expect(agent.categories).toEqual(['browser', 'web']);
      expect(agent.retry.maxAttempts).toBe(3);
      expect(agent.fallback.strategy).toBe('llm');
      expect(agent.fallback.profile).toBe('fast');
    });
  });

  describe('execute()', () => {
    it('should format output with agent metadata and required fields', async () => {
      const agent = createAgent({
        id: 'output-agent',
        name: 'Output Test',
        retry: { maxAttempts: 1, backoff: 'exponential', retryOn: [] },
      });

      const result = await agent.execute({ query: 'test' });

      expect(result.agentId).toBe('output-agent');
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
      expect(result).toHaveProperty('success');
      expect(result).toHaveProperty('path');
      expect(result).toHaveProperty('attempts');
      expect(result).toHaveProperty('errors');
    });

    it('should handle all attempts exhausted gracefully', async () => {
      const agent = createAgent({
        id: 'fail-agent',
        name: 'Fail Agent',
        retry: { maxAttempts: 1, backoff: 'exponential', retryOn: [] },
      });

      const result = await agent.execute({ query: 'test' });

      expect(result.agentId).toBe('fail-agent');
      expect(result.attempts).toBe(1);
    });
  });

  describe('toAgentRegistration()', () => {
    it('should produce a valid exchange registration', () => {
      const agent = createAgent({
        id: 'register-test',
        name: 'Registration Test',
        description: 'Tests registration',
        categories: ['weather', 'data'],
        bidding: {
          keywords: ['weather', 'forecast'],
          examples: ['what is the weather in Austin'],
        },
      });

      const reg = agent.toAgentRegistration();

      expect(reg.agentId).toBe('register-test');
      expect(reg.agentVersion).toBe('1.0.0');
      expect(reg.categories).toContain('weather');
      expect(reg.capabilities.executionType).toBe('browsing-agent');
      expect(reg.capabilities.keywords).toContain('weather');
      expect(reg.capabilities.examples).toContain('what is the weather in Austin');
    });
  });

  describe('Variable Interpolation', () => {
    it('should interpolate object input into templates', () => {
      const agent = createAgent({ id: 'interp', name: 'Interpolation' });
      const result = agent._interpolate('Hello {name}, you are {age}', { name: 'Alice', age: '30' });
      expect(result).toBe('Hello Alice, you are 30');
    });

    it('should interpolate string input as {query} and {input}', () => {
      const agent = createAgent({ id: 'interp', name: 'Interpolation' });
      expect(agent._interpolate('Search for {query}', 'Austin weather')).toBe('Search for Austin weather');
      expect(agent._interpolate('Input: {input}', 'test')).toBe('Input: test');
    });

    it('should handle missing variables gracefully', () => {
      const agent = createAgent({ id: 'interp', name: 'Interpolation' });
      expect(agent._interpolate('Hello {missing}', {})).toBe('Hello ');
    });
  });

  describe('Backoff Delay', () => {
    it('should compute exponential backoff', () => {
      const agent = createAgent({
        id: 'backoff',
        name: 'Backoff',
        retry: { maxAttempts: 5, backoff: 'exponential' },
      });

      expect(agent._getBackoffDelay(0)).toBe(1000);
      expect(agent._getBackoffDelay(1)).toBe(2000);
      expect(agent._getBackoffDelay(2)).toBe(4000);
      expect(agent._getBackoffDelay(3)).toBe(8000);
      expect(agent._getBackoffDelay(10)).toBeLessThanOrEqual(15000);
    });
  });
});
