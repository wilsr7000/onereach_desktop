# Event Logging System Guide

## Overview

The Onereach.ai application now includes a comprehensive centralized event logging system that captures all important events, errors, and user actions across the entire application. This system helps with debugging, troubleshooting, and recreating issues.

## Features

### Centralized Logging
- All logs from main process, renderer processes, and background tasks are captured
- Automatic log rotation (keeps last 5 files, 10MB each)
- Structured JSON format for easy parsing
- Real-time buffering with periodic flushing
- Immediate flush for critical errors

### Log Levels
- **DEBUG**: Detailed information for debugging
- **INFO**: General informational messages
- **WARN**: Warning messages for potential issues
- **ERROR**: Error messages for failures

### What Gets Logged

1. **Application Events**
   - App startup/shutdown
   - Window creation/destruction
   - Settings changes
   - Feature usage

2. **User Actions**
   - Menu clicks
   - Button presses
   - File operations
   - Navigation

3. **System Events**
   - Clipboard operations
   - File system changes
   - Network requests
   - API calls

4. **Errors & Exceptions**
   - Uncaught exceptions
   - Unhandled promise rejections
   - API failures
   - Validation errors

5. **Performance Metrics**
   - Operation durations
   - Memory usage
   - Response times

6. **Console Output (Automatic)**
   - All `console.log()` calls
   - All `console.warn()` calls
   - All `console.error()` calls
   - All `console.debug()` calls
   - All `console.info()` calls
   - **Includes window/process context automatically**

## Accessing the Log Viewer

### Via Menu
1. Press `Cmd+Alt+H` (Mac) or `Ctrl+Alt+H` (Windows) to activate the hidden test menu
2. Go to **Help → 📋 Event Log Viewer**
3. Or use the shortcut: `Cmd+Shift+L` (Mac) or `Ctrl+Shift+L` (Windows)

### Features of Log Viewer
- **Real-time Updates**: Auto-refreshes every 5 seconds
- **Filtering**: Filter by log level (Debug, Info, Warn, Error)
- **Search**: Search across all log entries
- **Export**: Export logs in JSON or plain text format
- **Time Range**: Export last hour, 6 hours, 24 hours, 7 days, or all logs

## Log File Locations

Logs are stored in the application's user data directory:

### macOS
```
~/Library/Application Support/onereach-ai/logs/
```

### Windows
```
%APPDATA%/onereach-ai/logs/
```

### Linux
```
~/.config/onereach-ai/logs/
```

Log files are named with timestamps: `onereach-YYYY-MM-DDTHH-MM-SS.log`

## Automatic Console Capture

The logging system automatically captures ALL console output from every window and process without requiring any code changes:

### How It Works
- **No Code Changes Required**: Existing `console.log()` statements are automatically captured
- **Window Context**: Each log entry shows which window it came from
- **Process Identification**: Distinguishes between main process and renderer logs
- **Preserves Original Behavior**: Console output still appears in DevTools as normal
- **Format Preservation**: Objects are properly stringified with formatting

### Example Log Entries
```json
{
  "timestamp": "2024-01-20T10:30:45.123Z",
  "level": "INFO",
  "message": "[Console.log] User clicked save button",
  "window": "Settings",
  "url": "file:///settings.html",
  "consoleMethod": "log",
  "process": "renderer"
}
```

### Benefits
- **Zero Migration Effort**: All existing console statements work immediately
- **Complete Coverage**: Captures logs from all windows automatically
- **Debug Production Issues**: Console logs from users are captured in log exports
- **Window Tracking**: Know exactly which window generated each log

## Using Logs for Debugging

### For Developers

1. **Add logging in main process**:
```javascript
const logger = require('./event-logger');

// Log general info
logger.info('Operation completed', { duration: 1234, itemCount: 5 });

// Log warnings
logger.warn('Deprecated feature used', { feature: 'oldAPI' });

// Log errors
logger.error('API call failed', { error: error.message, endpoint: '/api/data' });

// Log user actions
logger.logUserAction('clicked-button', { buttonId: 'save', location: 'settings' });

// Log API calls
logger.logApiCall('POST', '/api/items', requestData, response, duration);
```

2. **Add logging in renderer process**:
```javascript
// Use the exposed logger via window.api
window.api.log.info('Page loaded', { url: window.location.href });
window.api.log.error('Failed to load data', { error: error.message });
window.api.log.userAction('form-submitted', { formId: 'settings' });
```

### For Users Reporting Issues

1. **Reproduce the issue**
2. **Open the Event Log Viewer** (Cmd+Shift+L)
3. **Export the logs**:
   - Click "Export Logs"
   - Select time range (usually "Last 24 hours")
   - Choose format (JSON for developers, Text for readability)
   - Include debug logs if requested
4. **Share the exported log file** with support

## Log Entry Structure

Each log entry contains:
```json
{
  "timestamp": "2024-01-20T10:30:45.123Z",
  "level": "INFO",
  "message": "User action performed",
  "action": "clicked-button",
  "details": {
    "buttonId": "save",
    "location": "settings"
  },
  "source": "renderer",
  "user": "current-user-id",
  "window": "main-window"
}
```

## Privacy & Security

- Logs are stored locally only
- No sensitive data (passwords, API keys) should be logged
- Logs are automatically cleaned up (keeps only last 5 files)
- Users control what gets exported and shared

## Troubleshooting Common Issues

### Logs not appearing
1. Check if the app has write permissions to the user data directory
2. Ensure sufficient disk space is available
3. Try restarting the application

### Log viewer not opening
1. Ensure you've activated the test menu (Cmd+Alt+H)
2. Check for JavaScript errors in the developer console
3. Verify the log viewer files exist in the application

### Export failing
1. Check disk space for export location
2. Ensure you have write permissions
3. Try a different export format

## Best Practices

### For Developers
1. Use appropriate log levels
2. Include relevant context in log data
3. Don't log sensitive information
4. Use structured data for easier parsing
5. Log both success and failure cases

### For Users
1. Enable debug logging when reproducing issues
2. Note the exact time when issues occur
3. Export logs soon after issues happen
4. Include system information when reporting

## Integration with Test Runner

The test runner automatically logs:
- Test execution start/end
- Test results (pass/fail)
- Detailed error information with stack traces
- Troubleshooting hints for common failures

Failed tests will include enhanced error information in the logs to help diagnose issues.

## Future Enhancements

Planned improvements:
- Log analytics dashboard
- Automatic error reporting (opt-in)
- Log compression for long-term storage
- Integration with external logging services
- Performance profiling from logs 