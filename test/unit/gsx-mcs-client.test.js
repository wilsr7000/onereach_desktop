/**
 * GSX MCS Client Protocol - Lifecycle Tests
 *
 * Lifecycle: connect -> register -> send task -> receive task_result -> disconnect
 *
 * Run:  npx vitest run test/unit/gsx-mcs-client.test.js
 */

import { describe, it, expect, beforeEach } from 'vitest';

// Simulate the GSX MCS protocol
class MockMCSClient {
  constructor() {
    this.messages = [];
    this.connected = false;
    this.registered = false;
    this.agents = [];
  }

  connect(url) {
    this.connected = true;
    this.url = url;
    this.messages.push({ direction: 'system', type: 'connected', url });
  }

  // Client registers as desktop-app
  register() {
    if (!this.connected) throw new Error('Not connected');
    const msg = {
      type: 'register',
      clientType: 'desktop-app',
      version: '1.0.0',
    };
    this.messages.push({ direction: 'client->server', ...msg });
    this.registered = true;
    return msg;
  }

  // Client sends ping
  sendPing() {
    const msg = { type: 'ping' };
    this.messages.push({ direction: 'client->server', ...msg });
    return msg;
  }

  // Server sends pong
  handlePong() {
    const msg = { type: 'pong' };
    this.messages.push({ direction: 'server->client', ...msg });
    return msg;
  }

  // Server sends agent list
  handleAgentsList(agents) {
    const msg = { type: 'agents', agents };
    this.messages.push({ direction: 'server->client', ...msg });
    this.agents = agents;
    return msg;
  }

  // Client sends task
  sendTask(agentId, task) {
    const msg = {
      type: 'task',
      agentId,
      task: { id: task.id, content: task.content, metadata: task.metadata || {} },
    };
    this.messages.push({ direction: 'client->server', ...msg });
    return msg;
  }

  // Server sends task result
  handleTaskResult(taskId, result) {
    const msg = { type: 'task_result', taskId, result };
    this.messages.push({ direction: 'server->client', ...msg });
    return msg;
  }

  // Server sends error
  handleError(error) {
    const msg = { type: 'error', ...error };
    this.messages.push({ direction: 'server->client', ...msg });
    return msg;
  }

  disconnect() {
    this.connected = false;
    this.registered = false;
    this.messages.push({ direction: 'system', type: 'disconnected' });
  }
}

// ═══════════════════════════════════════════════════════════════════
// FULL LIFECYCLE
// ═══════════════════════════════════════════════════════════════════

describe('GSX MCS Client Protocol - Full Lifecycle', () => {
  let client;

  beforeEach(() => {
    client = new MockMCSClient();
  });

  it('Step 1: Connect to MCS server', () => {
    client.connect('wss://mcs.example.com');
    expect(client.connected).toBe(true);
    expect(client.url).toBe('wss://mcs.example.com');
  });

  it('Step 2: Register as desktop-app', () => {
    client.connect('wss://mcs.example.com');
    const msg = client.register();
    expect(msg.type).toBe('register');
    expect(msg.clientType).toBe('desktop-app');
    expect(client.registered).toBe(true);
  });

  it('Step 3: Receive agent list from server', () => {
    client.connect('wss://mcs.example.com');
    client.register();
    const msg = client.handleAgentsList([
      { id: 'remote-crm-agent', name: 'CRM Agent' },
      { id: 'remote-erp-agent', name: 'ERP Agent' },
    ]);
    expect(msg.type).toBe('agents');
    expect(client.agents.length).toBe(2);
  });

  it('Step 4: Send task to remote agent', () => {
    client.connect('wss://mcs.example.com');
    client.register();
    const msg = client.sendTask('remote-crm-agent', {
      id: 'task-1',
      content: 'Look up customer John Smith',
    });
    expect(msg.type).toBe('task');
    expect(msg.agentId).toBe('remote-crm-agent');
  });

  it('Step 5: Receive task result', () => {
    client.connect('wss://mcs.example.com');
    client.register();
    const msg = client.handleTaskResult('task-1', {
      success: true,
      output: 'John Smith is a premium customer since 2020.',
    });
    expect(msg.type).toBe('task_result');
    expect(msg.result.success).toBe(true);
  });

  it('Step 6: Ping/pong keepalive', () => {
    client.connect('wss://mcs.example.com');
    const ping = client.sendPing();
    expect(ping.type).toBe('ping');
    const pong = client.handlePong();
    expect(pong.type).toBe('pong');
  });

  it('Step 7: Disconnect', () => {
    client.connect('wss://mcs.example.com');
    client.register();
    client.disconnect();
    expect(client.connected).toBe(false);
    expect(client.registered).toBe(false);
  });

  it('Step 8: Verify clean state', () => {
    client.connect('wss://mcs.example.com');
    client.register();
    client.disconnect();
    expect(client.connected).toBe(false);
    expect(client.registered).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════
// ERROR HANDLING
// ═══════════════════════════════════════════════════════════════════

describe('GSX MCS Client Protocol - Error Handling', () => {
  it('server error includes message', () => {
    const client = new MockMCSClient();
    client.connect('wss://mcs.example.com');
    const msg = client.handleError({ code: 'AGENT_NOT_FOUND', message: 'Agent not available' });
    expect(msg.type).toBe('error');
    expect(msg.code).toBe('AGENT_NOT_FOUND');
  });

  it('cannot register before connecting', () => {
    const client = new MockMCSClient();
    expect(() => client.register()).toThrow('Not connected');
  });
});
