# Central Logging System - Complete Guide

## 📋 Overview

The Onereach app now has a **comprehensive central event logging system** that captures ALL application events in a single location.

---

## 📁 **Log File Location**

```
~/Library/Application Support/Onereach.ai/logs/
```

**Current Log File:**
```
onereach-2025-10-25T16-41-40.log
```

**Log Files Are:**
- ✅ **JSON formatted** - One event per line
- ✅ **Auto-rotated** - New file every 10MB
- ✅ **Auto-cleaned** - Keeps last 5 log files
- ✅ **Auto-flushed** - Saves every 5 seconds
- ✅ **Searchable** - Easy to grep/filter

---

## 🎯 **What Gets Logged**

### **1. Application Lifecycle**
```json
{
  "timestamp": "2025-10-25T16:41:40.123Z",
  "level": "INFO",
  "message": "App Launched",
  "event": "app:launch",
  "version": "1.0.8",
  "platform": "darwin",
  "arch": "arm64"
}
```

```json
{
  "timestamp": "2025-10-25T16:41:45.456Z",
  "level": "INFO",
  "message": "App Ready",
  "event": "app:ready",
  "uptime": 5.332
}
```

```json
{
  "timestamp": "2025-10-25T18:30:15.789Z",
  "level": "INFO",
  "message": "App Quit",
  "event": "app:quit",
  "reason": "user-initiated",
  "uptime": 6435.123
}
```

### **2. Window Management**
```json
{
  "timestamp": "2025-10-25T16:41:46.100Z",
  "level": "INFO",
  "message": "Window Created",
  "event": "window:created",
  "windowType": "main-window",
  "windowId": "main",
  "bounds": {"width": 1400, "height": 900}
}
```

```json
{
  "timestamp": "2025-10-25T16:42:10.234Z",
  "level": "INFO",
  "message": "Window Created",
  "event": "window:created",
  "windowType": "gsx-window",
  "windowId": "Studio",
  "url": "https://studio.edison.onereach.ai",
  "environment": "edison"
}
```

```json
{
  "timestamp": "2025-10-25T18:25:30.567Z",
  "level": "INFO",
  "message": "Window Closed",
  "event": "window:closed",
  "windowType": "main-window",
  "windowId": "main"
}
```

### **3. Tab Management** 
```json
{
  "timestamp": "2025-10-25T16:45:20.100Z",
  "level": "INFO",
  "message": "Tab Created",
  "event": "tab:created",
  "tabId": "tab-12",
  "url": "https://idw.edison.onereach.ai/myidw"
}
```

```json
{
  "timestamp": "2025-10-25T16:50:15.234Z",
  "level": "INFO",
  "message": "Tab Switched",
  "event": "tab:switched",
  "from": "tab-12",
  "to": "tab-15"
}
```

```json
{
  "timestamp": "2025-10-25T17:05:45.567Z",
  "level": "INFO",
  "message": "Tab Closed",
  "event": "tab:closed",
  "tabId": "tab-12",
  "url": "https://idw.edison.onereach.ai/myidw"
}
```

### **4. Menu & User Actions**
```json
{
  "timestamp": "2025-10-25T16:48:30.123Z",
  "level": "INFO",
  "message": "Menu Action",
  "event": "menu:action",
  "menuItem": "open-settings"
}
```

```json
{
  "timestamp": "2025-10-25T16:48:35.456Z",
  "level": "INFO",
  "message": "User Action",
  "action": "click-button",
  "details": {"button": "complete-backup"}
}
```

### **5. Settings Changes**
```json
{
  "timestamp": "2025-10-25T16:49:00.789Z",
  "level": "INFO",
  "message": "Settings Changed",
  "event": "settings:changed",
  "setting": "gsxToken",
  "oldValue": "***",
  "newValue": "***"
}
```

```json
{
  "timestamp": "2025-10-25T16:49:01.100Z",
  "level": "INFO",
  "message": "Settings saved",
  "event": "settings:saved",
  "settingsCount": 8
}
```

