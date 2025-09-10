// Console interceptor to capture all console logs and send to event logger

// Store original console methods
const originalConsole = {
    log: console.log,
    warn: console.warn,
    error: console.error,
    debug: console.debug,
    info: console.info
};

// Track if we're currently logging to prevent loops
let isLogging = false;

// Create interceptor function
function createConsoleInterceptor(logger, context = {}) {
    // Store original console globally to prevent loops
    global.originalConsole = originalConsole;
    
    const interceptConsoleMethod = (method, level) => {
        console[method] = function(...args) {
            // Call original console method
            originalConsole[method].apply(console, args);
            
            // Prevent infinite loops
            if (isLogging) {
                return;
            }
            
            // Skip if this is already being logged to prevent loops
            if (args[0] && typeof args[0] === 'string' && 
                (args[0].startsWith('[INFO]') || 
                 args[0].startsWith('[WARN]') ||
                 args[0].startsWith('[ERROR]') ||
                 args[0].startsWith('[DEBUG]') ||
                 args[0].includes('[Console.'))) {
                return;
            }
            
            // Format the message
            const message = args.map(arg => {
                if (typeof arg === 'object') {
                    try {
                        return JSON.stringify(arg, null, 2);
                    } catch (e) {
                        return String(arg);
                    }
                }
                return String(arg);
            }).join(' ');
            
            // Log to event logger
            try {
                isLogging = true;
                const logData = {
                    ...context,
                    consoleMethod: method,
                    args: args.length > 1 ? args : undefined
                };
                
                // For main process
                if (logger && logger[level]) {
                    logger[level](`[Console.${method}] ${message}`, logData);
                }
            } catch (err) {
                // Fail silently to avoid infinite loops
                originalConsole.error('Failed to log to event logger:', err);
            } finally {
                isLogging = false;
            }
        };
    };
    
    // Intercept all console methods
    interceptConsoleMethod('log', 'info');
    interceptConsoleMethod('warn', 'warn');
    interceptConsoleMethod('error', 'error');
    interceptConsoleMethod('debug', 'debug');
    interceptConsoleMethod('info', 'info');
}

// For renderer process - create a version that sends via IPC
function createRendererConsoleInterceptor(windowName = 'Unknown') {
    const interceptConsoleMethod = (method, level) => {
        console[method] = function(...args) {
            // Call original console method
            originalConsole[method].apply(console, args);
            
            // Format the message
            const message = args.map(arg => {
                if (typeof arg === 'object') {
                    try {
                        return JSON.stringify(arg, null, 2);
                    } catch (e) {
                        return String(arg);
                    }
                }
                return String(arg);
            }).join(' ');
            
            // Send to main process via IPC
            try {
                if (window.api && window.api.log && window.api.log[level]) {
                    window.api.log[level](`[Console.${method}] ${message}`, {
                        window: windowName,
                        url: window.location ? window.location.href : 'unknown',
                        consoleMethod: method,
                        timestamp: new Date().toISOString()
                    });
                }
            } catch (err) {
                // Fail silently
            }
        };
    };
    
    // Intercept all console methods
    interceptConsoleMethod('log', 'info');
    interceptConsoleMethod('warn', 'warn');
    interceptConsoleMethod('error', 'error');
    interceptConsoleMethod('debug', 'debug');
    interceptConsoleMethod('info', 'info');
}

// Export for use in main and renderer processes
module.exports = {
    createConsoleInterceptor,
    createRendererConsoleInterceptor,
    originalConsole
}; 