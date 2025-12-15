/**
 * Memory Leak Detection Utilities
 * 
 * This module provides tools for detecting and diagnosing memory leaks
 * in the Electron application.
 * 
 * Usage:
 *   const memUtils = require('./memory-leak-utils');
 *   
 *   // Check IPC listener counts
 *   memUtils.auditIPCListeners();
 *   
 *   // Get memory stats
 *   memUtils.getMemoryStats();
 *   
 *   // Start continuous monitoring
 *   memUtils.startMonitoring(30000); // Every 30 seconds
 */

const { ipcMain, app, BrowserWindow } = require('electron');
const EventEmitter = require('events');

// Track listener counts over time to detect leaks
let listenerHistory = [];
const MAX_HISTORY = 100;

/**
 * Audit IPC listeners for potential leaks
 * @returns {Object} Audit results with listener counts
 */
function auditIPCListeners() {
  const results = {
    timestamp: new Date().toISOString(),
    ipcMain: {},
    warnings: []
  };
  
  // Get all event names from ipcMain
  const eventNames = ipcMain.eventNames();
  
  eventNames.forEach(eventName => {
    const count = ipcMain.listenerCount(eventName);
    results.ipcMain[eventName] = count;
    
    // Warn if more than 10 listeners (Node's default warning threshold)
    if (count > 10) {
      results.warnings.push(`WARNING: ${eventName} has ${count} listeners (potential leak)`);
    }
  });
  
  // Store in history
  listenerHistory.push({
    timestamp: Date.now(),
    totalListeners: eventNames.reduce((sum, name) => sum + ipcMain.listenerCount(name), 0),
    eventCount: eventNames.length
  });
  
  // Keep history bounded
  if (listenerHistory.length > MAX_HISTORY) {
    listenerHistory.shift();
  }
  
  // Check for growing trend
  if (listenerHistory.length >= 5) {
    const recent = listenerHistory.slice(-5);
    const isGrowing = recent.every((item, i) => 
      i === 0 || item.totalListeners >= recent[i - 1].totalListeners
    );
    
    if (isGrowing && recent[4].totalListeners > recent[0].totalListeners * 1.5) {
      results.warnings.push('WARNING: Listener count is growing over time (potential leak)');
    }
  }
  
  results.totalListeners = eventNames.reduce((sum, name) => sum + ipcMain.listenerCount(name), 0);
  results.totalEvents = eventNames.length;
  
  return results;
}

/**
 * Get detailed memory statistics
 * @returns {Object} Memory statistics
 */
function getMemoryStats() {
  const usage = process.memoryUsage();
  const appMetrics = app.getAppMetrics();
  
  return {
    timestamp: new Date().toISOString(),
    mainProcess: {
      heapUsed: formatBytes(usage.heapUsed),
      heapTotal: formatBytes(usage.heapTotal),
      external: formatBytes(usage.external),
      rss: formatBytes(usage.rss),
      arrayBuffers: formatBytes(usage.arrayBuffers || 0)
    },
    mainProcessRaw: usage,
    allProcesses: appMetrics.map(proc => ({
      type: proc.type,
      pid: proc.pid,
      name: proc.name,
      memory: formatBytes(proc.memory.workingSetSize * 1024),
      memoryRaw: proc.memory.workingSetSize * 1024,
      cpu: proc.cpu.percentCPUUsage.toFixed(2) + '%'
    })),
    windows: BrowserWindow.getAllWindows().map(win => ({
      id: win.id,
      title: win.getTitle(),
      url: win.webContents.getURL().substring(0, 100)
    }))
  };
}

/**
 * Format bytes to human readable string
 */
function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(2) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

/**
 * Check for common memory leak patterns
 * @returns {Object} Leak check results
 */
