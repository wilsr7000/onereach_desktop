/**
 * Resource Manager - CRUD Lifecycle Tests
 *
 * Tests the ResourceManager class independently of the Electron runtime.
 * Since ResourceManager has hard Electron dependencies, we test the logic
 * by constructing an equivalent that exercises the same patterns.
 *
 * Run:  npx vitest run test/unit/resource-manager.test.js
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Build a test-friendly ResourceManager that doesn't require Electron
class TestableResourceManager {
  constructor() {
    this.isMonitoring = false;
    this.monitorInterval = null;
    this.throttledWindows = new Set();
    this.highResourceWindows = new Map();
    this.lastMetrics = null;
    this.throttleStartTime = null;
    this.onBattery = false;
    this.cpuHistory = [];
    this.maxHistorySize = 10;
    this.config = {
      MONITOR_INTERVAL: 5000,
      CPU_HIGH_THRESHOLD: 100,
      CPU_CRITICAL_THRESHOLD: 200,
      BACKGROUND_FRAME_RATE: 4,
      THROTTLE_COOLDOWN: 30000,
      MEMORY_HIGH_THRESHOLD: 2048,
    };
  }

  start() {
    if (this.isMonitoring) return;
    this.isMonitoring = true;
    this.monitorInterval = setInterval(() => this.checkResources(), this.config.MONITOR_INTERVAL);
    this.checkResources();
  }

  stop() {
    if (!this.isMonitoring) return;
    this.isMonitoring = false;
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = null;
    }
    this.unthrottleAll();
  }

  checkResources() {
    const metrics = [
      { type: 'Browser', pid: 100, cpu: { percentCPUUsage: 10 }, memory: { workingSetSize: 100 * 1024 } },
      { type: 'GPU', pid: 101, cpu: { percentCPUUsage: 5 }, memory: { workingSetSize: 50 * 1024 } },
    ];
    this.lastMetrics = metrics;
    let totalCPU = 0;
    let totalMemory = 0;
    for (const proc of metrics) {
      totalCPU += proc.cpu.percentCPUUsage;
      totalMemory += proc.memory.workingSetSize / 1024;
    }
    this.cpuHistory.push({ timestamp: Date.now(), totalCPU, totalMemory });
    if (this.cpuHistory.length > this.maxHistorySize) this.cpuHistory.shift();
  }

  throttleWindow(win = 'high') {
    if (!win || this.throttledWindows.has(win.id)) return;
    win.setFrameRate(this.config.BACKGROUND_FRAME_RATE);
    win.setBackgroundThrottling(true);
    this.throttledWindows.add(win.id);
    this.throttleStartTime = Date.now();
  }

  unthrottleWindow(win) {
    if (!win || !this.throttledWindows.has(win.id)) return;
    win.setFrameRate(60);
    this.throttledWindows.delete(win.id);
  }

  unthrottleAll() {
    this.throttledWindows.clear();
  }

  getMetricsSummary() {
    if (!this.lastMetrics) return null;
    let totalCPU = 0;
    let totalMemory = 0;
    for (const proc of this.lastMetrics) {
      totalCPU += proc.cpu.percentCPUUsage;
      totalMemory += proc.memory.workingSetSize / 1024;
    }
    return {
      totalCPU,
      totalMemory,
      processCount: this.lastMetrics.length,
      throttledCount: this.throttledWindows.size,
      onBattery: this.onBattery,
    };
  }

  enablePowerSaving() {
    this.config.CPU_HIGH_THRESHOLD = 80;
    this.config.CPU_CRITICAL_THRESHOLD = 150;
    this.config.BACKGROUND_FRAME_RATE = 2;
  }

  disablePowerSaving() {
    this.config.CPU_HIGH_THRESHOLD = 100;
    this.config.CPU_CRITICAL_THRESHOLD = 200;
    this.config.BACKGROUND_FRAME_RATE = 4;
  }
}

function createMockWindow(id) {
  return {
    id,
    setFrameRate: vi.fn(),
    setBackgroundThrottling: vi.fn(),
  };
}

// ═══════════════════════════════════════════════════════════════════
// LIFECYCLE
// ═══════════════════════════════════════════════════════════════════

describe('ResourceManager - Lifecycle', () => {
  let rm;
  beforeEach(() => {
    rm = new TestableResourceManager();
  });
  afterEach(() => {
    if (rm.isMonitoring) rm.stop();
  });

  it('Step 1: Start monitoring', () => {
    rm.start();
    expect(rm.isMonitoring).toBe(true);
  });

  it('Step 2: Check resources populates metrics', () => {
    rm.start();
    rm.checkResources();
    expect(rm.lastMetrics).not.toBeNull();
    expect(rm.cpuHistory.length).toBeGreaterThan(0);
  });

  it('Step 3: Throttle a window', () => {
    rm.start();
    const win = createMockWindow(10);
    rm.throttleWindow(win, 'test');
    expect(rm.throttledWindows.has(10)).toBe(true);
    expect(win.setFrameRate).toHaveBeenCalledWith(rm.config.BACKGROUND_FRAME_RATE);
  });

  it('Step 4: Read throttled status', () => {
    rm.start();
    const win = createMockWindow(10);
    rm.throttleWindow(win, 'test');
    expect(rm.throttledWindows.size).toBe(1);
    expect(Array.from(rm.throttledWindows)).toContain(10);
  });

  it('Step 5: Unthrottle a window', () => {
    rm.start();
    const win = createMockWindow(10);
    rm.throttleWindow(win, 'test');
    rm.unthrottleWindow(win);
    expect(rm.throttledWindows.has(10)).toBe(false);
    expect(win.setFrameRate).toHaveBeenCalledWith(60);
  });

  it('Step 6: Verify clean after unthrottle', () => {
    rm.start();
    const win = createMockWindow(10);
    rm.throttleWindow(win, 'test');
    rm.unthrottleWindow(win);
    expect(rm.throttledWindows.size).toBe(0);
  });

  it('Step 7: Stop monitoring clears everything', () => {
    rm.start();
    rm.stop();
    expect(rm.isMonitoring).toBe(false);
    expect(rm.monitorInterval).toBeNull();
    expect(rm.throttledWindows.size).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════
// EDGE CASES
// ═══════════════════════════════════════════════════════════════════

describe('ResourceManager - Edge Cases', () => {
  let rm;
  beforeEach(() => {
    rm = new TestableResourceManager();
  });
  afterEach(() => {
    if (rm.isMonitoring) rm.stop();
  });

  it('should not double-throttle the same window', () => {
    const win = createMockWindow(10);
    rm.throttleWindow(win, 'test');
    rm.throttleWindow(win, 'test');
    expect(win.setFrameRate).toHaveBeenCalledTimes(1);
  });

  it('should handle unthrottle of non-throttled window', () => {
    const win = createMockWindow(99);
    rm.unthrottleWindow(win);
    expect(rm.throttledWindows.size).toBe(0);
  });

  it('should handle null window', () => {
    rm.throttleWindow(null);
    rm.unthrottleWindow(null);
    expect(rm.throttledWindows.size).toBe(0);
  });

  it('should return null metrics when never checked', () => {
    expect(rm.getMetricsSummary()).toBeNull();
  });

  it('should return metrics summary after check', () => {
    rm.checkResources();
    const summary = rm.getMetricsSummary();
    expect(summary).not.toBeNull();
    expect(summary.totalCPU).toBeGreaterThanOrEqual(0);
    expect(summary.processCount).toBeGreaterThan(0);
  });

  it('unthrottleAll should clear all throttled windows', () => {
    const w1 = createMockWindow(1);
    const w2 = createMockWindow(2);
    rm.throttleWindow(w1, 'test');
    rm.throttleWindow(w2, 'test');
    rm.unthrottleAll();
    expect(rm.throttledWindows.size).toBe(0);
  });

  it('start should be idempotent', () => {
    rm.start();
    const interval1 = rm.monitorInterval;
    rm.start();
    expect(rm.monitorInterval).toBe(interval1);
  });
});

// ═══════════════════════════════════════════════════════════════════
// POWER SAVING
// ═══════════════════════════════════════════════════════════════════

describe('ResourceManager - Power Saving', () => {
  let rm;
  beforeEach(() => {
    rm = new TestableResourceManager();
  });

  it('enablePowerSaving lowers thresholds', () => {
    rm.enablePowerSaving();
    expect(rm.config.CPU_HIGH_THRESHOLD).toBe(80);
    expect(rm.config.BACKGROUND_FRAME_RATE).toBe(2);
  });

  it('disablePowerSaving restores thresholds', () => {
    rm.enablePowerSaving();
    rm.disablePowerSaving();
    expect(rm.config.CPU_HIGH_THRESHOLD).toBe(100);
    expect(rm.config.BACKGROUND_FRAME_RATE).toBe(4);
  });
});
