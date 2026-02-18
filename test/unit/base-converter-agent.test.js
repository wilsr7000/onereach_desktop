import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockAIService } from '../mocks/conversion-mocks.js';

vi.mock('../../lib/ai-service', () => ({ default: null }));

const { BaseConverterAgent, ConverterEventLogger } = require('../../lib/converters/base-converter-agent');

describe('BaseConverterAgent', () => {
  let mockAI;

  beforeEach(() => {
    mockAI = createMockAIService();
  });

  describe('constructor', () => {
    it('sets default identity properties', () => {
      const agent = new BaseConverterAgent();
      expect(agent.id).toBe('converter:base');
      expect(agent.name).toBe('Base Converter');
      expect(agent.maxAttempts).toBe(3);
      expect(agent.minPassScore).toBe(60);
    });

    it('accepts custom config', () => {
      const agent = new BaseConverterAgent({ maxAttempts: 5, minPassScore: 80, ai: mockAI });
      expect(agent.maxAttempts).toBe(5);
      expect(agent.minPassScore).toBe(80);
    });
  });

  describe('logger', () => {
    it('creates logger lazily', () => {
      const agent = new BaseConverterAgent({ silent: true });
      expect(agent._logger).toBeNull();
      const logger = agent.logger;
      expect(logger).toBeInstanceOf(ConverterEventLogger);
    });

    it('collects events', () => {
      const agent = new BaseConverterAgent({ silent: true });
      agent.logger.start('test-id', 'test input');
      agent.logger.log('test:event', { data: 'test' });
      const events = agent.logger.getEvents();
      expect(events.length).toBe(2);
      expect(events[0].event).toBe('converter:start');
      expect(events[1].event).toBe('test:event');
    });

    it('emits events for external listeners', async () => {
      const agent = new BaseConverterAgent({ silent: true });
      const received = [];
      agent.logger.on('converter:event', (e) => received.push(e));
      agent.logger.log('custom:event', { hello: 'world' });
      expect(received.length).toBe(1);
      expect(received[0].hello).toBe('world');
    });
  });

  describe('plan()', () => {
    it('returns only strategy when single strategy available', async () => {
      const agent = new BaseConverterAgent({ ai: mockAI, silent: true });
      agent.strategies = [{ id: 'only', description: 'Only one', when: 'always', speed: 'fast', quality: 'good' }];
      const plan = await agent.plan('test input');
      expect(plan.strategy).toBe('only');
    });

    it('uses LLM for multi-strategy selection', async () => {
      mockAI.json.mockResolvedValueOnce({ strategy: 'second', reasoning: 'Better for this input' });
      const agent = new BaseConverterAgent({ ai: mockAI, silent: true });
      agent.strategies = [
        { id: 'first', description: 'First', when: 'sometimes', speed: 'fast', quality: 'ok' },
        { id: 'second', description: 'Second', when: 'usually', speed: 'slow', quality: 'great' },
      ];
      const plan = await agent.plan('test input');
      expect(plan.strategy).toBe('second');
    });

    it('excludes failed strategies on retry', async () => {
      mockAI.json.mockResolvedValueOnce({ strategy: 'backup', reasoning: 'Primary failed' });
      const agent = new BaseConverterAgent({ ai: mockAI, silent: true });
      agent.strategies = [
        { id: 'primary', description: 'Primary', when: 'default', speed: 'fast', quality: 'ok' },
        { id: 'backup', description: 'Backup', when: 'fallback', speed: 'slow', quality: 'great' },
      ];
      const plan = await agent.plan('test', {
        previousAttempts: [{ strategy: 'primary', score: 20 }],
      });
      expect(plan.strategy).toBe('backup');
    });

    it('falls back to default when LLM fails', async () => {
      mockAI.json.mockRejectedValueOnce(new Error('API down'));
      const agent = new BaseConverterAgent({ ai: mockAI, silent: true });
      agent.strategies = [
        { id: 'alpha', description: 'A', when: 'default', speed: 'fast', quality: 'ok' },
        { id: 'beta', description: 'B', when: 'fallback', speed: 'slow', quality: 'ok' },
      ];
      const plan = await agent.plan('test');
      expect(plan.strategy).toBe('alpha');
    });
  });

  describe('evaluate()', () => {
    it('fails on null output', async () => {
      const agent = new BaseConverterAgent({ silent: true });
      const result = await agent.evaluate('input', null, 'test');
      expect(result.pass).toBe(false);
      expect(result.score).toBe(0);
      expect(result.issues[0].code).toBe('OUTPUT_NULL');
    });

    it('fails on empty string output', async () => {
      const agent = new BaseConverterAgent({ silent: true });
      const result = await agent.evaluate('input', '', 'test');
      expect(result.pass).toBe(false);
      expect(result.issues[0].code).toBe('OUTPUT_EMPTY');
    });

    it('fails on empty buffer output', async () => {
      const agent = new BaseConverterAgent({ silent: true });
      const result = await agent.evaluate('input', Buffer.alloc(0), 'test');
      expect(result.pass).toBe(false);
      expect(result.issues[0].code).toBe('OUTPUT_EMPTY_BUFFER');
    });

    it('passes on valid string output', async () => {
      const agent = new BaseConverterAgent({ silent: true });
      const result = await agent.evaluate('input', 'valid output', 'test');
      expect(result.pass).toBe(true);
      expect(result.score).toBeGreaterThanOrEqual(60);
    });

    it('passes on valid buffer output', async () => {
      const agent = new BaseConverterAgent({ silent: true });
      const result = await agent.evaluate('input', Buffer.from('data'), 'test');
      expect(result.pass).toBe(true);
    });
  });

  describe('convert()', () => {
    it('succeeds on first attempt', async () => {
      const agent = new BaseConverterAgent({ ai: mockAI, silent: true });
      agent.strategies = [{ id: 'test', description: 'Test', when: 'always', speed: 'fast', quality: 'ok' }];
      agent.execute = vi.fn().mockResolvedValue({ output: 'converted data', metadata: { format: 'text' } });

      const result = await agent.convert('input');
      expect(result.success).toBe(true);
      expect(result.output).toBe('converted data');
      expect(result.report).toBeDefined();
      expect(result.report.attempts.length).toBe(1);
      expect(result.report.events).toBeDefined();
      expect(Array.isArray(result.report.events)).toBe(true);
    });

    it('retries on execution error', async () => {
      const agent = new BaseConverterAgent({ ai: mockAI, silent: true, maxAttempts: 2 });
      agent.strategies = [
        { id: 'a', description: 'A', when: 'first', speed: 'fast', quality: 'ok' },
        { id: 'b', description: 'B', when: 'fallback', speed: 'slow', quality: 'ok' },
      ];
      agent.execute = vi
        .fn()
        .mockRejectedValueOnce(new Error('Boom'))
        .mockResolvedValueOnce({ output: 'recovered', metadata: {} });

      const result = await agent.convert('input');
      expect(result.report.attempts.length).toBe(2);
    });

    it('includes events in report on failure', async () => {
      const agent = new BaseConverterAgent({ ai: mockAI, silent: true, maxAttempts: 1 });
      agent.strategies = [{ id: 'fail', description: 'Fail', when: 'always', speed: 'fast', quality: 'ok' }];
      agent.execute = vi.fn().mockResolvedValue({ output: null });

      const result = await agent.convert('input');
      expect(result.success).toBe(false);
      expect(result.report.events).toBeDefined();
      expect(result.diagnosis).toBeDefined();
    });

    it('reports progress callback', async () => {
      const agent = new BaseConverterAgent({ ai: mockAI, silent: true });
      agent.strategies = [{ id: 'test', description: 'Test', when: 'always', speed: 'fast', quality: 'ok' }];
      agent.execute = vi.fn().mockResolvedValue({ output: 'done' });

      const progress = [];
      await agent.convert('input', { onProgress: (phase, attempt, max) => progress.push({ phase, attempt, max }) });
      expect(progress).toContainEqual({ phase: 'planning', attempt: 1, max: 3 });
      expect(progress).toContainEqual({ phase: 'executing', attempt: 1, max: 3 });
      expect(progress).toContainEqual({ phase: 'evaluating', attempt: 1, max: 3 });
    });
  });

  describe('_describeInput()', () => {
    it('describes string input', () => {
      const agent = new BaseConverterAgent();
      const desc = agent._describeInput('hello world');
      expect(desc).toContain('Text input');
      expect(desc).toContain('11 characters');
    });

    it('describes buffer input', () => {
      const agent = new BaseConverterAgent();
      const desc = agent._describeInput(Buffer.from('test'));
      expect(desc).toContain('Binary buffer');
      expect(desc).toContain('4 bytes');
    });
  });
});

describe('ConverterEventLogger', () => {
  it('tracks events with timestamps', () => {
    const logger = new ConverterEventLogger('test:agent', 'Test Agent');
    // Suppress console in test
    const orig = console.log;
    console.log = vi.fn();
    logger.start('conv-123', 'test input');
    logger.log('test:mid', { data: 'middle' });
    logger.log('test:end', { data: 'end' });
    console.log = orig;

    const events = logger.getEvents();
    expect(events.length).toBe(3);
    expect(events[0].event).toBe('converter:start');
    expect(events[0].conversionId).toBe('conv-123');
    expect(events[1].event).toBe('test:mid');
    expect(events[2].event).toBe('test:end');
    // Elapsed should be non-negative
    events.forEach((e) => expect(e.elapsed).toBeGreaterThanOrEqual(0));
  });
});
