const fs = require('fs');
const path = require('path');
const { app } = require('electron');

// Process-level error hooks are global; install them once even if a second
// EventLogger is ever constructed (tests, dual-writer regressions).
let processHooksInstalled = false;

/**
 * Serialize an arbitrary rejection reason / thrown value into something
 * JSON.stringify preserves. Errors stringify to {} by default, which made
 * every "Unhandled Rejection" line useless for postmortems.
 */
function serializeErrorish(value) {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (typeof value === 'object' && value !== null) {
    try {
      JSON.stringify(value);
      return value;
    } catch (_e) {
      return { unserializable: String(value) };
    }
  }
  return { value: String(value) };
}

class EventLogger {
  constructor(options = {}) {
    this.logDir = options.logDir || path.join(app.getPath('userData'), 'logs');
    this.currentLogFile = null;
    this.logStream = null;
    this.logBuffer = [];
    this.flushInterval = null;
    this.maxLogSize = options.maxLogSize ?? 10 * 1024 * 1024; // 10MB per file
    this.maxLogFiles = options.maxLogFiles ?? 5; // Keep last 5 log files
    this.logLevel = 'info'; // debug, info, warn, error
    this.currentLogDate = null; // Track which date the current log file is for
    this.dailyRotationInterval = null; // Interval to check for daily rotation
    this.flushIntervalMs = options.flushIntervalMs ?? 30000;

    // Rotation-storm guard: minimum ms between size-based rotations. A log
    // flood can push a file past maxLogSize faster than rotation can keep
    // up; without a cooldown that produced 6 rotations in 6 seconds whose
    // cleanup wiped the whole log history (2026-08-12 incident). Date
    // rotations and recovery reopens bypass the cooldown.
    this.rotateCooldownMs = options.rotateCooldownMs ?? 5000;

    // Flood guard: token buckets bounding how many entries reach disk per
    // second. Errors get a reserved budget so an info flood can't drown
    // the failure signal. Dropped entries are counted and reported in one
    // summary line on the next tick.
    this.floodRatePerSec = options.floodRatePerSec ?? 200;
    this.floodBurst = options.floodBurst ?? 2000;
    this.errorRatePerSec = options.errorRatePerSec ?? 50;
    this.errorBurst = options.errorBurst ?? 500;

    // Bound the in-memory buffer so a dead stream can't grow it forever.
    this.maxBufferBytes = options.maxBufferBytes ?? 8 * 1024 * 1024;

    // Heartbeat: every N flush ticks, write one file-only liveness line.
    // (EventLogger methods write to the file directly, not the ring
    // buffer/WS queue, so heartbeats never pollute /logs or bug reports.)
    this.heartbeatEveryTicks = options.heartbeatEveryTicks ?? 10;

    this._installProcessHooks = options.installProcessHooks ?? true;
    this._appVersionResolved =
      options.appVersion ??
      (() => {
        try {
          return app.getVersion();
        } catch (_e) {
          return 'unknown';
        }
      })();

    this.levels = {
      debug: 0,
      info: 1,
      warn: 2,
      error: 3,
    };

    // Internal accounting (see log()/flush()/_onFlushTick()).
    this._bytesInCurrentFile = 0;
    this._bufferBytes = 0;
    this._lastRotateAt = 0;
    this._streamDead = false;
    this._tokens = this.floodBurst;
    this._errorTokens = this.errorBurst;
    this._lastRefillAt = Date.now();
    this._droppedSinceSummary = 0;
    this._droppedTotal = 0;
    this._rotationsTotal = 0;
    this._recoveriesTotal = 0;
    this._lastErrorFlushAt = 0;
    this._tickCount = 0;
    this._lastTickAt = Date.now();
    this._lastWritePromise = null;

    this.init();
  }

  init() {
    // Create logs directory if it doesn't exist
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }

    // Set up current log file
    this.rotateLogFile('startup');

    // Set up periodic flush + liveness heartbeat
    // PERFORMANCE: Increased from 5s to 30s to reduce I/O overhead
    this.flushInterval = setInterval(() => this._onFlushTick(), this.flushIntervalMs);
    if (this.flushInterval.unref) this.flushInterval.unref();

