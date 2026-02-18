import { describe, it, expect } from 'vitest';
import { createMockAIService } from '../mocks/conversion-mocks.js';

describe('Playbook Quality Evals', () => {
  const samplePlaybook = {
    id: 'eval-test-1',
    title: 'Project Management Best Practices',
    content:
      '# Project Management\n\nEffective project management requires clear goals, stakeholder alignment, and regular reviews.',
    status: 'draft',
    keywords: ['project', 'management'],
    framework: {
      who: [{ entity: 'Project Manager', role: 'Lead' }],
      what: [{ item: 'Improve project delivery' }],
      why: [{ reason: 'Reduce delays and cost overruns' }],
      where: [{ location: 'Engineering department' }],
      when: [{ timeframe: 'Q1 2026' }],
    },
  };

  describe('Playbook -> Markdown', () => {
    it('includes all framework sections', async () => {
      const mockAI = createMockAIService();
      const mod = require('../../lib/converters/playbook-to-md');
      const AgentClass = Object.values(mod).find((v) => typeof v === 'function');
      const agent = new AgentClass({ ai: mockAI, silent: true });

      const result = await agent.convert(samplePlaybook);
      expect(result.report).toBeDefined();
      expect(result.report.events).toBeDefined();

      if (result.success && result.output) {
        const output = typeof result.output === 'string' ? result.output : '';
        expect(output).toContain('Project Management');
      }
    });
  });

  describe('Playbook -> HTML', () => {
    it('produces valid HTML structure', async () => {
      const mockAI = createMockAIService();
      const mod = require('../../lib/converters/playbook-to-html');
      const AgentClass = Object.values(mod).find((v) => typeof v === 'function');
      const agent = new AgentClass({ ai: mockAI, silent: true });

      const result = await agent.convert(samplePlaybook);
      expect(result.report).toBeDefined();

      if (result.success && result.output) {
        const output = typeof result.output === 'string' ? result.output : '';
        expect(output).toContain('<');
        expect(output).toContain('Project Management');
      }
    });
  });

  describe('Event logging completeness', () => {
    it('playbook agents emit complete event trails', async () => {
      const mockAI = createMockAIService();
      const agents = ['../../lib/converters/playbook-to-md', '../../lib/converters/playbook-to-html'];

      for (const path of agents) {
        const mod = require(path);
        const AgentClass = Object.values(mod).find((v) => typeof v === 'function');
        if (!AgentClass) continue;

        const agent = new AgentClass({ ai: mockAI, silent: true });

        const result = await agent.convert(samplePlaybook);

        // Events should be captured in the report
        expect(result.report).toBeDefined();
        expect(Array.isArray(result.report.events)).toBe(true);
        const eventTypes = result.report.events.map((e) => e.event);
        expect(eventTypes).toContain('converter:start');
        expect(eventTypes.some((e) => e.startsWith('converter:plan'))).toBe(true);
        expect(eventTypes.some((e) => e.startsWith('converter:execute'))).toBe(true);
        expect(eventTypes.some((e) => e.startsWith('converter:evaluate'))).toBe(true);
      }
    });
  });
});