### **6. GSX Backup Events**
```json
{
  "timestamp": "2025-10-25T17:00:15.123Z",
  "level": "INFO",
  "message": "GSX Backup Completed",
  "type": "complete-backup",
  "filesCount": 156,
  "totalSize": "45.2 MB",
  "duration": "2m 34s",
  "results": [
    {
      "name": "OR-Spaces",
      "files": 112,
      "size": "42.1 MB",
      "path": "Complete-Backup/OR-Spaces"
    },
    {
      "name": "App-Config",
      "files": 44,
      "size": "3.1 MB",
      "path": "Complete-Backup/App-Config"
    }
  ]
}
```

### **7. Feature Usage**
```json
{
  "timestamp": "2025-10-25T16:41:47.234Z",
  "level": "INFO",
  "message": "Feature Used",
  "event": "feature:used",
  "feature": "clipboard-manager",
  "status": "initialized"
}
```

### **8. File Operations**
```json
{
  "timestamp": "2025-10-25T16:55:30.456Z",
  "level": "INFO",
  "message": "File Operation",
  "event": "file:operation",
  "operation": "download",
  "filePath": "/Users/user/Downloads/document.pdf",
  "size": "2.3 MB"
}
```

### **9. Clipboard Operations**
```json
{
  "timestamp": "2025-10-25T17:10:20.789Z",
  "level": "INFO",
  "message": "Clipboard Operation",
  "event": "clipboard:operation",
  "operation": "copy",
  "itemType": "text",
  "size": 245
}
```

### **10. Network & API Calls**
```json
{
  "timestamp": "2025-10-25T17:15:45.123Z",
  "level": "INFO",
  "message": "Network Request",
  "event": "network:request",
  "method": "POST",
  "url": "https://files.edison.onereach.ai/upload",
  "statusCode": 200,
  "duration": 1234
}
```

### **11. Errors & Exceptions**
```json
{
  "timestamp": "2025-10-25T17:20:10.456Z",
  "level": "ERROR",
  "message": "API Error",
  "event": "api:error",
  "endpoint": "/api/sync",
  "error": "Connection timeout"
}
```

### **12. All Console Output**
```json
{
  "timestamp": "2025-10-25T16:42:00.123Z",
  "level": "INFO",
  "message": "[Console.log] User clicked complete backup button",
  "process": "renderer",
  "window": "Settings",
  "consoleMethod": "log"
}
```

---

## 🔍 **How to View Logs**

### **Via Terminal:**

```bash
# View live logs
tail -f ~/Library/Application\ Support/Onereach.ai/logs/*.log

# View specific events
tail -f ~/Library/Application\ Support/Onereach.ai/logs/*.log | grep "window:created"
tail -f ~/Library/Application\ Support/Onereach.ai/logs/*.log | grep "tab:created"
tail -f ~/Library/Application\ Support/Onereach.ai/logs/*.log | grep "GSX Backup"

# View all app launches
cat ~/Library/Application\ Support/Onereach.ai/logs/*.log | grep "app:launch"

# View all errors
cat ~/Library/Application\ Support/Onereach.ai/logs/*.log | grep "ERROR"
```

### **Via Log Viewer (In App):**

1. Press `Cmd+Alt+H` to show test menu
2. Help → 📋 Event Log Viewer
3. Or shortcut: `Cmd+Shift+L`

---

## 📊 **Event Types Reference**

### Application Lifecycle
- `app:launch` - App started
- `app:ready` - App ready to use
- `app:quit` - App shutting down

### Window Events
- `window:created` - New window opened
- `window:closed` - Window closed
- `window:focused` - Window got focus
- `window:navigation` - Window navigated to URL

### Tab Events
- `tab:created` - New tab created
- `tab:closed` - Tab closed
- `tab:switched` - User switched tabs

### User Actions
- `menu:action` - Menu item clicked
- `settings:changed` - Setting modified
- `settings:saved` - Settings saved
- `feature:used` - Feature activated

### File & Clipboard
- `file:operation` - File downloaded/saved/opened
- `clipboard:operation` - Clipboard item copied/pasted