function checkLeakPatterns() {
  const results = {
    timestamp: new Date().toISOString(),
    checks: [],
    warnings: []
  };
  
  // Check window count
  const windows = BrowserWindow.getAllWindows();
  results.checks.push({
    name: 'Open Windows',
    value: windows.length,
    threshold: 20,
    status: windows.length > 20 ? 'warning' : 'ok'
  });
  
  if (windows.length > 20) {
    results.warnings.push(`WARNING: ${windows.length} windows open - check for unclosed windows`);
  }
  
  // Check IPC listeners
  const ipcAudit = auditIPCListeners();
  results.checks.push({
    name: 'IPC Listeners',
    value: ipcAudit.totalListeners,
    threshold: 500,
    status: ipcAudit.totalListeners > 500 ? 'warning' : 'ok'
  });
  
  results.ipcWarnings = ipcAudit.warnings;
  
  // Check heap usage
  const usage = process.memoryUsage();
  const heapUsedMB = usage.heapUsed / (1024 * 1024);
  results.checks.push({
    name: 'Heap Used',
    value: heapUsedMB.toFixed(2) + ' MB',
    threshold: '500 MB',
    status: heapUsedMB > 500 ? 'warning' : 'ok'
  });
  
  if (heapUsedMB > 500) {
    results.warnings.push(`WARNING: High heap usage (${heapUsedMB.toFixed(2)} MB)`);
  }
  
  return results;
}

// Monitoring interval reference
let monitorInterval = null;

/**
 * Start continuous monitoring
 * @param {number} intervalMs - Interval in milliseconds (default: 30000)
 */
function startMonitoring(intervalMs = 30000) {
  if (monitorInterval) {
    console.log('[MemoryUtils] Monitoring already active');
    return;
  }
  
  console.log(`[MemoryUtils] Starting memory monitoring (interval: ${intervalMs}ms)`);
  
  monitorInterval = setInterval(() => {
    const stats = getMemoryStats();
    const leakCheck = checkLeakPatterns();
    
    console.log('[MemoryUtils] === Memory Report ===');
    console.log('[MemoryUtils] Main Process:', stats.mainProcess);
    console.log('[MemoryUtils] Windows:', stats.windows.length);
    
    if (leakCheck.warnings.length > 0) {
      console.warn('[MemoryUtils] WARNINGS:', leakCheck.warnings);
    }
  }, intervalMs);
  
  // Run once immediately
  const initialStats = getMemoryStats();
  console.log('[MemoryUtils] Initial stats:', initialStats.mainProcess);
}

/**
 * Stop continuous monitoring
 */
function stopMonitoring() {
  if (monitorInterval) {
    clearInterval(monitorInterval);
    monitorInterval = null;
    console.log('[MemoryUtils] Monitoring stopped');
  }
}

/**
 * Force garbage collection (requires --expose-gc flag)
 * @returns {Object} Memory before and after GC
 */
function forceGC() {
  const before = process.memoryUsage();
  
  if (global.gc) {
    global.gc();
    const after = process.memoryUsage();
    
    return {
      gcAvailable: true,
      before: {
        heapUsed: formatBytes(before.heapUsed),
        rss: formatBytes(before.rss)
      },
      after: {
        heapUsed: formatBytes(after.heapUsed),
        rss: formatBytes(after.rss)
      },
      freed: {
        heapUsed: formatBytes(before.heapUsed - after.heapUsed),
        rss: formatBytes(before.rss - after.rss)
      }
    };
  }
  
  return {
    gcAvailable: false,
    message: 'Run with --expose-gc flag to enable manual garbage collection'
  };
}

/**
 * Get listener history for trend analysis
 * @returns {Array} History of listener counts
 */
function getListenerHistory() {
  return [...listenerHistory];
}

/**
 * Reset listener history
 */
function resetListenerHistory() {
  listenerHistory = [];
}

module.exports = {
  auditIPCListeners,
  getMemoryStats,
  checkLeakPatterns,
  startMonitoring,
  stopMonitoring,
  forceGC,
  getListenerHistory,
  resetListenerHistory,
  formatBytes
};

