const fs = require('fs');
const path = require('path');
const { app } = require('electron');

class EventLogger {
    constructor() {
        this.logDir = path.join(app.getPath('userData'), 'logs');
        this.currentLogFile = null;
        this.logStream = null;
        this.logBuffer = [];
        this.flushInterval = null;
        this.maxLogSize = 10 * 1024 * 1024; // 10MB per file
        this.maxLogFiles = 5; // Keep last 5 log files
        this.logLevel = 'info'; // debug, info, warn, error
        this.currentLogDate = null; // Track which date the current log file is for
        this.dailyRotationInterval = null; // Interval to check for daily rotation
        
        this.levels = {
            debug: 0,
            info: 1,
            warn: 2,
            error: 3
        };
        
        this.init();
    }

    init() {
        // Create logs directory if it doesn't exist
        if (!fs.existsSync(this.logDir)) {
            fs.mkdirSync(this.logDir, { recursive: true });
        }
        
        // Set up current log file
        this.rotateLogFile();
        
        // Set up periodic flush
        // PERFORMANCE: Increased from 5s to 30s to reduce I/O overhead
        this.flushInterval = setInterval(() => this.flush(), 30000); // Flush every 30 seconds
        
        // Set up daily rotation check (every hour to catch date changes)
        this.dailyRotationInterval = setInterval(() => this.checkDailyRotation(), 60 * 60 * 1000);
        
        // Capture unhandled errors
        process.on('uncaughtException', (error) => {
            this.error('Uncaught Exception', { error: error.message, stack: error.stack });
            this.flush(); // Immediate flush for critical errors
        });
        
        process.on('unhandledRejection', (reason, promise) => {
            this.error('Unhandled Rejection', { reason, promise });
            this.flush();
        });
    }

    rotateLogFile() {
        // Close existing stream if any
        if (this.logStream) {
            this.flush();
            this.logStream.end();
        }
        
        // Get current date for filename and tracking
        const now = new Date();
        const dateStr = now.toISOString().split('T')[0]; // YYYY-MM-DD
        const timeStr = now.toISOString().replace(/:/g, '-').split('.')[0].replace('T', '_');
        
        // Update current log date
        this.currentLogDate = dateStr;
        
        // Create new log file with date and timestamp
        this.currentLogFile = path.join(this.logDir, `onereach-${timeStr}.log`);
        
        // Create write stream
        this.logStream = fs.createWriteStream(this.currentLogFile, { flags: 'a' });
        
        // Clean up old log files
        this.cleanupOldLogs();
        
        this.info('Logger initialized', { 
            logFile: this.currentLogFile,
            logDate: this.currentLogDate,
            pid: process.pid,
            platform: process.platform,
            appVersion: app.getVersion()
        });
        
        // Force flush to ensure this is written
        this.flush();
    }

    cleanupOldLogs() {
        try {
            const files = fs.readdirSync(this.logDir)
                .filter(f => f.startsWith('onereach-') && f.endsWith('.log'))
                .map(f => ({
                    name: f,
                    path: path.join(this.logDir, f),
                    time: fs.statSync(path.join(this.logDir, f)).mtime.getTime()
                }))
                .sort((a, b) => b.time - a.time); // Newest first
            
            // Remove old files if we have too many
            if (files.length > this.maxLogFiles) {
                files.slice(this.maxLogFiles).forEach(file => {
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
            ...data
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
                totalTests: global.currentTestContext.totalTests
            };
        }
        
        return JSON.stringify(entry) + '\n';
    }

    log(level, message, data) {
        if (!this.shouldLog(level)) return;
        
        const logEntry = this.formatLogEntry(level, message, data);
        
        // Add to buffer
        this.logBuffer.push(logEntry);
        
        // Also log to console in development
        // Use the original console to avoid infinite loops with console interceptor
        if (process.env.NODE_ENV === 'development' && global.originalConsole) {
            global.originalConsole.log(`[${level.toUpperCase()}]`, message, data || '');
        }
        
        // Check if we need to rotate log file (size-based or date-based)
        if (this.currentLogFile && fs.existsSync(this.currentLogFile)) {
            const stats = fs.statSync(this.currentLogFile);
            const currentDate = new Date().toISOString().split('T')[0];
            
            // Rotate if file is too large OR if date has changed
            if (stats.size > this.maxLogSize || (this.currentLogDate && currentDate !== this.currentLogDate)) {
                const reason = stats.size > this.maxLogSize ? 'size limit reached' : 'new day started';
                console.log(`[Logger] Rotating log file (${reason})`);
                this.rotateLogFile();
            }
        }
        
        // Immediate flush for errors
        if (level === 'error') {
            this.flush();
        }
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
            timestamp: new Date().toISOString()
        });
    }

    logUserAction(action, details) {
        this.info('User Action', {
            action,
            details,
            timestamp: new Date().toISOString()
        });
    }

    logPerformance(operation, duration, metadata) {
        this.info('Performance', {
            operation,
            duration,
            ...metadata,
            timestamp: new Date().toISOString()
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
            ...metadata
        });
    }
    
    logAppReady() {
        this.info('App Ready', {
            event: 'app:ready',
            uptime: process.uptime()
        });
    }
    
