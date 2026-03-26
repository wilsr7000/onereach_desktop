import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  app: { getVersion: vi.fn(() => '4.5.1') },
}));

let healthMonitor;

beforeEach(() => {
  vi.clearAllMocks();
  global.windowRegistry = {
    list: vi.fn(() => []),
    get: vi.fn(() => null),
    register: vi.fn(),
  };
  healthMonitor = require('../../lib/health-monitor');
});

describe('health-monitor', () => {
  it('exports startHealthMonitor function', () => {
    expect(typeof healthMonitor.startHealthMonitor).toBe('function');
  });

  it('exports stopHealthMonitor function', () => {
    expect(typeof healthMonitor.stopHealthMonitor).toBe('function');
  });

  it('exports getHealthStatus function', () => {
    expect(typeof healthMonitor.getHealthStatus).toBe('function');
  });

  it('exports watchRenderer function', () => {
    expect(typeof healthMonitor.watchRenderer).toBe('function');
  });

  it('getHealthStatus returns expected shape before start', () => {
    const status = healthMonitor.getHealthStatus();
    expect(status).toHaveProperty('running');
    expect(status).toHaveProperty('cpuAvg');
    expect(status).toHaveProperty('heapUsedMB');
    expect(status).toHaveProperty('rssMB');
    expect(status).toHaveProperty('rendererReloads');
    expect(status).toHaveProperty('lastRecoveryTime');
    expect(typeof status.heapUsedMB).toBe('number');
    expect(typeof status.rssMB).toBe('number');
  });

  it('watchRenderer handles a mock window with events', () => {
    const handlers = {};
    const mockWin = {
      isDestroyed: () => false,
      on: (event, handler) => { handlers[event] = handler; },
      webContents: { reload: vi.fn() },
    };

    healthMonitor.watchRenderer(mockWin, 'test-window');
    expect(handlers).toHaveProperty('unresponsive');
    expect(handlers).toHaveProperty('responsive');
    expect(handlers).toHaveProperty('closed');
  });

  it('watchRenderer safely handles null/destroyed window', () => {
    expect(() => healthMonitor.watchRenderer(null, 'null-win')).not.toThrow();
    expect(() => healthMonitor.watchRenderer({ isDestroyed: () => true }, 'dead-win')).not.toThrow();
  });
});
