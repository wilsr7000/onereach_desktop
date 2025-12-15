/**
 * Resource Manager - Automatic CPU/GPU throttling for Electron
 * 
 * This module monitors system resource usage and automatically throttles
 * background windows when CPU usage gets too high.
 * 
 * Features:
 * - Monitors CPU usage via app.getAppMetrics()
 * - Throttles background windows (reduces frame rate, suspends timers)
 * - Warns users about high-resource pages
 * - Provides manual controls for power management
 */

const { app, BrowserWindow, ipcMain, powerMonitor } = require('electron');

// Configuration
const CONFIG = {
  // Monitoring
  MONITOR_INTERVAL: 5000,        // Check every 5 seconds
  CPU_HIGH_THRESHOLD: 100,       // Total CPU % that triggers throttling
  CPU_CRITICAL_THRESHOLD: 200,   // CPU % that triggers aggressive throttling
  SINGLE_PROCESS_HIGH: 50,       // Single process CPU % considered high
  
  // Throttling
  BACKGROUND_FRAME_RATE: 4,      // FPS for background windows (default: 60)
  THROTTLE_COOLDOWN: 30000,      // Wait 30s before un-throttling
  
  // Memory
  MEMORY_HIGH_THRESHOLD: 2048,   // MB - warn if total memory exceeds this
};

class ResourceManager {
  constructor() {
    this.isMonitoring = false;
    this.monitorInterval = null;
    this.throttledWindows = new Set();
    this.highResourceWindows = new Map(); // windowId -> { cpu, warnings }
    this.lastMetrics = null;
    this.throttleStartTime = null;
    this.onBattery = false;
    
    // Track CPU history for trend detection
    this.cpuHistory = [];
    this.maxHistorySize = 10;
    
    // Callbacks
    this.onHighCPU = null;
    this.onWindowThrottled = null;
    this.onWarning = null;
  }
  
  /**
   * Start monitoring resources
   */
  start() {
    if (this.isMonitoring) return;
    
    console.log('[ResourceManager] Starting resource monitoring');
    this.isMonitoring = true;
    
    // Check battery status
    this.onBattery = powerMonitor.isOnBatteryPower?.() || false;
    powerMonitor.on('on-ac', () => {
      this.onBattery = false;
      console.log('[ResourceManager] Switched to AC power');
    });
    powerMonitor.on('on-battery', () => {
      this.onBattery = true;
      console.log('[ResourceManager] Switched to battery power - enabling power saving');
      this.enablePowerSaving();
    });
    
    // Start monitoring loop
    this.monitorInterval = setInterval(() => this.checkResources(), CONFIG.MONITOR_INTERVAL);
    
    // Initial check
    this.checkResources();
    
    // Set up IPC handlers
    this.setupIPC();
  }
  
  /**
   * Stop monitoring
   */
  stop() {
    if (!this.isMonitoring) return;
    
    console.log('[ResourceManager] Stopping resource monitoring');
    this.isMonitoring = false;
    
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = null;
    }
    
