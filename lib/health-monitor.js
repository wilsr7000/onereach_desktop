/**
 * Internal Health Monitor
 *
 * Runs inside the main process to detect degradation early and attempt
 * soft recovery before the external watchdog has to kill-restart.
 *
 * Monitors:
 *   - Event loop lag (setTimeout drift)
 *   - CPU usage (rolling 60s window)
 *   - Heap memory pressure
 *   - Renderer unresponsive events
 *
 * All events logged with category 'health-monitor'.
 */

const { getLogQueue } = require('./log-event-queue');

const CONFIG = {
  eventLoopIntervalMs: 2000,
  eventLoopWarnLagMs: 2000,
  eventLoopCriticalLagMs: 5000,

  cpuSampleIntervalMs: 10000,
  cpuSampleWindow: 6, // 6 samples = 60 seconds
  cpuHighThreshold: 90, // percent

  memCheckIntervalMs: 30000,
  memWarnBytes: 1.5 * 1024 * 1024 * 1024,   // 1.5 GB
  memCriticalBytes: 2 * 1024 * 1024 * 1024,  // 2 GB

  rendererUnresponsiveMs: 30000,
  rendererMaxReloads: 3,
};

let log = null;
let started = false;
let timers = [];
let cpuSamples = [];
let lastCpuUsage = null;
let lastCpuTime = null;
let rendererReloadCounts = new Map(); // windowId -> count
let rendererUnresponsiveTimers = new Map(); // windowId -> timeout

function getLog() {
  if (!log) log = getLogQueue();
  return log;
}

function logHealth(level, message, data) {
  try {
    getLog().enqueue({ level, category: 'health-monitor', message, data, source: 'health-monitor' });
  } catch (_) { /* never break on logging failure */ }
}

// ---------------------------------------------------------------------------
// Event Loop Lag Detection
// ---------------------------------------------------------------------------

function startEventLoopMonitor() {
  let lastTick = Date.now();

  const timer = setInterval(() => {
    const now = Date.now();
    const lag = now - lastTick - CONFIG.eventLoopIntervalMs;
    lastTick = now;

    if (lag > CONFIG.eventLoopCriticalLagMs) {
      logHealth('error', `Event loop blocked for ${lag}ms`, { lagMs: lag });
      attemptSoftRecovery('event-loop-critical');
    } else if (lag > CONFIG.eventLoopWarnLagMs) {
      logHealth('warn', `Event loop lag detected: ${lag}ms`, { lagMs: lag });
      tryGC();
    }
  }, CONFIG.eventLoopIntervalMs);
  timer.unref();
  timers.push(timer);
}

// ---------------------------------------------------------------------------
// CPU Monitoring
// ---------------------------------------------------------------------------

function startCPUMonitor() {
  lastCpuUsage = process.cpuUsage();
  lastCpuTime = Date.now();

  const timer = setInterval(() => {
    const current = process.cpuUsage(lastCpuUsage);
    const elapsed = (Date.now() - lastCpuTime) * 1000; // microseconds
    const cpuPercent = elapsed > 0 ? Math.round(((current.user + current.system) / elapsed) * 100) : 0;

    lastCpuUsage = process.cpuUsage();
    lastCpuTime = Date.now();

    cpuSamples.push(cpuPercent);
    if (cpuSamples.length > CONFIG.cpuSampleWindow) {
      cpuSamples.shift();
    }

    if (cpuSamples.length >= CONFIG.cpuSampleWindow) {
      const avg = cpuSamples.reduce((a, b) => a + b, 0) / cpuSamples.length;
      if (avg > CONFIG.cpuHighThreshold) {
        logHealth('error', `Sustained high CPU: ${Math.round(avg)}% avg over ${CONFIG.cpuSampleWindow * CONFIG.cpuSampleIntervalMs / 1000}s`, {
          avgCpu: Math.round(avg),
          samples: [...cpuSamples],
        });
        attemptSoftRecovery('cpu-high');
        cpuSamples = []; // reset after recovery attempt
      }
    }
  }, CONFIG.cpuSampleIntervalMs);
  timer.unref();
  timers.push(timer);
}

// ---------------------------------------------------------------------------
// Memory Monitoring
// ---------------------------------------------------------------------------

function startMemoryMonitor() {
  const timer = setInterval(() => {
    const mem = process.memoryUsage();
    const heapMB = Math.round(mem.heapUsed / (1024 * 1024));

    if (mem.heapUsed > CONFIG.memCriticalBytes) {
      logHealth('error', `Critical heap usage: ${heapMB}MB`, { heapUsedMB: heapMB, rssMB: Math.round(mem.rss / (1024 * 1024)) });
      attemptSoftRecovery('memory-critical');
    } else if (mem.heapUsed > CONFIG.memWarnBytes) {
      logHealth('warn', `High heap usage: ${heapMB}MB`, { heapUsedMB: heapMB });
      tryGC();
    }
  }, CONFIG.memCheckIntervalMs);
  timer.unref();
  timers.push(timer);
}

// ---------------------------------------------------------------------------
// Renderer Health (unresponsive detection + auto-reload)
// ---------------------------------------------------------------------------