    logAppQuit(reason = 'user-initiated') {
        this.info('App Quit', {
            event: 'app:quit',
            reason,
            uptime: process.uptime()
        });
        this.flush(); // Ensure this is written
    }
    
    // === Window Management Events ===
    
    logWindowCreated(windowType, windowId, metadata = {}) {
        this.info('Window Created', {
            event: 'window:created',
            windowType,
            windowId,
            ...metadata
        });
    }
    
    logWindowClosed(windowType, windowId, metadata = {}) {
        this.info('Window Closed', {
            event: 'window:closed',
            windowType,
            windowId,
            ...metadata
        });
    }
    
    logWindowFocused(windowType, windowId) {
        this.debug('Window Focused', {
            event: 'window:focused',
            windowType,
            windowId
        });
    }
    
    logWindowNavigation(windowId, url, from = null) {
        this.info('Window Navigation', {
            event: 'window:navigation',
            windowId,
            url,
            from
        });
    }
    
    // === Tab Management Events ===
    
    logTabCreated(tabId, url, metadata = {}) {
        this.info('Tab Created', {
            event: 'tab:created',
            tabId,
            url,
            ...metadata
        });
    }
    
    logTabClosed(tabId, url) {
        this.info('Tab Closed', {
            event: 'tab:closed',
            tabId,
            url
        });
    }
    
    logTabSwitched(fromTab, toTab) {
        this.info('Tab Switched', {
            event: 'tab:switched',
            from: fromTab,
            to: toTab
        });
    }
    
    // === Menu & Settings Events ===
    
    logMenuAction(menuItem, metadata = {}) {
        this.info('Menu Action', {
            event: 'menu:action',
            menuItem,
            ...metadata
        });
    }
    
    logSettingsChanged(setting, oldValue, newValue) {
        this.info('Settings Changed', {
            event: 'settings:changed',
            setting,
            oldValue: oldValue ? '***' : null, // Hide sensitive values
            newValue: newValue ? '***' : null
        });
    }
    
    // === File & Clipboard Events ===
    
    logFileOperation(operation, filePath, metadata = {}) {
        this.info('File Operation', {
            event: 'file:operation',
            operation,
            filePath,
            ...metadata
        });
    }
    
    logClipboardOperation(operation, itemType, metadata = {}) {
        this.info('Clipboard Operation', {
            event: 'clipboard:operation',
            operation,
            itemType,
            ...metadata
        });
    }
    
    // === Network & API Events ===
    
    logNetworkRequest(method, url, statusCode, duration) {
        this.info('Network Request', {
            event: 'network:request',
            method,
            url,
            statusCode,
            duration
        });
    }
    
    logAPIError(endpoint, error, metadata = {}) {
        this.error('API Error', {
            event: 'api:error',
            endpoint,
            error: error.message || error,
            ...metadata
        });
    }
    
    // === Module & Feature Events ===
    
    logModuleInstalled(moduleId, moduleName, version) {
        this.info('Module Installed', {
            event: 'module:installed',
            moduleId,
            moduleName,
            version
        });
    }
    
    logFeatureUsed(featureName, metadata = {}) {
        this.info('Feature Used', {
            event: 'feature:used',
            feature: featureName,
            ...metadata
        });
    }

    flush() {
        if (this.logBuffer.length === 0 || !this.logStream) return;
        
        try {
            const data = this.logBuffer.join('');
            this.logStream.write(data);
            this.logBuffer = [];
        } catch (error) {
            // Use original console if available to avoid loops
            if (global.originalConsole) {
                global.originalConsole.error('Error flushing logs:', error);
            }
        }
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
            const lines = content.trim().split('\n').filter(line => line.trim());
            
            if (global.originalConsole) {
                global.originalConsole.log('Read', lines.length, 'lines from log file');
            }
            
            const logs = lines
                .slice(-count)
                .map(line => {
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
            format = 'json' // json or text
        } = options;
        
        try {
            const logs = [];
            const files = fs.readdirSync(this.logDir)
                .filter(f => f.startsWith('onereach-') && f.endsWith('.log'))
                .map(f => path.join(this.logDir, f));
            
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
                return logs.map(log => 
                    `[${log.timestamp}] ${log.level}: ${log.message} ${JSON.stringify(log.data || {})}`
                ).join('\n');
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
            return fs.readdirSync(this.logDir)
                .filter(f => f.startsWith('onereach-') && f.endsWith('.log'))
                .map(f => ({
                    name: f,
                    path: path.join(this.logDir, f),
                    size: fs.statSync(path.join(this.logDir, f)).size,
                    modified: fs.statSync(path.join(this.logDir, f)).mtime
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
            this.logStream.end();
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
                info: (message, data) => {},
                warn: (message, data) => {},
                error: (message, data) => {},
                debug: (message, data) => {},
                
                logEvent: (eventType, eventData) => {},
                logApiCall: () => {},
                logUserAction: () => {},
                logPerformance: () => {},
                
                getRecentLogs: () => [],
                getLogFiles: () => [],
                exportLogs: async () => [],
                
                // Will be replaced when app is ready
                _isStub: true
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