### Network & API
- `network:request` - HTTP request made
- `api:error` - API call failed

### GSX Operations
- Custom events for all GSX sync operations

---

## 🛠️ **Using the Logger in Code**

### **Main Process (Node.js):**

```javascript
const getLogger = require('./event-logger');
const logger = getLogger();

// Application events
logger.logAppLaunch();
logger.logAppReady();
logger.logAppQuit('user-quit');

// Window events
logger.logWindowCreated('main', windowId, { url: 'index.html' });
logger.logWindowClosed('settings', windowId);

// Tab events
logger.logTabCreated(tabId, url, { source: 'menu-action' });
logger.logTabSwitched(fromTabId, toTabId);
logger.logTabClosed(tabId, url);

// User actions
logger.logUserAction('button-click', { button: 'sync-now' });
logger.logMenuAction('file-sync', { action: 'complete-backup' });

// Settings
logger.logSettingsChanged('theme', 'dark', 'light');

// Feature usage
logger.logFeatureUsed('clipboard-manager', { action: 'initialized' });

// File operations
logger.logFileOperation('download', filePath, { size: '2.3 MB' });

// Network
logger.logNetworkRequest('POST', url, 200, 1234);

// Generic logging
logger.info('Custom message', { key: 'value' });
logger.warn('Warning message', { details: 'something' });
logger.error('Error occurred', { error: 'message' });
logger.debug('Debug info', { data: 'value' });
```

### **Renderer Process (Browser):**

```javascript
// Via IPC (automatically exposed in preload.js)
window.api.logTabCreated(tabId, url, { source: 'user' });
window.api.logTabClosed(tabId, url);
window.api.logTabSwitched(fromTab, toTab);
window.api.logWindowNavigation(windowId, url, from);
window.api.logFeatureUsed('feature-name', { metadata });
window.api.logEvent('custom:event', { data });

// Console output is automatically captured
console.log('This gets logged automatically');
console.error('Errors are captured too');
```

---

## 🔒 **Privacy & Security**

### **What's Hidden:**
- ✅ **Tokens/API keys** - Shown as `***`
- ✅ **Passwords** - Never logged
- ✅ **Sensitive settings** - Masked

### **What's Included:**
- ✅ Event types and counts
- ✅ File sizes (not content)
- ✅ URLs visited
- ✅ Performance metrics
- ✅ Error messages

---

## 📈 **Log Statistics**

### **Automatic Metrics:**

The logger tracks:
- Total events logged
- Events per type
- Errors vs successful operations
- Performance timings
- Uptime and usage patterns

### **Example Analysis:**

```bash
# Count events by type
cat ~/Library/Application\ Support/Onereach.ai/logs/*.log | jq -r '.event' | sort | uniq -c

# Find slow operations
cat ~/Library/Application\ Support/Onereach.ai/logs/*.log | jq 'select(.duration > 5000)'

# Today's errors
cat ~/Library/Application\ Support/Onereach.ai/logs/*.log | jq 'select(.level == "ERROR")'
```

---

## 🎯 **Event Categories**

| Category | Events | Purpose |
|----------|--------|---------|
| **Lifecycle** | app:launch, app:ready, app:quit | App state tracking |
| **Windows** | window:created, window:closed, window:focused | Window management |
| **Tabs** | tab:created, tab:closed, tab:switched | Tab navigation |
| **User** | menu:action, user:action, feature:used | User interactions |
| **Settings** | settings:changed, settings:saved | Configuration tracking |
| **Files** | file:operation, clipboard:operation | File & clipboard ops |
| **Network** | network:request, api:error | Network activity |
| **GSX** | Custom GSX events | Sync operations |
| **Modules** | module:installed, module:loaded | Module management |

---

## 🚀 **Benefits**

### **For Debugging:**
- 🔍 See exact sequence of events
- 🔍 Understand what happened before an error
- 🔍 Track down intermittent issues
- 🔍 Replay user actions

### **For Analytics:**
- 📊 Most used features
- 📊 Common user workflows
- 📊 Performance bottlenecks
- 📊 Error frequencies