function watchRenderer(win, name) {
  if (!win || win.isDestroyed()) return;

  win.on('unresponsive', () => {
    logHealth('warn', `Renderer unresponsive: ${name}`, { windowName: name });

    const existingTimer = rendererUnresponsiveTimers.get(name);
    if (existingTimer) return; // already watching

    const timeout = setTimeout(() => {
      rendererUnresponsiveTimers.delete(name);
      if (win.isDestroyed()) return;

      const reloads = rendererReloadCounts.get(name) || 0;
      if (reloads >= CONFIG.rendererMaxReloads) {
        logHealth('error', `Renderer ${name} failed ${CONFIG.rendererMaxReloads} reloads, closing`, { windowName: name });
        if (name !== 'main') {
          try { win.close(); } catch (_) { /* ignore */ }
        }
        return;
      }

      logHealth('warn', `Auto-reloading unresponsive renderer: ${name} (attempt ${reloads + 1})`, { windowName: name, attempt: reloads + 1 });
      try {
        win.webContents.reload();
        rendererReloadCounts.set(name, reloads + 1);
      } catch (e) {
        logHealth('error', `Reload failed for ${name}: ${e.message}`, { windowName: name });
      }
    }, CONFIG.rendererUnresponsiveMs);
    timeout.unref();
    rendererUnresponsiveTimers.set(name, timeout);
  });

  win.on('responsive', () => {
    const existingTimer = rendererUnresponsiveTimers.get(name);
    if (existingTimer) {
      clearTimeout(existingTimer);
      rendererUnresponsiveTimers.delete(name);
      logHealth('info', `Renderer recovered: ${name}`, { windowName: name });
    }
  });

  win.on('closed', () => {
    const existingTimer = rendererUnresponsiveTimers.get(name);
    if (existingTimer) {
      clearTimeout(existingTimer);
      rendererUnresponsiveTimers.delete(name);
    }
    rendererReloadCounts.delete(name);
  });
}

function startRendererMonitor() {
  function attach() {
    if (!global.windowRegistry) return false;

    const origRegister = global.windowRegistry.register.bind(global.windowRegistry);
    global.windowRegistry.register = function (name, window, opts) {
      origRegister(name, window, opts);
      watchRenderer(window, name);
    };

    for (const entry of global.windowRegistry.list()) {
      if (entry.alive) {
        const win = global.windowRegistry.get(entry.name);
        if (win) watchRenderer(win, entry.name);
      }
    }
    return true;
  }

  if (!attach()) {
    // Registry not ready yet; retry after a short delay
    const retry = setTimeout(() => { attach(); }, 3000);
    retry.unref();
    timers.push(retry);
  }
}

// ---------------------------------------------------------------------------
// Soft Recovery Actions
// ---------------------------------------------------------------------------

let lastRecoveryTime = 0;
const RECOVERY_COOLDOWN_MS = 60000;

function attemptSoftRecovery(reason) {
  const now = Date.now();
  if (now - lastRecoveryTime < RECOVERY_COOLDOWN_MS) {
    logHealth('info', `Soft recovery skipped (cooldown): ${reason}`);
    return;
  }
  lastRecoveryTime = now;
  logHealth('warn', `Attempting soft recovery: ${reason}`, { reason });

  tryGC();

  // Close hidden non-essential windows
  if (global.windowRegistry) {
    for (const entry of global.windowRegistry.list()) {
      if (!entry.alive || entry.name === 'main') continue;
      const win = global.windowRegistry.get(entry.name);
      if (win && !win.isVisible()) {
        logHealth('info', `Closing hidden window for recovery: ${entry.name}`);
        try { win.close(); } catch (_) { /* ignore */ }
      }
    }
  }
}

function tryGC() {
  if (typeof global.gc === 'function') {
    try {
      global.gc();
    } catch (_) { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function startHealthMonitor() {
  if (started) return;
  started = true;

  startEventLoopMonitor();
  startCPUMonitor();
  startMemoryMonitor();
  startRendererMonitor();

  logHealth('info', 'Health monitor started', {
    eventLoopInterval: CONFIG.eventLoopIntervalMs,
    cpuSampleInterval: CONFIG.cpuSampleIntervalMs,
    memCheckInterval: CONFIG.memCheckIntervalMs,
  });
}

function stopHealthMonitor() {
  for (const t of timers) clearInterval(t);
  timers = [];
  for (const [, t] of rendererUnresponsiveTimers) clearTimeout(t);
  rendererUnresponsiveTimers.clear();
  started = false;
}

function getHealthStatus() {
  const mem = process.memoryUsage();
  const avgCpu = cpuSamples.length > 0
    ? Math.round(cpuSamples.reduce((a, b) => a + b, 0) / cpuSamples.length)
    : 0;
  return {
    running: started,
    cpuAvg: avgCpu,
    cpuSamples: [...cpuSamples],
    heapUsedMB: Math.round(mem.heapUsed / (1024 * 1024)),
    rssMB: Math.round(mem.rss / (1024 * 1024)),
    rendererReloads: Object.fromEntries(rendererReloadCounts),
    lastRecoveryTime: lastRecoveryTime ? new Date(lastRecoveryTime).toISOString() : null,
  };
}

module.exports = { startHealthMonitor, stopHealthMonitor, getHealthStatus, watchRenderer };
