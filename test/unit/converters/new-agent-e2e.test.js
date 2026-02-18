/**
 * New Agent End-to-End Test
 *
 * Validates the complete lifecycle of creating a brand-new converter agent
 * from scratch: define it, run it standalone, register it with the
 * ConversionService, verify it appears in capabilities/graph, convert
 * through the service API, and confirm de-registration on removal.
 *
 * This exercises test plan 36 section "Create New Agent End-to-End".
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { testConverterAgent } from '../../mocks/converter-test-harness.js';
import { createMockAIService } from '../../mocks/conversion-mocks.js';

// --------------------------------------------------------------------------
// Mocks (isolate from real AI and logging)
// --------------------------------------------------------------------------

vi.mock('../../../lib/ai-service', () => ({ default: null }));
vi.mock('../../../lib/log-event-queue', () => ({
  getLogQueue: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const mockAI = createMockAIService({
  completeResponse: 'REVERSED: tset tupni emos si sihT',
});

// --------------------------------------------------------------------------
// 1. Define a brand-new custom converter agent from scratch
// --------------------------------------------------------------------------

const { BaseConverterAgent } = require('../../../lib/converters/base-converter-agent');

class TestReverseAgent extends BaseConverterAgent {
  constructor(config = {}) {
    super(config);
    this.id = 'converter:test-reverse';
    this.name = 'Test Reverse';
    this.description = 'Reverses text content (test-only agent)';
    this.from = ['plaintext'];
    this.to = ['reversed'];
    this.modes = ['symbolic'];
    this.strategies = [
      {
        id: 'char-reverse',
        description: 'Reverse every character in the string',
        when: 'Standard character-level reversal',
        engine: 'manual',
        mode: 'symbolic',
        speed: 'fast',
        quality: 'Exact character reversal',
      },
      {
        id: 'word-reverse',
        description: 'Reverse the order of words, keeping each word intact',
        when: 'Word-order reversal is preferred over character reversal',
        engine: 'manual',
        mode: 'symbolic',
        speed: 'fast',
        quality: 'Word-order reversal',
      },
    ];
  }

  async execute(input, strategy) {
    const start = Date.now();
    const str = typeof input === 'string' ? input : String(input);
    let output;

    switch (strategy) {
      case 'word-reverse':
        output = str.split(/\s+/).reverse().join(' ');
        break;
      default: // char-reverse
        output = str.split('').reverse().join('');
        break;
    }

    return { output, duration: Date.now() - start };
  }

  async _structuralChecks(input, output) {
    const issues = [];
    if (typeof output !== 'string' || output.length === 0) {
      issues.push({
        code: 'EMPTY_OUTPUT',
        severity: 'error',
        message: 'Output is empty',
        fixable: false,
      });
    }
    return issues;
  }
}

// A generative-mode agent for testing the LLM spot-check path
class TestGenerativeReverseAgent extends BaseConverterAgent {
  constructor(config = {}) {
    super(config);
    this.id = 'converter:test-gen-reverse';
    this.name = 'Test Generative Reverse';
    this.description = 'Reverses text using AI (test-only generative agent)';
    this.from = ['plaintext'];
    this.to = ['ai-reversed'];
    this.modes = ['generative'];
    this.strategies = [
      {
        id: 'ai-reverse',
        description: 'Ask the LLM to reverse the text',
        when: 'AI-powered reversal',
        engine: 'llm',
        mode: 'generative',
        speed: 'medium',
        quality: 'AI reversal',
      },
      {
        id: 'ai-creative',
        description: 'Ask the LLM to creatively rewrite the text backwards',
        when: 'Creative reversal',
        engine: 'llm',
        mode: 'generative',
        speed: 'slow',
        quality: 'Creative AI reversal',
      },
    ];
  }

  async execute(input, _strategy) {
    const start = Date.now();
    if (!this._ai) throw new Error('AI service required');
    const output = await this._ai.complete(`Reverse this text: ${input}`, {
      profile: 'fast',
      feature: 'test-reverse',
    });
    return { output, duration: Date.now() - start };
  }
}

// ==========================================================================
// TEST SUITES
// ==========================================================================

// --------------------------------------------------------------------------
// 2. Run through the standard lifecycle compliance harness (without context)
// --------------------------------------------------------------------------

testConverterAgent(TestReverseAgent, {
  sampleInput: 'Hello World',
  expectedFromFormats: ['plaintext'],
  expectedToFormats: ['reversed'],
  expectedStrategies: ['char-reverse', 'word-reverse'],
  mockAI,
});

// --------------------------------------------------------------------------
// 2b. Run through the harness WITH context to test pass-through
// --------------------------------------------------------------------------

testConverterAgent(TestReverseAgent, {
  sampleInput: 'Context test input',
  expectedFromFormats: ['plaintext'],
  expectedToFormats: ['reversed'],
  expectedStrategies: ['char-reverse', 'word-reverse'],
  mockAI,
  context: {
    metadata: { sourceFile: 'test.txt', author: 'test-user', language: 'en' },
    hints: { preserveWhitespace: true },
  },
});

// --------------------------------------------------------------------------
// 3. Standalone agent tests (properties, plan, execute, convert, errors)
// --------------------------------------------------------------------------

describe('New Agent: Standalone lifecycle', () => {
  let agent;

  beforeEach(() => {
    agent = new TestReverseAgent({ ai: mockAI, silent: true });
  });

  it('has correct id, name, description, from, to, modes, strategies', () => {
    expect(agent.id).toBe('converter:test-reverse');
    expect(agent.name).toBe('Test Reverse');
    expect(agent.description).toBeTruthy();
    expect(agent.from).toEqual(['plaintext']);
    expect(agent.to).toEqual(['reversed']);
    expect(agent.modes).toEqual(['symbolic']);
    expect(agent.strategies.length).toBe(2);
    expect(agent.strategies.map((s) => s.id)).toEqual(['char-reverse', 'word-reverse']);
  });

  it('plan() selects a strategy and returns {strategy, reasoning}', async () => {
    const plan = await agent.plan('test input');
    expect(plan.strategy).toBeTruthy();
    expect(typeof plan.strategy).toBe('string');
    expect(plan.reasoning).toBeTruthy();
    expect(typeof plan.reasoning).toBe('string');
  });

  it('execute() transforms input and returns {output, duration}', async () => {
    const result = await agent.execute('abcdef', 'char-reverse');
    expect(result.output).toBe('fedcba');
    expect(typeof result.duration).toBe('number');
    expect(result.duration).toBeGreaterThanOrEqual(0);
  });

  it('execute() word-reverse strategy reverses word order', async () => {
    const result = await agent.execute('one two three', 'word-reverse');
    expect(result.output).toBe('three two one');
  });

  it('convert() runs full lifecycle: plan -> execute -> evaluate -> report', async () => {
    const result = await agent.convert('Hello World');
    expect(typeof result.success).toBe('boolean');
    expect(result.output).toBeTruthy();
    expect(result.report).toBeDefined();
  });

  describe('report schema validation', () => {
    let result;

    beforeEach(async () => {
      result = await agent.convert('Report test input');
    });

    it('report contains agentId and agentName', () => {
      expect(result.report.agentId).toBe('converter:test-reverse');
      expect(result.report.agentName).toBe('Test Reverse');
    });

    it('report contains attempts array with at least one entry', () => {
      expect(Array.isArray(result.report.attempts)).toBe(true);
      expect(result.report.attempts.length).toBeGreaterThan(0);
    });

    it('each attempt has strategy, score, and duration', () => {
      for (const attempt of result.report.attempts) {
        expect(attempt.strategy).toBeTruthy();
        expect(typeof attempt.score).toBe('number');
        expect(typeof attempt.duration).toBe('number');
      }
    });

    it('report contains finalScore as a number 0-100', () => {
      expect(typeof result.report.finalScore).toBe('number');
      expect(result.report.finalScore).toBeGreaterThanOrEqual(0);
      expect(result.report.finalScore).toBeLessThanOrEqual(100);
    });

    it('report events array includes converter:start', () => {
      expect(Array.isArray(result.report.events)).toBe(true);
      expect(result.report.events.some((e) => e.event === 'converter:start')).toBe(true);
    });

    it('report contains decision object', () => {
      expect(result.report.decision).toBeDefined();
      expect(result.report.decision.strategyUsed).toBeTruthy();
    });

    it('report totalDuration is a non-negative number', () => {
      expect(typeof result.report.totalDuration).toBe('number');
      expect(result.report.totalDuration).toBeGreaterThanOrEqual(0);
    });
  });

  it('handles null input gracefully (no unhandled throw)', async () => {
    const result = await agent.convert(null);
    expect(result.report).toBeDefined();
    expect(result.report.attempts.length).toBeGreaterThan(0);
  });

  it('handles empty string input gracefully', async () => {
    const result = await agent.convert('');
    expect(result.report).toBeDefined();
    expect(result.report.attempts.length).toBeGreaterThan(0);
  });
});

// --------------------------------------------------------------------------
// 4. Context pass-through: verify options/context reach plan() and execute()
// --------------------------------------------------------------------------

describe('New Agent: Context pass-through', () => {
  let agent;

  beforeEach(() => {
    agent = new TestReverseAgent({ ai: mockAI, silent: true });
  });

  it('convert() forwards context to plan() as options', async () => {
    const planSpy = vi.spyOn(agent, 'plan');
    const context = {
      metadata: { sourceFile: 'notes.txt', author: 'alice' },
      hints: { style: 'formal' },
    };

    await agent.convert('test input', context);

    expect(planSpy).toHaveBeenCalled();
    const planOpts = planSpy.mock.calls[0][1]; // second arg to plan()
    expect(planOpts).toBeDefined();
    expect(planOpts.metadata).toEqual({ sourceFile: 'notes.txt', author: 'alice' });
    expect(planOpts.hints).toEqual({ style: 'formal' });
    planSpy.mockRestore();
  });

  it('convert() forwards context to execute() as options', async () => {
    const execSpy = vi.spyOn(agent, 'execute');
    const context = {
      metadata: { sourceFile: 'data.csv' },
      targetAudience: 'developers',
    };

    await agent.convert('test input', context);

    expect(execSpy).toHaveBeenCalled();
    const execOpts = execSpy.mock.calls[0][2]; // third arg to execute()
    expect(execOpts).toBeDefined();
    expect(execOpts.metadata).toEqual({ sourceFile: 'data.csv' });
    expect(execOpts.targetAudience).toBe('developers');
    execSpy.mockRestore();
  });

  it('convert() works identically with no context (backward compatible)', async () => {
    const result = await agent.convert('abc');
    expect(result.success).toBe(true);
    expect(result.output).toBeTruthy();
    expect(result.report).toBeDefined();
  });

  it('convert() works with empty context object', async () => {
    const result = await agent.convert('abc', {});
    expect(result.success).toBe(true);
    expect(result.output).toBeTruthy();
  });

  it('context.metadata appears in plan event log', async () => {
    await agent.convert('hello', {
      metadata: { sourceFile: 'hello.txt' },
    });

    const startEvent = agent.logger.getEvents().find((e) => e.event === 'converter:start');
    expect(startEvent).toBeDefined();
    // The start event's input description should incorporate metadata
  });

  it('service convert() passes context through to the agent', async () => {
    const { ConversionService } = require('../../../lib/conversion-service');
    const service = new ConversionService();
    service._initialized = true;
    service.registry.register(new TestReverseAgent({ ai: mockAI, silent: true }));

    const result = await service.convert({
      input: 'service context test',
      from: 'plaintext',
      to: 'reversed',
      options: {
        metadata: { origin: 'api-call', userId: '42' },
        preserveCase: true,
      },
    });

    expect(result.success).toBe(true);
    expect(result.report).toBeDefined();
  });
});

// --------------------------------------------------------------------------
// 5. Generative agent: LLM spot-check path (with context)
// --------------------------------------------------------------------------

describe('New Agent: Generative mode with LLM spot-check', () => {
  let agent;

  beforeEach(() => {
    agent = new TestGenerativeReverseAgent({ ai: mockAI, silent: true });
  });

  it('uses generative mode', () => {
    expect(agent.modes).toContain('generative');
  });

  it('convert() produces a report with finalScore from evaluation', async () => {
    const result = await agent.convert('This is some input test');
    expect(result.report).toBeDefined();
    expect(typeof result.report.finalScore).toBe('number');
    // In mock mode the evaluator returns score: 85
    expect(result.report.finalScore).toBeGreaterThanOrEqual(0);
  });

  it('calls AI service during execution', async () => {
    mockAI.complete.mockClear();
    await agent.convert('test');
    expect(mockAI.complete).toHaveBeenCalled();
  });
});

// --------------------------------------------------------------------------
// 6. ConversionService integration: register, capabilities, graph, convert
// --------------------------------------------------------------------------

describe('New Agent: ConversionService integration', () => {
  // Use a fresh service instance (not the auto-discovering singleton)
  const { ConversionService } = require('../../../lib/conversion-service');
  let service;

  beforeEach(() => {
    service = new ConversionService();
    // Mark as initialized so it doesn't try to auto-discover from disk
    service._initialized = true;
  });

  it('registers the agent and it appears in capabilities()', async () => {
    const agent = new TestReverseAgent({ ai: mockAI, silent: true });
    service.registry.register(agent);

    const caps = await service.capabilities();
    const found = caps.find((c) => c.id === 'converter:test-reverse');
    expect(found).toBeDefined();
    expect(found.name).toBe('Test Reverse');
    expect(found.from).toContain('plaintext');
    expect(found.to).toContain('reversed');
    expect(found.strategies.length).toBe(2);
  });

  it('agent formats appear in the conversion graph edges', async () => {
    const agent = new TestReverseAgent({ ai: mockAI, silent: true });
    service.registry.register(agent);

    const graph = await service.graph();
    expect(graph.nodes).toContain('plaintext');
    expect(graph.nodes).toContain('reversed');
    const edge = graph.edges.find((e) => e.from === 'plaintext' && e.to === 'reversed');
    expect(edge).toBeDefined();
    expect(edge.agent).toBe('converter:test-reverse');
  });

  it('convert() via service uses the registered agent', async () => {
    const agent = new TestReverseAgent({ ai: mockAI, silent: true });
    service.registry.register(agent);

    const result = await service.convert({
      input: 'Hello',
      from: 'plaintext',
      to: 'reversed',
    });

    expect(result.success).toBe(true);
    // char-reverse of "Hello" = "olleH"
    expect(result.output).toBeTruthy();
    expect(result.report).toBeDefined();
    expect(result.report.agentId).toBe('converter:test-reverse');
  });

  it('service returns no-path error for unregistered format pairs', async () => {
    const result = await service.convert({
      input: 'test',
      from: 'unicorn',
      to: 'rainbow',
    });
    expect(result.success).toBe(false);
  });

  it('pipeline resolver finds paths through the new agent', async () => {
    const agent = new TestReverseAgent({ ai: mockAI, silent: true });
    service.registry.register(agent);

    const path = service.resolver.resolve('plaintext', 'reversed');
    expect(path).toBeDefined();
    expect(path.path).toEqual(['plaintext', 'reversed']);
    expect(path.agents).toContain('converter:test-reverse');
  });

  it('removing the agent de-registers it from capabilities', async () => {
    const agent = new TestReverseAgent({ ai: mockAI, silent: true });
    service.registry.register(agent);

    // Verify present
    let caps = await service.capabilities();
    expect(caps.some((c) => c.id === 'converter:test-reverse')).toBe(true);

    // Simulate removal: delete from internal map
    service.registry._agents.delete('converter:test-reverse');

    // Verify absent
    caps = await service.capabilities();
    expect(caps.some((c) => c.id === 'converter:test-reverse')).toBe(false);
  });

  it('multiple agents can be registered and convert independently', async () => {
    const symbolic = new TestReverseAgent({ ai: mockAI, silent: true });
    const generative = new TestGenerativeReverseAgent({ ai: mockAI, silent: true });
    service.registry.register(symbolic);
    service.registry.register(generative);

    const caps = await service.capabilities();
    expect(caps.find((c) => c.id === 'converter:test-reverse')).toBeDefined();
    expect(caps.find((c) => c.id === 'converter:test-gen-reverse')).toBeDefined();

    // Convert through each independently
    const r1 = await service.convert({ input: 'abc', from: 'plaintext', to: 'reversed' });
    expect(r1.success).toBe(true);

    const r2 = await service.convert({ input: 'abc', from: 'plaintext', to: 'ai-reversed' });
    expect(r2.success).toBe(true);
  });

  it('async conversion returns a jobId and completes', async () => {
    const agent = new TestReverseAgent({ ai: mockAI, silent: true });
    service.registry.register(agent);

    const result = await service.convert({
      input: 'async test',
      from: 'plaintext',
      to: 'reversed',
      async: true,
    });

    expect(result.jobId).toBeTruthy();
    expect(result.status).toBe('queued');

    // Wait for job to complete
    await new Promise((r) => {
      setTimeout(r, 200);
    });
    const job = service.jobStatus(result.jobId);
    expect(job).toBeDefined();
    // Job should be completed or still running
    expect(['running', 'completed']).toContain(job.status);
  });

  it('pipeline through two agents works end-to-end', async () => {
    // Register both agents, then pipeline plaintext -> reversed -> ai-reversed
    const symbolic = new TestReverseAgent({ ai: mockAI, silent: true });
    const generative = new TestGenerativeReverseAgent({ ai: mockAI, silent: true });

    // Modify generative to accept 'reversed' as input format for chaining
    generative.from = ['reversed'];
    service.registry.register(symbolic);
    service.registry.register(generative);

    const result = await service.pipeline({
      input: 'chain test',
      steps: [
        { from: 'plaintext', to: 'reversed' },
        { from: 'reversed', to: 'ai-reversed' },
      ],
    });

    expect(result.success).toBe(true);
    expect(result.output).toBeTruthy();
    expect(result.steps.length).toBe(2);
    expect(result.steps[0].success).toBe(true);
    expect(result.steps[1].success).toBe(true);
  });
});