    // Set up daily rotation check (every hour to catch date changes)
    this.dailyRotationInterval = setInterval(() => this.checkDailyRotation(), 60 * 60 * 1000);
    if (this.dailyRotationInterval.unref) this.dailyRotationInterval.unref();

    // Capture unhandled errors
    if (this._installProcessHooks && !processHooksInstalled) {
      processHooksInstalled = true;
      process.on('uncaughtException', (error) => {
        this.error('Uncaught Exception', { error: error.message, stack: error.stack });
        this.flush(); // Immediate flush for critical errors
      });

      process.on('unhandledRejection', (reason, _promise) => {
        this.error('Unhandled Rejection', { reason: serializeErrorish(reason) });
        this.flush();
      });
    }
  }

  /**
   * Periodic tick: self-heal the writer, surface event-loop stalls, report
   * dropped-entry counts, emit the heartbeat, flush.
   *
   * The heartbeat is the liveness contract for postmortems: a healthy
   * writer produces a line at least every (flushIntervalMs *
   * heartbeatEveryTicks). A log file that simply stops MID-session now
   * means the process died or the event loop stalled -- never "the writer
   * silently wedged", which is indistinguishable from app death from the
   * outside (2026-08-12 incident).
   */
  _onFlushTick() {
    const now = Date.now();
    const tickDelayMs = Math.max(0, now - (this._lastTickAt + this.flushIntervalMs));
    this._lastTickAt = now;
    this._tickCount++;

    // Self-heal 1: our current file vanished from disk (external delete, a
    // sibling instance's cleanup). The old stream points at an unlinked
    // inode -- every write is invisible. Reopen a fresh file.
    let recoveryReason = null;
    if (this.currentLogFile && !fs.existsSync(this.currentLogFile)) {
      recoveryReason = 'current log file missing on disk';
    } else if (this._streamDead || !this.logStream) {
      // Self-heal 2: the stream errored (ENOSPC, EIO, closed fd).
      recoveryReason = 'write stream dead';
    }
    if (recoveryReason) {
      this._recover(recoveryReason);
    }

    // A delayed tick means the main-process event loop was blocked or
    // saturated. We can't log DURING a stall, but the first line after it
    // quantifies the gap, which is the forensic fact postmortems need.
    if (tickDelayMs > 5000) {
      this._logDirect('warn', 'Event-loop stall detected by logger heartbeat', {
        tickDelayMs,
        expectedIntervalMs: this.flushIntervalMs,
      });
    }

    if (this._droppedSinceSummary > 0) {
      this._logDirect('warn', 'Log flood: entries dropped by writer flood guard', {
        dropped: this._droppedSinceSummary,
        droppedTotal: this._droppedTotal,
        ratePerSec: this.floodRatePerSec,
      });
      this._droppedSinceSummary = 0;
    }

    if (this._tickCount % this.heartbeatEveryTicks === 0) {
      this._logDirect('info', 'logger.heartbeat', {
        uptimeSec: Math.round(process.uptime()),
        tickDelayMs,
        droppedTotal: this._droppedTotal,
        rotationsTotal: this._rotationsTotal,
        recoveriesTotal: this._recoveriesTotal,
        bufferedBytes: this._bufferBytes,
      });
    }

    this.flush();
  }

  /**
   * Force-reopen the log file (bypasses the rotation cooldown) and record
   * that a recovery happened. Buffered entries land in the new file; bytes
   * already written to a ghost inode are gone, but the gap is announced.
   */
  _recover(reason) {
    this._recoveriesTotal++;
    try {
      // Mark the old stream dead BEFORE rotating: rotateLogFile() starts
      // with a flush, and flushing into a stream whose file was unlinked
      // would drain the buffer into the ghost inode. Dead-stream flushes
      // no-op, so the buffer survives to drain into the new file instead.
      this._streamDead = true;
      this.rotateLogFile(`recovery: ${reason}`);
      this._logDirect('warn', 'Logger recovered', {
        reason,
        recoveriesTotal: this._recoveriesTotal,
      });
    } catch (error) {
      if (global.originalConsole) {
        global.originalConsole.error('Logger recovery failed:', error);
      }
    }
  }

  rotateLogFile(reason = 'size or date') {
    // Close existing stream if any
    if (this.logStream) {
      this.flush();
      try {
        this.logStream.end();
      } catch (_e) {
        // Ending an already-errored stream can throw; the old stream is
        // being discarded either way.
      }
    }

    // Get current date for filename and tracking
    const now = new Date();
    const dateStr = now.toISOString().split('T')[0]; // YYYY-MM-DD
    const timeStr = now.toISOString().replace(/:/g, '-').split('.')[0].replace('T', '_');

    // Update current log date
    this.currentLogDate = dateStr;

    // Create new log file with date and timestamp. Filenames are
    // second-granular, so two rotations inside one second would silently
    // reuse (append to) the same file and defeat the rotation -- suffix a
    // counter when the name is taken.
    let candidate = path.join(this.logDir, `onereach-${timeStr}.log`);
    for (let n = 2; fs.existsSync(candidate) && n < 100; n++) {
      candidate = path.join(this.logDir, `onereach-${timeStr}_${n}.log`);
    }
    this.currentLogFile = candidate;
    this._bytesInCurrentFile = 0;
    this._lastRotateAt = Date.now();
    this._rotationsTotal++;

    // Touch the file synchronously: createWriteStream opens lazily, and
    // until the async open completes the file has no directory entry --
    // which the ghost-file check in _onFlushTick() would read as "current
    // file missing" and spin a recovery loop, and the collision loop
    // above couldn't see a same-second predecessor.
    try {
      fs.closeSync(fs.openSync(candidate, 'a'));
    } catch (_e) {
      // Stream creation below will surface the same problem via its
      // 'error' listener; nothing extra to do here.
    }

    // Create write stream. The error listener is load-bearing: a stream
    // 'error' with no listener becomes an uncaughtException, and the
    // handler for THAT logs back into this dead stream. Instead mark the
    // stream dead; the next tick reopens it.
    this.logStream = fs.createWriteStream(this.currentLogFile, { flags: 'a' });
    this._streamDead = false;
    this.logStream.on('error', (error) => {
      this._streamDead = true;
      if (global.originalConsole) {
        global.originalConsole.error('Log stream error:', error);
      }
    });

    // Clean up old log files
    this.cleanupOldLogs();

    this._logDirect('info', 'Logger initialized', {
      logFile: this.currentLogFile,
      logDate: this.currentLogDate,
      rotationReason: reason,
      pid: process.pid,
      platform: process.platform,
      appVersion: this._appVersionResolved,
    });

    // Force flush to ensure this is written
    this.flush();
  }

  cleanupOldLogs() {
    try {
      const now = Date.now();
      const files = fs
        .readdirSync(this.logDir)
        .filter((f) => f.startsWith('onereach-') && f.endsWith('.log'))
        .map((f) => ({
          name: f,
          path: path.join(this.logDir, f),
          time: fs.statSync(path.join(this.logDir, f)).mtime.getTime(),
        }))
        // Newest first; mtimes only have second granularity on some
        // filesystems, so tie-break on name to keep the sort stable --
        // an unstable sort here once deleted the ACTIVE log file
        // mid-rotation-storm.
        .sort((a, b) => b.time - a.time || b.name.localeCompare(a.name));

      // Remove old files if we have too many. Never delete the file we're
      // writing, and never delete recently-modified files -- a fresh mtime
      // means some writer (us, or a sibling instance sharing this dir) is
      // actively using it.
      if (files.length > this.maxLogFiles) {
        files.slice(this.maxLogFiles).forEach((file) => {
          if (file.path === this.currentLogFile) return;
          if (now - file.time < 60 * 1000) return;
          fs.unlinkSync(file.path);
        });
      }
    } catch (error) {
      // Use original console if available to avoid loops
      if (global.originalConsole) {
        global.originalConsole.error('Error cleaning up logs:', error);
      }
    }
  }

  checkDailyRotation() {
    // Check if the date has changed since the current log file was created
    const currentDate = new Date().toISOString().split('T')[0];

    if (this.currentLogDate && currentDate !== this.currentLogDate) {
      console.log(`[Logger] Date changed from ${this.currentLogDate} to ${currentDate}, rotating log file`);
      this.rotateLogFile();
    }
  }

  shouldLog(level) {
    return this.levels[level] >= this.levels[this.logLevel];
  }

  // Set minimum log level for console capture
  setConsoleLogLevel(level) {
    // Allow setting a different threshold for console logs
    this.consoleLogLevel = level || 'debug';
  }

  formatLogEntry(level, message, data = {}) {
    const entry = {
      timestamp: new Date().toISOString(),
      level: level.toUpperCase(),
      message,
      ...data,
    };

    // Add context information
    if (global.currentUser) {
      entry.user = global.currentUser;
    }

    if (global.activeWindow) {
      entry.window = global.activeWindow;
    }

    // Add test context if available
    if (global.currentTestContext) {
      entry.testContext = {
        testId: global.currentTestContext.testId,
        testName: global.currentTestContext.testName,
        testCategory: global.currentTestContext.testCategory,
        testArea: global.currentTestContext.testArea,
        testIndex: global.currentTestContext.testIndex,
        totalTests: global.currentTestContext.totalTests,
      };
    }

    return JSON.stringify(entry) + '\n';
  }

  log(level, message, data) {
    if (!this.shouldLog(level)) return;

    // Flood guard: refill the token buckets, then charge one token per
    // entry. Error-level entries draw from a reserved budget first so an
    // info/debug flood can't drown the failure signal. Entries dropped
    // here are counted and reported as one summary line on the next tick.
    this._refillTokens();
    if (level === 'error' && this._errorTokens >= 1) {
      this._errorTokens--;
    } else if (this._tokens >= 1) {
      this._tokens--;
    } else {
      this._droppedSinceSummary++;
      this._droppedTotal++;
      return;
    }

    this._append(level, message, data);

    // Also log to console in development
    // Use the original console to avoid infinite loops with console interceptor
    if (process.env.NODE_ENV === 'development' && global.originalConsole) {
      global.originalConsole.log(`[${level.toUpperCase()}]`, message, data || '');
    }

    // Immediate flush for errors, debounced to once per second: during an
    // error storm the per-error flush turned every entry into its own
    // write() + rotation check, which helped saturate the main loop.
    if (level === 'error') {
      const now = Date.now();
      if (now - this._lastErrorFlushAt >= 1000) {
        this._lastErrorFlushAt = now;
        this.flush();
      }
    }
  }

  /**
   * Writer-internal lines (heartbeat, flood summaries, recovery markers,
   * rotation banners) bypass the flood guard -- they ARE the signal the
   * guard exists to protect. Still bounded by the buffer byte cap.
   */
  _logDirect(level, message, data) {
    this._append(level, message, data);
  }

  /**
   * Format an entry, append it to the bounded in-memory buffer, and run
   * the rotation check off internal byte accounting (no statSync in the
   * hot path -- the old per-entry existsSync+statSync pair was two sync
   * syscalls per log line on the main process, and its existsSync gate
   * silently disabled rotation forever once the current file was deleted
   * externally).
   */
  _append(level, message, data) {
    const logEntry = this.formatLogEntry(level, message, data);

    this.logBuffer.push(logEntry);
    this._bufferBytes += logEntry.length;

    // Bound the buffer: a dead stream must not grow memory without limit.
    // Drop oldest first; the drops surface in the next flood summary.
    while (this._bufferBytes > this.maxBufferBytes && this.logBuffer.length > 1) {
      const evicted = this.logBuffer.shift();
      this._bufferBytes -= evicted.length;
      this._droppedSinceSummary++;
      this._droppedTotal++;
    }

    // Rotate when the bytes we've written (plus what's buffered) pass the
    // size limit, or when the date rolls over. Size rotations honor a
    // cooldown so a flood can't rotate several times per second and wipe
    // the log history via cleanup.
    const currentDate = new Date().toISOString().split('T')[0];
    const dateChanged = this.currentLogDate && currentDate !== this.currentLogDate;
    const sizeExceeded = this._bytesInCurrentFile + this._bufferBytes > this.maxLogSize;
    if (
      dateChanged ||
      (sizeExceeded && Date.now() - this._lastRotateAt >= this.rotateCooldownMs)
    ) {
      const reason = dateChanged ? 'new day started' : 'size limit reached';
      console.log(`[Logger] Rotating log file (${reason})`);
      this.rotateLogFile(reason);
    }
  }

  _refillTokens() {
    const now = Date.now();
    const elapsedSec = (now - this._lastRefillAt) / 1000;
    if (elapsedSec <= 0) return;
    this._lastRefillAt = now;
    this._tokens = Math.min(this.floodBurst, this._tokens + elapsedSec * this.floodRatePerSec);
    this._errorTokens = Math.min(
      this.errorBurst,
      this._errorTokens + elapsedSec * this.errorRatePerSec
    );
  }

  debug(message, data) {
    this.log('debug', message, data);
  }

  info(message, data) {
    this.log('info', message, data);
  }

  warn(message, data) {
    this.log('warn', message, data);
  }

  error(message, data) {
    this.log('error', message, data);
  }

  // Log specific event types
  logEvent(eventType, eventData) {
    this.info(`Event: ${eventType}`, { event: eventType, ...eventData });
  }

  logApiCall(method, endpoint, data, response, duration) {
    this.info('API Call', {
      method,
      endpoint,
      requestData: data,
      response: response?.status || response,
      duration,
      timestamp: new Date().toISOString(),
    });
  }

  logUserAction(action, details) {
    this.info('User Action', {
      action,
      details,
      timestamp: new Date().toISOString(),
    });
  }

  logPerformance(operation, duration, metadata) {
    this.info('Performance', {
      operation,
      duration,
      ...metadata,
      timestamp: new Date().toISOString(),
    });
  }

  // === Application Lifecycle Events ===

  logAppLaunch(metadata = {}) {
    this.info('App Launched', {
      event: 'app:launch',
      version: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      electronVersion: process.versions.electron,
      ...metadata,
    });
  }

  logAppReady() {
    this.info('App Ready', {
      event: 'app:ready',
      uptime: process.uptime(),
    });
  }

  logAppQuit(reason = 'user-initiated') {
    this.info('App Quit', {
      event: 'app:quit',
      reason,
      uptime: process.uptime(),
    });
    this.flush(); // Ensure this is written
  }

  // === Window Management Events ===

  logWindowCreated(windowType, windowId, metadata = {}) {
    this.info('Window Created', {
      event: 'window:created',
      windowType,
      windowId,
      ...metadata,
    });
  }

  logWindowClosed(windowType, windowId, metadata = {}) {
    this.info('Window Closed', {
      event: 'window:closed',
      windowType,
      windowId,
      ...metadata,
    });
  }

  logWindowFocused(windowType, windowId) {
    this.debug('Window Focused', {
      event: 'window:focused',
      windowType,
      windowId,
    });
  }

  logWindowNavigation(windowId, url, from = null) {
    this.info('Window Navigation', {
      event: 'window:navigation',
      windowId,
      url,
      from,
    });
  }

  // === Tab Management Events ===

  logTabCreated(tabId, url, metadata = {}) {
    this.info('Tab Created', {
      event: 'tab:created',
      tabId,
      url,
      ...metadata,
    });
  }

  logTabClosed(tabId, url) {
    this.info('Tab Closed', {
      event: 'tab:closed',
      tabId,
      url,
    });
  }

  logTabSwitched(fromTab, toTab) {
    this.info('Tab Switched', {
      event: 'tab:switched',
      from: fromTab,
      to: toTab,
    });
  }

  // === Menu & Settings Events ===

  logMenuAction(menuItem, metadata = {}) {
    this.info('Menu Action', {
      event: 'menu:action',
      menuItem,
      ...metadata,
    });
  }

  logSettingsChanged(setting, oldValue, newValue) {
    this.info('Settings Changed', {
      event: 'settings:changed',
      setting,
      oldValue: oldValue ? '***' : null, // Hide sensitive values
      newValue: newValue ? '***' : null,
    });
  }

  // === File & Clipboard Events ===

  logFileOperation(operation, filePath, metadata = {}) {
    this.info('File Operation', {
      event: 'file:operation',
      operation,
      filePath,
      ...metadata,
    });
  }

  logClipboardOperation(operation, itemType, metadata = {}) {
    this.info('Clipboard Operation', {
      event: 'clipboard:operation',
      operation,
      itemType,
      ...metadata,
    });
  }

  // === Network & API Events ===

  logNetworkRequest(method, url, statusCode, duration) {
    this.info('Network Request', {
      event: 'network:request',
      method,
      url,
      statusCode,
      duration,
    });
  }

  logAPIError(endpoint, error, metadata = {}) {
    this.error('API Error', {
      event: 'api:error',
      endpoint,
      error: error.message || error,
      ...metadata,
    });
  }

  // === Module & Feature Events ===

  logModuleInstalled(moduleId, moduleName, version) {
    this.info('Module Installed', {
      event: 'module:installed',
      moduleId,
      moduleName,
      version,
    });
  }

  logFeatureUsed(featureName, metadata = {}) {
    this.info('Feature Used', {
      event: 'feature:used',
      feature: featureName,
      ...metadata,
    });
  }

  flush() {
    if (this.logBuffer.length === 0) return;

    // A dead or missing stream keeps the (bounded) buffer; the next
    // _onFlushTick() reopens the file and this flush drains into it.
    if (!this.logStream || this._streamDead) return;

    try {
      const data = this.logBuffer.join('');
      const stream = this.logStream;
      this._lastWritePromise = new Promise((resolve) => {
        stream.write(data, () => resolve());
      });
      this._bytesInCurrentFile += data.length;
      this.logBuffer = [];
      this._bufferBytes = 0;
    } catch (error) {
      // Keep the buffer (bounded by maxBufferBytes) and mark the stream
      // dead so the next tick reopens the file instead of retrying a
      // write that can never succeed.
      this._streamDead = true;
      // Use original console if available to avoid loops
      if (global.originalConsole) {
        global.originalConsole.error('Error flushing logs:', error);
      }
    }
  }

  /**
   * Resolves once the most recent flush() has been handed to the OS.
   * Stream writes complete asynchronously; callers that need read-back
   * durability (tests, export-then-read flows) await this.
   */
  async _flushed() {
    const pending = this._lastWritePromise;
    if (pending) await pending;
  }

  // Get recent logs for debugging
  getRecentLogs(count = 100) {
    try {
      // Debug output using original console
      if (global.originalConsole) {
        global.originalConsole.log('getRecentLogs called with count:', count);
        global.originalConsole.log('Log directory:', this.logDir);
        global.originalConsole.log('Current log file:', this.currentLogFile);
      }

      // Ensure log directory exists
      if (!fs.existsSync(this.logDir)) {
        if (global.originalConsole) {
          global.originalConsole.log('Log directory does not exist');
        }
        return [];
      }

      // If no current log file, try to find the most recent one
      if (!this.currentLogFile || !fs.existsSync(this.currentLogFile)) {
        const files = this.getLogFiles();
        if (global.originalConsole) {
          global.originalConsole.log('Found log files:', files.length);
        }
        if (files.length > 0) {
          this.currentLogFile = files[0].path;
          if (global.originalConsole) {
            global.originalConsole.log('Using log file:', this.currentLogFile);
          }
        } else {
          if (global.originalConsole) {
            global.originalConsole.log('No log files found');
          }
          return [];
        }
      }

      const content = fs.readFileSync(this.currentLogFile, 'utf8');
      const lines = content
        .trim()
        .split('\n')
        .filter((line) => line.trim());

      if (global.originalConsole) {
        global.originalConsole.log('Read', lines.length, 'lines from log file');
      }

      const logs = lines.slice(-count).map((line) => {
        try {
          return JSON.parse(line);
        } catch (e) {
          // Don't log parsing errors to avoid loops
          return { raw: line, parseError: e.message };
        }
      });

      if (global.originalConsole) {
        global.originalConsole.log('Returning', logs.length, 'log entries');
      }

      return logs;
    } catch (error) {
      if (global.originalConsole) {
        global.originalConsole.error('Error in getRecentLogs:', error);
      }
      return [];
    }
  }

  // Export logs for issue reporting
  async exportLogs(options = {}) {
    const {
      startDate = new Date(Date.now() - 24 * 60 * 60 * 1000), // Last 24 hours
      endDate = new Date(),
      includeDebug = false,
      format = 'json', // json or text
    } = options;

    try {
      const logs = [];
      const files = fs
        .readdirSync(this.logDir)
        .filter((f) => f.startsWith('onereach-') && f.endsWith('.log'))
        .map((f) => path.join(this.logDir, f));

      for (const file of files) {
        const content = fs.readFileSync(file, 'utf8');
        const lines = content.trim().split('\n');

        for (const line of lines) {
          try {
            const entry = JSON.parse(line);
            const entryDate = new Date(entry.timestamp);

            if (entryDate >= startDate && entryDate <= endDate) {
              if (includeDebug || entry.level !== 'DEBUG') {
                logs.push(entry);
              }
            }
          } catch {
            // Skip malformed lines
          }
        }
      }

      // Sort by timestamp
      logs.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

      if (format === 'text') {
        return logs
          .map((log) => `[${log.timestamp}] ${log.level}: ${log.message} ${JSON.stringify(log.data || {})}`)
          .join('\n');
      }

      return logs;
    } catch (error) {
      this.error('Error exporting logs', { error: error.message });
      throw error;
    }
  }

  // Get log file paths
  getLogFiles() {
    try {
      return fs
        .readdirSync(this.logDir)
        .filter((f) => f.startsWith('onereach-') && f.endsWith('.log'))
        .map((f) => ({
          name: f,
          path: path.join(this.logDir, f),
          size: fs.statSync(path.join(this.logDir, f)).size,
          modified: fs.statSync(path.join(this.logDir, f)).mtime,
        }))
        .sort((a, b) => b.modified - a.modified);
    } catch (error) {
      this.error('Error getting log files', { error: error.message });
      return [];
    }
  }

  // Clean up
  destroy() {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }

    // Fix: Also clear the daily rotation interval (memory leak fix)
    if (this.dailyRotationInterval) {
      clearInterval(this.dailyRotationInterval);
      this.dailyRotationInterval = null;
    }

    this.flush();

    if (this.logStream) {
      try {
        this.logStream.end();
      } catch (_e) {
        // Errored streams can throw on end(); nothing left to release.
      }
    }
  }
}

