/**
 * Unit tests for Distributed Bidding System
 *
 * Tests the Exchange auction mechanism where:
 * 1. Tasks are submitted to Exchange
 * 2. Each agent independently evaluates and bids
 * 3. Exchange collects bids and picks winner
 * 4. Winner executes the task
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Import mocks using CommonJS require (converted to ES modules by vitest)
const { MockExchange } = require('../mocks/mock-exchange.js');
const {
  createMockAgent,
  createHighConfidenceAgent,
  createLowConfidenceAgent,
  createNonBiddingAgent,
  createFailingAgent,
  createKeywordAgent,
} = require('../mocks/mock-agent.js');

describe('Distributed Bidding System', () => {
  let exchange;

  beforeEach(() => {
    exchange = new MockExchange({ auctionDelayMs: 5, executionDelayMs: 5 });
    exchange.start();
  });

  afterEach(() => {
    exchange.shutdown();
    exchange.reset();
  });

  describe('Exchange Lifecycle', () => {
    it('should start and stop exchange', async () => {
      const newExchange = new MockExchange();
      expect(newExchange.isRunning).toBe(false);

      await newExchange.start();
      expect(newExchange.isRunning).toBe(true);

      await newExchange.shutdown();
      expect(newExchange.isRunning).toBe(false);
    });

    it('should reject submissions when not running', async () => {
      const stoppedExchange = new MockExchange();

      await expect(stoppedExchange.submit({ content: 'test' })).rejects.toThrow('Exchange is not running');
    });
  });

  describe('Agent Registration', () => {
    it('should register agent with exchange', () => {
      const agent = createMockAgent('test-agent', { keywords: ['test'] });

      exchange.registerAgent(agent.id, {
        bidFn: (task) => agent.bid(task),
        executeFn: (task) => agent.execute(task),
      });

      expect(exchange.agents.getCount()).toBe(1);
      expect(exchange.registeredAgents.has('test-agent')).toBe(true);
    });

    it('should emit agent:connected event on registration', () => {
      const handler = vi.fn();
      exchange.on('agent:connected', handler);

      const agent = createMockAgent('new-agent');
      exchange.registerAgent(agent.id, {
        bidFn: (task) => agent.bid(task),
      });

      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ agent: { id: 'new-agent', name: 'new-agent' } }));
    });

    it('should unregister agent', () => {
      const agent = createMockAgent('temp-agent');
      exchange.registerAgent(agent.id, { bidFn: () => null });
      expect(exchange.agents.getCount()).toBe(1);

      exchange.unregisterAgent(agent.id);
      expect(exchange.agents.getCount()).toBe(0);
    });
  });

  describe('Bidding', () => {
    it('should select highest confidence bidder as winner', async () => {
      const lowAgent = createLowConfidenceAgent('low-agent');
      const highAgent = createHighConfidenceAgent('high-agent');

      exchange.registerAgent('low-agent', {
        bidFn: (t) => lowAgent.bid(t),
        executeFn: (t) => lowAgent.execute(t),
      });
      exchange.registerAgent('high-agent', {
        bidFn: (t) => highAgent.bid(t),
        executeFn: (t) => highAgent.execute(t),
      });

      const assignedHandler = vi.fn();
      exchange.on('task:assigned', assignedHandler);

      await exchange.submit({ content: 'test task' });
      await new Promise((r) => {
        setTimeout(r, 50);
      });

      expect(assignedHandler).toHaveBeenCalled();
      const { winner } = assignedHandler.mock.calls[0][0];
      expect(winner.agentId).toBe('high-agent');
      expect(winner.confidence).toBe(0.9);
    });

    it('should handle no bids gracefully with exchange:halt', async () => {
      const shyAgent = createNonBiddingAgent('shy-agent');
      exchange.registerAgent('shy-agent', {
        bidFn: (t) => shyAgent.bid(t),
      });

      const haltHandler = vi.fn();
      exchange.on('exchange:halt', haltHandler);

      await exchange.submit({ content: 'test task' });
      await new Promise((r) => {
        setTimeout(r, 50);
      });

      expect(haltHandler).toHaveBeenCalled();
      expect(haltHandler.mock.calls[0][0].reason).toBe('No bids received');
    });

    it('should support keyword-based bidding', async () => {
      const weatherAgent = createKeywordAgent('weather-agent', ['weather', 'temperature']);
      const timeAgent = createKeywordAgent('time-agent', ['time', 'clock']);

      exchange.registerAgent('weather-agent', {
        bidFn: (t) => weatherAgent.bid(t),
        executeFn: (t) => weatherAgent.execute(t),
      });
      exchange.registerAgent('time-agent', {
        bidFn: (t) => timeAgent.bid(t),
        executeFn: (t) => timeAgent.execute(t),
      });

      const assignedHandler = vi.fn();
      exchange.on('task:assigned', assignedHandler);

      // Weather query should go to weather agent
      await exchange.submit({ content: 'what is the weather today' });
      await new Promise((r) => {
        setTimeout(r, 50);
      });

      expect(assignedHandler).toHaveBeenCalled();
      expect(assignedHandler.mock.calls[0][0].winner.agentId).toBe('weather-agent');
    });

    it('should provide backup agents when multiple bid', async () => {
      const primary = createMockAgent('primary', { bidConfidence: 0.9 });
      const backup1 = createMockAgent('backup1', { bidConfidence: 0.7 });
      const backup2 = createMockAgent('backup2', { bidConfidence: 0.5 });

      exchange.registerAgent('primary', { bidFn: (t) => primary.bid(t) });
      exchange.registerAgent('backup1', { bidFn: (t) => backup1.bid(t) });
      exchange.registerAgent('backup2', { bidFn: (t) => backup2.bid(t) });

      const assignedHandler = vi.fn();
      exchange.on('task:assigned', assignedHandler);

      await exchange.submit({ content: 'test' });
      await new Promise((r) => {
        setTimeout(r, 50);
      });

      expect(assignedHandler).toHaveBeenCalled();
      const { winner, backups } = assignedHandler.mock.calls[0][0];

      expect(winner.agentId).toBe('primary');
      expect(backups).toHaveLength(2);
      expect(backups[0].agentId).toBe('backup1');
      expect(backups[1].agentId).toBe('backup2');
    });
  });

  describe('Execution', () => {
    it('should execute winning agent and emit task:settled', async () => {
      const agent = createMockAgent('worker', {
        bidConfidence: 0.8,
        successMessage: 'Task completed!',
      });

      exchange.registerAgent('worker', {
        bidFn: (t) => agent.bid(t),
        executeFn: (t) => agent.execute(t),
      });

      const settledHandler = vi.fn();
      exchange.on('task:settled', settledHandler);

      await exchange.submit({ content: 'do something' });
      await new Promise((r) => {
        setTimeout(r, 100);
      });

      expect(settledHandler).toHaveBeenCalled();
      const { result, agentId } = settledHandler.mock.calls[0][0];

      expect(result.success).toBe(true);
      expect(result.output).toBe('Task completed!');
      expect(agentId).toBe('worker');
    });

    it('should handle execution failure with task:dead_letter', async () => {
      const brokenAgent = createFailingAgent('broken', {
        errorMessage: 'Something went wrong',
      });

      exchange.registerAgent('broken', {
        bidFn: (t) => brokenAgent.bid(t),
        executeFn: (t) => brokenAgent.execute(t),
      });

      const deadLetterHandler = vi.fn();
      exchange.on('task:dead_letter', deadLetterHandler);

      await exchange.submit({ content: 'do something' });
      await new Promise((r) => {
        setTimeout(r, 100);
      });

      expect(deadLetterHandler).toHaveBeenCalled();
      expect(deadLetterHandler.mock.calls[0][0].reason).toBe('Something went wrong');
    });

    it('should emit task:executing before execution', async () => {
      const agent = createHighConfidenceAgent('executor');

      exchange.registerAgent('executor', {
        bidFn: (t) => agent.bid(t),
        executeFn: (t) => agent.execute(t),
      });

      const events = [];
      exchange.on('task:assigned', () => events.push('assigned'));
      exchange.on('task:executing', () => events.push('executing'));
      exchange.on('task:settled', () => events.push('settled'));

      await exchange.submit({ content: 'test' });
      await new Promise((r) => {
        setTimeout(r, 100);
      });

      expect(events).toEqual(['assigned', 'executing', 'settled']);
    });
  });

  describe('Task Lifecycle Events', () => {
    it('should emit task:queued on submission', async () => {
      const queuedHandler = vi.fn();
      exchange.on('task:queued', queuedHandler);

      await exchange.submit({ content: 'test task' });

      expect(queuedHandler).toHaveBeenCalled();
      expect(queuedHandler.mock.calls[0][0].task.content).toBe('test task');
    });

    it('should emit auction:started when auction begins', async () => {
      const agent = createHighConfidenceAgent('bidder');
      exchange.registerAgent('bidder', { bidFn: (t) => agent.bid(t) });

      const auctionHandler = vi.fn();
      exchange.on('auction:started', auctionHandler);

      await exchange.submit({ content: 'test' });
      await new Promise((r) => {
        setTimeout(r, 50);
      });

      expect(auctionHandler).toHaveBeenCalled();
    });

    it('should support task cancellation', async () => {
      // Register a slow agent
      exchange.registerAgent('slow', {
        bidFn: () => ({ confidence: 0.9 }),
        executeFn: async () => {
          await new Promise((r) => {
            setTimeout(r, 1000);
          });
          return { success: true };
        },
      });

      const cancelHandler = vi.fn();
      exchange.on('task:cancelled', cancelHandler);

      const { taskId } = await exchange.submit({ content: 'test' });

      // Cancel before execution completes
      const cancelled = exchange.cancelTask(taskId);

      expect(cancelled).toBe(true);
      expect(cancelHandler).toHaveBeenCalled();
    });
  });

  describe('Circuit Breaker Behavior', () => {
    it('should track submitted tasks for debugging', async () => {
      const agent = createHighConfidenceAgent('tracker');
      exchange.registerAgent('tracker', {
        bidFn: (t) => agent.bid(t),
        executeFn: (t) => agent.execute(t),
      });

      await exchange.submit({ content: 'task 1' });
      await exchange.submit({ content: 'task 2' });
      await exchange.submit({ content: 'task 3' });

      expect(exchange.submittedTasks).toHaveLength(3);
    });

    it('should reset state for test isolation', async () => {
      const agent = createHighConfidenceAgent('temp');
      exchange.registerAgent('temp', { bidFn: (t) => agent.bid(t) });

      await exchange.submit({ content: 'task' });
      expect(exchange.submittedTasks).toHaveLength(1);
      expect(exchange.agents.getCount()).toBe(1);

      exchange.reset();

      expect(exchange.submittedTasks).toHaveLength(0);
      expect(exchange.agents.getCount()).toBe(0);
    });
  });

  describe('Agent Mock Behaviors', () => {
    it('createMockAgent with custom bid function', async () => {
      const customAgent = createMockAgent('custom', {
        customBidFn: (task) => {
          if (task.content.includes('special')) {
            return { confidence: 0.99, plan: 'Special handling' };
          }
          return null;
        },
      });

      expect(customAgent.bid({ content: 'normal task' })).toBeNull();
      expect(customAgent.bid({ content: 'special task' })).toEqual({
        confidence: 0.99,
        plan: 'Special handling',
      });
    });

    it('createMockAgent with custom execute function', async () => {
      const customAgent = createMockAgent('custom', {
        bidConfidence: 0.8,
        customExecuteFn: async (task) => ({
          success: true,
          message: `Processed: ${task.content.toUpperCase()}`,
        }),
      });

      const result = await customAgent.execute({ content: 'hello' });
      expect(result.message).toBe('Processed: HELLO');
    });

    it('createKeywordAgent matches multiple keywords', () => {
      const multiAgent = createKeywordAgent('multi', ['alpha', 'beta', 'gamma']);

      // No match
      expect(multiAgent.bid({ content: 'delta task' })).toBeNull();

      // Single match
      const singleBid = multiAgent.bid({ content: 'alpha task' });
      expect(singleBid.confidence).toBe(0.6); // 0.5 + 0.1

      // Multiple matches
      const multiBid = multiAgent.bid({ content: 'alpha and beta task' });
      expect(multiBid.confidence).toBe(0.7); // 0.5 + 0.2
    });
  });
});
