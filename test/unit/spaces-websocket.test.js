/**
 * Spaces API WebSocket Protocol - Lifecycle Tests
 *
 * Lifecycle: connect -> auth -> receive auth-success -> ping/pong -> disconnect
 *
 * Run:  npx vitest run test/unit/spaces-websocket.test.js
 */

import { describe, it, expect, beforeEach } from 'vitest';

// Simulate the Spaces WS protocol
class MockSpacesWS {
  constructor() {
    this.messages = [];
    this.authenticated = false;
    this.connected = false;
  }

  connect() {
    this.connected = true;
    this.messages.push({ direction: 'system', type: 'connected' });
  }

  // Client sends auth
  sendAuth(token) {
    if (!this.connected) throw new Error('Not connected');
    const msg = { type: 'auth', token };
    this.messages.push({ direction: 'client->server', ...msg });
    return msg;
  }

  // Server sends auth-success
  handleAuthSuccess() {
    const msg = { type: 'auth-success' };
    this.messages.push({ direction: 'server->client', ...msg });
    this.authenticated = true;
    return msg;
  }

  // Server sends auth-failed
  handleAuthFailed() {
    const msg = { type: 'auth-failed' };
    this.messages.push({ direction: 'server->client', ...msg });
    this.authenticated = false;
    return msg;
  }

  // Client sends ping
  sendPing() {
    if (!this.connected) throw new Error('Not connected');
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

  disconnect() {
    this.connected = false;
    this.authenticated = false;
    this.messages.push({ direction: 'system', type: 'disconnected' });
  }
}

// ═══════════════════════════════════════════════════════════════════
// FULL LIFECYCLE
// ═══════════════════════════════════════════════════════════════════

describe('Spaces WebSocket Protocol - Full Lifecycle', () => {
  let ws;

  beforeEach(() => {
    ws = new MockSpacesWS();
  });

  it('Step 1: Connect', () => {
    ws.connect();
    expect(ws.connected).toBe(true);
  });

  it('Step 2: Send auth token', () => {
    ws.connect();
    const msg = ws.sendAuth('ext-token-123');
    expect(msg.type).toBe('auth');
    expect(msg.token).toBe('ext-token-123');
  });

  it('Step 3: Receive auth-success', () => {
    ws.connect();
    ws.sendAuth('valid-token');
    const msg = ws.handleAuthSuccess();
    expect(msg.type).toBe('auth-success');
    expect(ws.authenticated).toBe(true);
  });

  it('Step 4: Ping/pong heartbeat', () => {
    ws.connect();
    ws.sendAuth('valid-token');
    ws.handleAuthSuccess();
    const ping = ws.sendPing();
    expect(ping.type).toBe('ping');
    const pong = ws.handlePong();
    expect(pong.type).toBe('pong');
  });

  it('Step 5: Disconnect', () => {
    ws.connect();
    ws.sendAuth('valid-token');
    ws.handleAuthSuccess();
    ws.disconnect();
    expect(ws.connected).toBe(false);
    expect(ws.authenticated).toBe(false);
  });

  it('Step 6: Verify clean state after disconnect', () => {
    ws.connect();
    ws.sendAuth('token');
    ws.handleAuthSuccess();
    ws.disconnect();
    expect(ws.connected).toBe(false);
    expect(ws.authenticated).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════
// AUTH FAILURE
// ═══════════════════════════════════════════════════════════════════

describe('Spaces WebSocket Protocol - Auth Failure', () => {
  it('auth-failed leaves client unauthenticated', () => {
    const ws = new MockSpacesWS();
    ws.connect();
    ws.sendAuth('bad-token');
    ws.handleAuthFailed();
    expect(ws.authenticated).toBe(false);
    expect(ws.connected).toBe(true);
  });

  it('cannot send ping before connecting', () => {
    const ws = new MockSpacesWS();
    expect(() => ws.sendPing()).toThrow('Not connected');
  });
});