// Create singleton instance
let logger = null;

// Create logger instance when app is ready
function getLogger() {
  if (!logger) {
    // Check if app is ready
    if (!app || !app.isReady()) {
      // Create a temporary logger that will work before app is ready
      logger = {
        logDir: path.join(process.cwd(), 'temp-logs'),
        currentLogFile: null,
        logBuffer: [],

        // Provide stub methods that work before full initialization
        info: (_message, _data) => {},
        warn: (_message, _data) => {},
        error: (_message, _data) => {},
        debug: (_message, _data) => {},

        logEvent: (_eventType, _eventData) => {},
        logApiCall: () => {},
        logUserAction: () => {},
        logPerformance: () => {},

        getRecentLogs: () => [],
        getLogFiles: () => [],
        exportLogs: async () => [],

        // Will be replaced when app is ready
        _isStub: true,
      };

      // Replace with real logger when app is ready
      if (app) {
        app.whenReady().then(() => {
          // Initialize real logger when app is ready
          logger = new EventLogger();
        });
      }
    } else {
      logger = new EventLogger();
    }
  }

  return logger;
}

// Export the getter function, not the result
module.exports = getLogger;
// Named exports for tests and advanced callers (the class takes an options
// bag: logDir, maxLogSize, maxLogFiles, flushIntervalMs, rotateCooldownMs,
// floodRatePerSec/floodBurst, errorRatePerSec/errorBurst, maxBufferBytes,
// heartbeatEveryTicks, appVersion, installProcessHooks).
module.exports.EventLogger = EventLogger;
module.exports.serializeErrorish = serializeErrorish;
