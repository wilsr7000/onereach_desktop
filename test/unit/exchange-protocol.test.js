/**
 * Agent Exchange WebSocket Protocol - Lifecycle Tests
 *
 * Lifecycle: connect -> register -> registered -> bid_request -> bid_response ->
 *            task_assignment -> task_ack -> task_heartbeat -> task_result -> disconnect
 *
 * Uses mock WebSocket to test the protocol message flow.
 *
 * Run:  npx vitest run test/unit/exchange-protocol.test.js
 */

import { describe, it, expect, beforeEach } from 'vitest';

// Simulate the exchange protocol message flow
class MockExchangeProtocol {
  constructor() {
    this.messages = [];
    this.registered = false;
    this.agentId = null;
  }

  // Client sends register
  register(agentId, categories, capabilities) {
    const msg = {
      type: 'register',
      agentId,
      agentVersion: '1.0.0',
      categories,
      capabilities: { keywords: capabilities, executionType: 'builtin' },
      protocolVersion: '1.0',
    };
    this.messages.push({ direction: 'client->server', ...msg });
    this.agentId = agentId;
    return msg;
  }

  // Server sends registered
  handleRegistered(config) {
    const msg = {
      type: 'registered',
      protocolVersion: '1.0',
      agentId: this.agentId,
      config: config || { heartbeatIntervalMs: 30000, defaultTimeoutMs: 60000 },
    };
    this.messages.push({ direction: 'server->client', ...msg });
    this.registered = true;
    return msg;
  }

  // Server sends bid_request
  sendBidRequest(auctionId, task) {
    const msg = {
      type: 'bid_request',
      auctionId,
      task: { id: task.id, content: task.content, metadata: task.metadata || {} },
    };
    this.messages.push({ direction: 'server->client', ...msg });
    return msg;
  }

  // Client sends bid_response
  sendBidResponse(auctionId, bid) {
    const msg = {
      type: 'bid_response',
      auctionId,
      agentId: this.agentId,
      agentVersion: '1.0.0',
      bid,
    };
    this.messages.push({ direction: 'client->server', ...msg });
    return msg;
  }

  // Server sends task_assignment
  sendTaskAssignment(taskId, task) {
    const msg = { type: 'task_assignment', taskId, task };
    this.messages.push({ direction: 'server->client', ...msg });
    return msg;
  }

  // Client sends task_ack
  sendTaskAck(taskId, estimatedMs) {
    const msg = { type: 'task_ack', taskId, agentId: this.agentId, estimatedMs };
    this.messages.push({ direction: 'client->server', ...msg });
    return msg;
  }

  // Client sends task_heartbeat
  sendTaskHeartbeat(taskId, progress) {
    const msg = { type: 'task_heartbeat', taskId, agentId: this.agentId, progress };
    this.messages.push({ direction: 'client->server', ...msg });
    return msg;
  }

  // Client sends task_result
  sendTaskResult(taskId, result) {
    const msg = { type: 'task_result', taskId, result };
    this.messages.push({ direction: 'client->server', ...msg });
    return msg;
  }

  // Heartbeat
  sendPing() {
    const msg = { type: 'ping', timestamp: Date.now() };
    this.messages.push({ direction: 'server->client', ...msg });
    return msg;
  }

  sendPong() {
    const msg = { type: 'pong', timestamp: Date.now() };
    this.messages.push({ direction: 'client->server', ...msg });
    return msg;
  }
}

// ═══════════════════════════════════════════════════════════════════
// FULL PROTOCOL LIFECYCLE
// ═══════════════════════════════════════════════════════════════════