### **For Support:**
- 🆘 Users can share logs
- 🆘 Recreate issues from logs
- 🆘 Understand user's environment
- 🆘 Verify fix effectiveness

---

## 📝 **Log Format**

Every log entry is a JSON object:

```json
{
  "timestamp": "2025-10-25T16:41:40.123Z",  // ISO 8601 timestamp
  "level": "INFO",                          // DEBUG, INFO, WARN, ERROR
  "message": "Human readable message",       // What happened
  "event": "event:type",                    // Event category
  // ... additional event-specific fields
}
```

---

## 🔧 **Configuration**

### **Log Levels:**
- `DEBUG` - Everything (verbose)
- `INFO` - Normal operations (default)
- `WARN` - Warnings
- `ERROR` - Errors only

### **Settings:**
- **Max log file size:** 10 MB
- **Max log files:** 5 (rotates automatically)
- **Flush interval:** 5 seconds
- **Error flush:** Immediate

---

## 📚 **Common Use Cases**

### **Find When App Was Last Launched:**
```bash
cat ~/Library/Application\ Support/Onereach.ai/logs/*.log | grep "app:launch" | tail -1
```

### **See All Windows Opened:**
```bash
cat ~/Library/Application\ Support/Onereach.ai/logs/*.log | grep "window:created"
```

### **Track Tab Activity:**
```bash
cat ~/Library/Application\ Support/Onereach.ai/logs/*.log | grep "tab:"
```

### **View GSX Backups:**
```bash
cat ~/Library/Application\ Support/Onereach.ai/logs/*.log | grep "GSX Backup"
```

### **Find All Errors:**
```bash
cat ~/Library/Application\ Support/Onereach.ai/logs/*.log | grep "ERROR"
```

### **Export Today's Logs:**
```bash
cat ~/Library/Application\ Support/Onereach.ai/logs/*.log | \
  jq 'select(.timestamp >= "2025-10-25")' > today-logs.json
```

---

## 🎨 **Log Viewer Features**

The built-in log viewer provides:
- Real-time log streaming
- Filter by level (Debug/Info/Warn/Error)
- Search functionality
- Export to file
- Clear formatting
- Auto-scroll

Access via:
- Shortcut: `Cmd+Shift+L`
- Menu: Help → Event Log Viewer

---

## 🔍 **Troubleshooting**

### **Logs Not Appearing:**
- Check directory exists: `~/Library/Application Support/Onereach.ai/logs/`
- Check file permissions
- Try restarting the app

### **Too Many Logs:**
- Increase `maxLogFiles` in event-logger.js
- Increase `maxLogSize` for larger files
- Adjust log level to reduce verbosity

### **Missing Events:**
- Ensure feature code calls logger methods
- Check IPC handlers are set up
- Verify logger is initialized

---

## 📦 **What's Logged in This Version (1.0.8)**

✅ App launch, ready, quit  
✅ Main window creation & closing  
✅ GSX window creation  
✅ Tab creation, switching, closing (via IPC from renderer)  
✅ Menu actions  
✅ Settings changes  
✅ Feature initialization  
✅ GSX backup operations with detailed reports  
✅ User actions  
✅ All console output (automatically)  
✅ Errors and exceptions  

---

## 🎯 **Event Summary**

Every significant action in the app is now logged:
- **When** it happened (timestamp)
- **What** happened (event type)
- **Where** it happened (window/tab)
- **How** it happened (user action, auto, etc.)
- **Result** (success/failure)
- **Details** (sizes, durations, etc.)

**The central logging system provides complete visibility into all application activity!** 📊

---

## 🔗 **Integration**

The logging system is integrated with:
- ✅ Main process (main.js)
- ✅ Browser window management (browserWindow.js)
- ✅ Settings manager (settings-manager.js)
- ✅ GSX File Sync (gsx-file-sync.js)
- ✅ Clipboard manager
- ✅ Module manager
- ✅ All renderer processes (via IPC)
- ✅ Console output (automatic capture)

**One central log file captures everything!** 🎉
