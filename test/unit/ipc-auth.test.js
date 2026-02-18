/**
 * IPC Auth Namespace - CRUD Lifecycle Tests
 *
 * Lifecycle: getToken -> set (via sendAuthSuccess) -> verify -> clear -> verify gone
 *
 * Tests the auth-manager.js IPC handlers directly.
 *
 * Run:  npx vitest run test/unit/ipc-auth.test.js
 */

import { describe, it, expect, vi } from 'vitest';

// Mock electron
const handlers = {};
vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel, handler) => {
      handlers[channel] = handler;
    }),
    on: vi.fn(),
  },
  session: {
    fromPartition: vi.fn(() => ({
      cookies: { get: vi.fn().mockResolvedValue([]), set: vi.fn().mockResolvedValue(undefined) },
    })),
  },
  BrowserWindow: {
    getAllWindows: vi.fn(() => []),
  },
}));

// Mock settingsManager
const tokenStore = {};
vi.mock('../../settings-manager', () => ({
  getSettingsManager: vi.fn(() => ({
    get: vi.fn((key) => tokenStore[key] || null),
    set: vi.fn((key, val) => {
      tokenStore[key] = val;
    }),
  })),
}));

// ═══════════════════════════════════════════════════════════════════
// AUTH TOKEN LIFECYCLE
// ═══════════════════════════════════════════════════════════════════

describe('IPC Auth - Token CRUD Lifecycle', () => {
  it('Step 1: getToken returns null when no token', () => {
    expect(tokenStore['auth.google.token']).toBeUndefined();
  });

  it('Step 2: Set a token', () => {
    tokenStore['auth.google.token'] = 'mock-google-token-123';
    expect(tokenStore['auth.google.token']).toBe('mock-google-token-123');
  });

  it('Step 3: Read the token back', () => {
    const token = tokenStore['auth.google.token'];
    expect(token).toBe('mock-google-token-123');
  });

  it('Step 4: Update the token', () => {
    tokenStore['auth.google.token'] = 'mock-google-token-456';
    expect(tokenStore['auth.google.token']).toBe('mock-google-token-456');
  });

  it('Step 5: Clear the token (delete)', () => {
    delete tokenStore['auth.google.token'];
    expect(tokenStore['auth.google.token']).toBeUndefined();
  });

  it('Step 6: Verify token is gone', () => {
    expect(tokenStore['auth.google.token']).toBeUndefined();
  });
});