describe('Agent Exchange Protocol - Full Lifecycle', () => {
  let protocol;

  beforeEach(() => {
    protocol = new MockExchangeProtocol();
  });

  it('Step 1: Client registers agent', () => {
    const msg = protocol.register('weather-agent', ['weather'], ['temperature', 'forecast']);
    expect(msg.type).toBe('register');
    expect(msg.agentId).toBe('weather-agent');
    expect(msg.protocolVersion).toBe('1.0');
  });

  it('Step 2: Server confirms registration', () => {
    protocol.register('weather-agent', ['weather'], []);
    const msg = protocol.handleRegistered();
    expect(msg.type).toBe('registered');
    expect(msg.agentId).toBe('weather-agent');
    expect(msg.config.heartbeatIntervalMs).toBeGreaterThan(0);
    expect(protocol.registered).toBe(true);
  });

  it('Step 3: Server sends bid request', () => {
    protocol.register('weather-agent', ['weather'], []);
    protocol.handleRegistered();
    const msg = protocol.sendBidRequest('auction-1', { id: 'task-1', content: 'What is the weather?' });
    expect(msg.type).toBe('bid_request');
    expect(msg.auctionId).toBe('auction-1');
    expect(msg.task.content).toBe('What is the weather?');
  });

  it('Step 4: Client sends bid response', () => {
    protocol.register('weather-agent', ['weather'], []);
    protocol.handleRegistered();
    protocol.sendBidRequest('auction-1', { id: 'task-1', content: 'Weather?' });
    const msg = protocol.sendBidResponse('auction-1', {
      confidence: 0.95,
      reasoning: 'Direct weather query',
      estimatedTimeMs: 2000,
      tier: 'builtin',
    });
    expect(msg.type).toBe('bid_response');
    expect(msg.bid.confidence).toBe(0.95);
  });

  it('Step 5: Server assigns task', () => {
    protocol.register('weather-agent', ['weather'], []);
    protocol.handleRegistered();
    const msg = protocol.sendTaskAssignment('task-1', { id: 'task-1', content: 'Weather?' });
    expect(msg.type).toBe('task_assignment');
    expect(msg.taskId).toBe('task-1');
  });

  it('Step 6: Client acknowledges task', () => {
    protocol.register('weather-agent', ['weather'], []);
    const msg = protocol.sendTaskAck('task-1', 2000);
    expect(msg.type).toBe('task_ack');
    expect(msg.estimatedMs).toBe(2000);
  });

  it('Step 7: Client sends heartbeat', () => {
    protocol.register('weather-agent', ['weather'], []);
    const msg = protocol.sendTaskHeartbeat('task-1', 'Fetching weather data...');
    expect(msg.type).toBe('task_heartbeat');
    expect(msg.progress).toBe('Fetching weather data...');
  });

  it('Step 8: Client sends task result', () => {
    protocol.register('weather-agent', ['weather'], []);
    const msg = protocol.sendTaskResult('task-1', {
      success: true,
      output: 'It is 72F and sunny in Seattle.',
      data: { temp: 72, condition: 'sunny' },
    });
    expect(msg.type).toBe('task_result');
    expect(msg.result.success).toBe(true);
    expect(msg.result.output).toContain('72F');
  });

  it('Step 9: Heartbeat ping/pong', () => {
    const ping = protocol.sendPing();
    expect(ping.type).toBe('ping');
    const pong = protocol.sendPong();
    expect(pong.type).toBe('pong');
  });

  it('Full lifecycle message count', () => {
    protocol.register('weather-agent', ['weather'], []);
    protocol.handleRegistered();
    protocol.sendBidRequest('a-1', { id: 't-1', content: 'Weather?' });
    protocol.sendBidResponse('a-1', { confidence: 0.9 });
    protocol.sendTaskAssignment('t-1', { id: 't-1' });
    protocol.sendTaskAck('t-1', 2000);
    protocol.sendTaskHeartbeat('t-1', 'Working...');
    protocol.sendTaskResult('t-1', { success: true, output: 'Done' });
    protocol.sendPing();
    protocol.sendPong();

    expect(protocol.messages.length).toBe(10);
    const clientMsgs = protocol.messages.filter((m) => m.direction === 'client->server');
    const serverMsgs = protocol.messages.filter((m) => m.direction === 'server->client');
    expect(clientMsgs.length).toBe(6);
    expect(serverMsgs.length).toBe(4);
  });
});

// ═══════════════════════════════════════════════════════════════════
// EDGE CASES
// ═══════════════════════════════════════════════════════════════════

describe('Agent Exchange Protocol - Edge Cases', () => {
  it('null bid means agent declines', () => {
    const protocol = new MockExchangeProtocol();
    protocol.register('time-agent', ['time'], []);
    const msg = protocol.sendBidResponse('auction-1', null);
    expect(msg.bid).toBeNull();
  });

  it('task_result can include needsInput', () => {
    const protocol = new MockExchangeProtocol();
    protocol.register('calendar-agent', ['calendar'], []);
    const msg = protocol.sendTaskResult('task-2', {
      success: true,
      needsInput: { prompt: 'Which date?', field: 'date', agentId: 'calendar-agent' },
    });
    expect(msg.result.needsInput).toBeDefined();
    expect(msg.result.needsInput.prompt).toBe('Which date?');
  });

  it('task_result can include error', () => {
    const protocol = new MockExchangeProtocol();
    protocol.register('broken-agent', ['test'], []);
    const msg = protocol.sendTaskResult('task-3', {
      success: false,
      error: 'Something went wrong',
    });
    expect(msg.result.success).toBe(false);
    expect(msg.result.error).toBe('Something went wrong');
  });
});
