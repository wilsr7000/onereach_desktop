/**
 * IPC Resource Manager Namespace - Lifecycle Tests
 *
 * Lifecycle: getStatus -> toggle -> throttleWindow -> verify -> unthrottleWindow -> verify
 *
 * Run:  npx vitest run test/unit/ipc-resource-manager.test.js
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const state = { monitoring: false, throttled: new Set() };
const mockInvoke = vi.fn(async (channel, ...args) => {
  switch (channel) {
    case 'resource-manager:get-status':
      return { isMonitoring: state.monitoring, throttledWindows: [...state.throttled], onBattery: false };
    case 'resource-manager:toggle':
      state.monitoring = args[0];
      return state.monitoring;
    case 'resource-manager:throttle-window':
      state.throttled.add(args[0]);
      return true;
    case 'resource-manager:unthrottle-window':
      state.throttled.delete(args[0]);
      return true;
    case 'resource-manager:set-config':
      return args[0];
    default:
      return null;
  }
});

const resourceManagerIPC = {
  getStatus: () => mockInvoke('resource-manager:get-status'),
  toggle: (enabled) => mockInvoke('resource-manager:toggle', enabled),
  throttleWindow: (windowId) => mockInvoke('resource-manager:throttle-window', windowId),
  unthrottleWindow: (windowId) => mockInvoke('resource-manager:unthrottle-window', windowId),
  setConfig: (config) => mockInvoke('resource-manager:set-config', config),
};

beforeEach(() => {
  state.monitoring = false;
  state.throttled.clear();
});

describe('IPC Resource Manager - Lifecycle', () => {
  it('Step 1: Get initial status', async () => {
    const status = await resourceManagerIPC.getStatus();
    expect(status.isMonitoring).toBe(false);
    expect(status.throttledWindows).toEqual([]);
  });

  it('Step 2: Toggle monitoring on', async () => {
    const result = await resourceManagerIPC.toggle(true);
    expect(result).toBe(true);
  });

  it('Step 3: Throttle a window', async () => {
    await resourceManagerIPC.throttleWindow(10);
    const status = await resourceManagerIPC.getStatus();
    expect(status.throttledWindows).toContain(10);
  });

  it('Step 4: Verify throttled', async () => {
    await resourceManagerIPC.throttleWindow(20);
    const status = await resourceManagerIPC.getStatus();
    expect(status.throttledWindows).toContain(20);
  });

  it('Step 5: Unthrottle window', async () => {
    await resourceManagerIPC.throttleWindow(30);
    await resourceManagerIPC.unthrottleWindow(30);
    const status = await resourceManagerIPC.getStatus();
    expect(status.throttledWindows).not.toContain(30);
  });

  it('Step 6: Verify clean', async () => {
    const status = await resourceManagerIPC.getStatus();
    expect(status.throttledWindows.length).toBe(0);
  });
});