    // Un-throttle all windows
    this.unthrottleAll();
  }
  
  /**
   * Main resource check loop
   */
  checkResources() {
    try {
      const metrics = app.getAppMetrics();
      this.lastMetrics = metrics;
      
      // Calculate totals
      let totalCPU = 0;
      let totalMemory = 0;
      const processDetails = [];
      
      for (const proc of metrics) {
        const cpu = proc.cpu.percentCPUUsage;
        const memory = proc.memory.workingSetSize / 1024; // KB to MB
        
        totalCPU += cpu;
        totalMemory += memory;
        
        processDetails.push({
          type: proc.type,
          pid: proc.pid,
          cpu,
          memory,
          name: proc.name || proc.type
        });
      }
      
      // Store in history
      this.cpuHistory.push({ timestamp: Date.now(), totalCPU, totalMemory });
      if (this.cpuHistory.length > this.maxHistorySize) {
        this.cpuHistory.shift();
      }
      
      // Check thresholds
      if (totalCPU > CONFIG.CPU_CRITICAL_THRESHOLD) {
        this.handleCriticalCPU(totalCPU, processDetails);
      } else if (totalCPU > CONFIG.CPU_HIGH_THRESHOLD) {
        this.handleHighCPU(totalCPU, processDetails);
      } else if (this.throttledWindows.size > 0) {
        // CPU is normal, consider un-throttling
        this.considerUnthrottling(totalCPU);
      }
      
      // Check memory
      if (totalMemory > CONFIG.MEMORY_HIGH_THRESHOLD) {
        this.handleHighMemory(totalMemory, processDetails);
      }
      
      // Find high-CPU individual processes
      const highCPUProcesses = processDetails.filter(p => p.cpu > CONFIG.SINGLE_PROCESS_HIGH);
      if (highCPUProcesses.length > 0) {
        this.identifyHighCPUWindows(highCPUProcesses);
      }
      
    } catch (error) {
      console.error('[ResourceManager] Error checking resources:', error);
    }
  }
  
  /**
   * Handle critically high CPU usage
   */
  handleCriticalCPU(totalCPU, processes) {
    console.warn(`[ResourceManager] CRITICAL CPU usage: ${totalCPU.toFixed(1)}%`);
    
    // Throttle ALL background windows aggressively
    const windows = BrowserWindow.getAllWindows();
    const focusedWindow = BrowserWindow.getFocusedWindow();
    
    for (const win of windows) {
      if (win !== focusedWindow && !win.isDestroyed()) {
        this.throttleWindow(win, 'critical');
      }
    }
    
    // Notify callback
    if (this.onHighCPU) {
      this.onHighCPU({ level: 'critical', cpu: totalCPU, processes });
    }
    
    // Send warning to focused window
    if (focusedWindow && !focusedWindow.isDestroyed()) {
      focusedWindow.webContents.send('resource-warning', {
        type: 'critical-cpu',
        message: `High CPU usage detected (${totalCPU.toFixed(0)}%). Background tabs have been throttled.`,
        cpu: totalCPU
      });
    }
  }
  
  /**
   * Handle high CPU usage
   */
  handleHighCPU(totalCPU, processes) {
    console.log(`[ResourceManager] High CPU usage: ${totalCPU.toFixed(1)}%`);
    
    // Throttle hidden windows only
    const windows = BrowserWindow.getAllWindows();
    
    for (const win of windows) {
      if (!win.isDestroyed() && !win.isVisible()) {
        this.throttleWindow(win, 'high');
      }
    }
    
    if (this.onHighCPU) {
      this.onHighCPU({ level: 'high', cpu: totalCPU, processes });
    }
  }
  
  /**
   * Handle high memory usage
   */
  handleHighMemory(totalMemory, processes) {
    console.warn(`[ResourceManager] High memory usage: ${totalMemory.toFixed(0)} MB`);
    
    if (this.onWarning) {
      this.onWarning({
        type: 'high-memory',
        message: `Memory usage is high (${totalMemory.toFixed(0)} MB)`,
        memory: totalMemory
      });
    }
  }
  
  /**
   * Throttle a window to reduce resource usage
   */
  throttleWindow(win, reason = 'high') {
    if (!win || win.isDestroyed() || this.throttledWindows.has(win.id)) {
      return;
    }
    
    const windowId = win.id;
    console.log(`[ResourceManager] Throttling window ${windowId} (reason: ${reason})`);
    
    try {
      // Reduce frame rate for background windows
      win.webContents.setFrameRate(CONFIG.BACKGROUND_FRAME_RATE);
      
      // Set background throttling
      win.webContents.setBackgroundThrottling(true);
      
      // For critical situations, also throttle timers
      if (reason === 'critical') {
        win.webContents.executeJavaScript(`
          (function() {
            if (window.__resourceManagerThrottled) return;
            window.__resourceManagerThrottled = true;
            
            // Store original functions
            window.__originalSetInterval = window.setInterval;
            window.__originalSetTimeout = window.setTimeout;
            window.__originalRAF = window.requestAnimationFrame;
            
            // Throttle setInterval (minimum 1 second)
            window.setInterval = function(fn, delay, ...args) {
              return window.__originalSetInterval(fn, Math.max(delay || 0, 1000), ...args);
            };
            
            // Throttle requestAnimationFrame (skip frames)
            let rafCounter = 0;
            window.requestAnimationFrame = function(callback) {
              rafCounter++;
              if (rafCounter % 4 === 0) { // Only run every 4th frame
                return window.__originalRAF(callback);
              }
              return window.__originalRAF(() => {}); // Skip frame
            };
            
            console.log('[ResourceManager] Window throttled');
          })();
        `).catch(() => {});
      }
      
      this.throttledWindows.add(windowId);
      this.throttleStartTime = Date.now();
      
      if (this.onWindowThrottled) {
        this.onWindowThrottled({ windowId, reason, throttled: true });
      }
      
    } catch (error) {
      console.error(`[ResourceManager] Error throttling window ${windowId}:`, error);
    }
  }
  
  /**
   * Un-throttle a window
   */
  unthrottleWindow(win) {
    if (!win || win.isDestroyed()) return;
    
    const windowId = win.id;
    if (!this.throttledWindows.has(windowId)) return;
    
    console.log(`[ResourceManager] Un-throttling window ${windowId}`);
    
    try {
      // Restore normal frame rate
      win.webContents.setFrameRate(60);
      
      // Restore timers if they were throttled
      win.webContents.executeJavaScript(`
        (function() {
          if (!window.__resourceManagerThrottled) return;
          window.__resourceManagerThrottled = false;
          
          // Restore original functions
          if (window.__originalSetInterval) {
            window.setInterval = window.__originalSetInterval;
          }
          if (window.__originalSetTimeout) {
            window.setTimeout = window.__originalSetTimeout;
          }
          if (window.__originalRAF) {
            window.requestAnimationFrame = window.__originalRAF;
          }
          
          console.log('[ResourceManager] Window un-throttled');
        })();
      `).catch(() => {});
      
      this.throttledWindows.delete(windowId);
      
      if (this.onWindowThrottled) {
        this.onWindowThrottled({ windowId, throttled: false });
      }
      
    } catch (error) {
      console.error(`[ResourceManager] Error un-throttling window ${windowId}:`, error);
    }
  }
  
  /**
   * Un-throttle all windows
   */
  unthrottleAll() {
    const windows = BrowserWindow.getAllWindows();
    for (const win of windows) {
      this.unthrottleWindow(win);
    }
    this.throttledWindows.clear();
  }
  
  /**
   * Consider un-throttling windows if CPU has been low for a while
   */
  considerUnthrottling(currentCPU) {
    if (!this.throttleStartTime) return;
    
    const timeSinceThrottle = Date.now() - this.throttleStartTime;
    
    // Wait for cooldown period and ensure CPU is consistently low
    if (timeSinceThrottle > CONFIG.THROTTLE_COOLDOWN && currentCPU < CONFIG.CPU_HIGH_THRESHOLD * 0.7) {
      console.log('[ResourceManager] CPU normalized, un-throttling windows');
      this.unthrottleAll();
      this.throttleStartTime = null;
    }
  }
  
  /**
   * Identify which windows are using high CPU
   */
  identifyHighCPUWindows(highCPUProcesses) {
    // GPU process is shared, so we can't attribute it to a specific window
    // But renderer processes can be matched to windows
    const windows = BrowserWindow.getAllWindows();
    
    for (const proc of highCPUProcesses) {
      if (proc.type === 'GPU') {
        // GPU is shared - notify all windows
        for (const win of windows) {
          if (!win.isDestroyed() && win.isVisible()) {
            const existing = this.highResourceWindows.get(win.id) || { warnings: 0 };
            existing.cpu = proc.cpu;
            existing.warnings++;
            this.highResourceWindows.set(win.id, existing);
            
            // Warn after 3 consecutive high readings
            if (existing.warnings >= 3 && existing.warnings % 3 === 0) {
              win.webContents.send('resource-warning', {
                type: 'high-gpu',
                message: `GPU usage is high (${proc.cpu.toFixed(0)}%). Consider closing animation-heavy tabs.`,
                cpu: proc.cpu
              });
            }
          }
        }
      }
    }
  }
  
  /**
   * Enable power saving mode (for battery)
   */
  enablePowerSaving() {
    console.log('[ResourceManager] Enabling power saving mode');
    
    // Lower thresholds when on battery
    CONFIG.CPU_HIGH_THRESHOLD = 80;
    CONFIG.CPU_CRITICAL_THRESHOLD = 150;
    CONFIG.BACKGROUND_FRAME_RATE = 2;
    
    // Throttle all non-focused windows
    const windows = BrowserWindow.getAllWindows();
    const focusedWindow = BrowserWindow.getFocusedWindow();
    
    for (const win of windows) {
      if (win !== focusedWindow && !win.isDestroyed()) {
        this.throttleWindow(win, 'battery');
      }
    }
  }
  
  /**
   * Disable power saving mode
   */
  disablePowerSaving() {
    console.log('[ResourceManager] Disabling power saving mode');
    
    // Restore normal thresholds
    CONFIG.CPU_HIGH_THRESHOLD = 100;
    CONFIG.CPU_CRITICAL_THRESHOLD = 200;
    CONFIG.BACKGROUND_FRAME_RATE = 4;
    
    // Un-throttle windows
    this.unthrottleAll();
  }
  
  /**
   * Set up IPC handlers
   */
  setupIPC() {
    // Get current resource status
    ipcMain.handle('resource-manager:get-status', () => {
      return {
        isMonitoring: this.isMonitoring,
        throttledWindows: Array.from(this.throttledWindows),
        onBattery: this.onBattery,
        lastMetrics: this.lastMetrics,
        cpuHistory: this.cpuHistory,
        config: CONFIG
      };
    });
    
    // Manual throttle control
    ipcMain.handle('resource-manager:throttle-window', (event, windowId) => {
      const win = BrowserWindow.fromId(windowId);
      if (win) {
        this.throttleWindow(win, 'manual');
        return true;
      }
      return false;
    });
    
    ipcMain.handle('resource-manager:unthrottle-window', (event, windowId) => {
      const win = BrowserWindow.fromId(windowId);
      if (win) {
        this.unthrottleWindow(win);
        return true;
      }
      return false;
    });
    
    // Toggle monitoring
    ipcMain.handle('resource-manager:toggle', (event, enabled) => {
      if (enabled) {
        this.start();
      } else {
        this.stop();
      }
      return this.isMonitoring;
    });
    
    // Update config
    ipcMain.handle('resource-manager:set-config', (event, newConfig) => {
      Object.assign(CONFIG, newConfig);
      console.log('[ResourceManager] Config updated:', CONFIG);
      return CONFIG;
    });
  }
  
  /**
   * Get current metrics summary
   */
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
      onBattery: this.onBattery
    };
  }
}

// Singleton instance
let resourceManager = null;

function getResourceManager() {
  if (!resourceManager) {
    resourceManager = new ResourceManager();
  }
  return resourceManager;
}

module.exports = {
  ResourceManager,
  getResourceManager,
  CONFIG
};

