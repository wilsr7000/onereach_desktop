/**
 * Converter Agent Test Harness
 * Reusable lifecycle compliance test suite for any converter agent.
 *
 * Usage:
 *   import { testConverterAgent } from './converter-test-harness.js';
 *   import { createMockAIService } from './conversion-mocks.js';
 *   import MyConverter from '../../lib/converters/my-converter.js';
 *
 *   const mockAI = createMockAIService();
 *   testConverterAgent(MyConverter, {
 *     sampleInput: { content: '...', from: 'md', to: 'html' },
 *     expectedFromFormats: ['md'],
 *     expectedToFormats: ['html'],
 *     expectedStrategies: ['default', 'strict'],
 *     mockAI,
 *     // Optional: additional context passed to agent.convert() and agent.plan()
 *     context: {
 *       metadata: { sourceFile: 'report.md', author: 'test-user' },
 *       hints: { preserveFormatting: true },
 *     },
 *   });
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Run the standard lifecycle compliance test suite for a converter agent.
 *
 * @param {Function} AgentClass - The agent class to test
 * @param {Object} config
 * @param {*}        config.sampleInput         - Representative input to convert
 * @param {string[]} config.expectedFromFormats  - Expected `from` format list
 * @param {string[]} config.expectedToFormats    - Expected `to` format list
 * @param {string[]} config.expectedStrategies   - Expected strategy IDs
 * @param {Object}   config.mockAI              - Mock AI service
 * @param {Object}   [config.context]           - Additional context passed through
 *   to `plan()` and `convert()` as options. Use this to supply metadata, hints,
 *   evaluation criteria, or any agent-specific parameters the converter reads
 *   from its options argument.
 *   Common fields:
 *     context.metadata   - Descriptive info about the source (filename, author, etc.)
 *     context.hints      - Conversion preferences (preserveFormatting, targetAudience, etc.)
 *     context.evalCriteria - Custom rubric criteria for quality evaluation
 */
export function testConverterAgent(AgentClass, config) {
  const {
    sampleInput,
    expectedFromFormats,
    expectedToFormats,
    expectedStrategies,
    mockAI,
    context = {},
  } = config;

  // Merge context into the options object passed to convert()/plan()
  const sampleOptions = Object.keys(context).length > 0 ? { ...context } : undefined;

  describe(`${AgentClass.name || 'ConverterAgent'} (lifecycle compliance)`, () => {
    let agent;

    beforeEach(() => {
      agent = new AgentClass({ ai: mockAI, silent: true });
    });

    it('has required agent identity properties', () => {
      expect(agent.id).toMatch(/^converter:/);
      expect(agent.name).toBeTruthy();
      expect(typeof agent.name).toBe('string');
      expect(agent.description).toBeTruthy();
      expect(Array.isArray(agent.from)).toBe(true);
      expect(Array.isArray(agent.to)).toBe(true);
      expect(Array.isArray(agent.modes)).toBe(true);
      expect(agent.from.length).toBeGreaterThan(0);
      expect(agent.to.length).toBeGreaterThan(0);
    });

    it('from/to formats match expected', () => {
      for (const fmt of expectedFromFormats) {
        expect(agent.from).toContain(fmt);
      }
      for (const fmt of expectedToFormats) {
        expect(agent.to).toContain(fmt);
      }
    });

    it('defines at least 2 strategies', () => {
      expect(agent.strategies.length).toBeGreaterThanOrEqual(2);
      agent.strategies.forEach(s => {
        expect(s.id).toBeTruthy();
        expect(s.description).toBeTruthy();
      });
    });

    it('strategy IDs match expected', () => {
      const ids = agent.strategies.map(s => s.id);
      for (const expected of expectedStrategies) {
        expect(ids).toContain(expected);
      }
    });

    it('plan() returns strategy + reasoning', async () => {
      const plan = await agent.plan(sampleInput, sampleOptions);
      expect(plan.strategy).toBeTruthy();
      expect(typeof plan.strategy).toBe('string');
      expect(plan.reasoning).toBeTruthy();
    });

    it('convert() returns result with report', async () => {
      const result = await agent.convert(sampleInput, sampleOptions);
      expect(typeof result.success).toBe('boolean');
      expect(result.report).toBeDefined();
      expect(result.report.agentId).toBe(agent.id);
      expect(result.report.agentName).toBe(agent.name);
      expect(Array.isArray(result.report.attempts)).toBe(true);
      expect(result.report.attempts.length).toBeGreaterThan(0);
      expect(result.report.decision).toBeDefined();
    });

    it('report includes event log', async () => {
      const result = await agent.convert(sampleInput, sampleOptions);
      expect(Array.isArray(result.report.events)).toBe(true);
      expect(result.report.events.length).toBeGreaterThan(0);
      // Should have start event
      expect(result.report.events.some(e => e.event === 'converter:start')).toBe(true);
    });

    it('handles null input gracefully', async () => {
      const result = await agent.convert(null, sampleOptions);
      expect(result.report).toBeDefined();
      expect(result.report.attempts.length).toBeGreaterThan(0);
    });

    it('logger emits events', async () => {
      const events = [];
      agent.logger.on('converter:event', (e) => events.push(e));
      await agent.convert(sampleInput, sampleOptions);
      expect(events.length).toBeGreaterThan(0);
    });

    // Context pass-through verification (only runs when context was provided)
    if (sampleOptions) {
      it('passes context through to plan() and convert()', async () => {
        // Spy on plan to verify context arrives
        const planSpy = vi.spyOn(agent, 'plan');
        await agent.convert(sampleInput, sampleOptions);

        // plan() should have been called with options containing the context fields
        expect(planSpy).toHaveBeenCalled();
        const planArgs = planSpy.mock.calls[0];
        // plan receives (input, options) where options is spread from convert's options
        const planOpts = planArgs[1];
        expect(planOpts).toBeDefined();
        // Context metadata should appear in plan options
        if (context.metadata) {
          expect(planOpts.metadata).toBeDefined();
          for (const key of Object.keys(context.metadata)) {
            expect(planOpts.metadata[key]).toBe(context.metadata[key]);
          }
        }
        planSpy.mockRestore();
      });
    }
  });
}
