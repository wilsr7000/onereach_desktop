# Event Log Viewer Troubleshooting

## Error: "Failed to load logs"

If you're seeing this error in the Event Log Viewer, follow these steps:

### 1. Restart the Application

The most common cause is that the application needs to be restarted after the logging system was added:

1. **Completely quit the application** (not just close the window)
   - On macOS: Cmd+Q or right-click dock icon → Quit
   - On Windows: Close all windows and check system tray
   
2. **Start the application again**

3. **Wait a few seconds** for the logger to initialize

4. **Try opening the Event Log Viewer again**

### 2. Check Developer Console

Open the developer console to see more detailed error messages:

1. Press `Cmd+Option+I` (Mac) or `Ctrl+Shift+I` (Windows)
2. Look for any error messages related to:
   - "Logger not initialized"
   - "IPC: logger:get-recent-logs"
   - File system errors

### 3. Verify Log Directory Exists

The logger stores files in your app data directory. Check if it exists:

**macOS:**
```bash
ls -la ~/Library/Application\ Support/onereach-ai/logs/
```

**Windows:**
```cmd
dir %APPDATA%\onereach-ai\logs
```

If the directory doesn't exist, create it manually:

**macOS:**
```bash
mkdir -p ~/Library/Application\ Support/onereach-ai/logs/
```

**Windows:**
```cmd
mkdir %APPDATA%\onereach-ai\logs
```

### 4. Check File Permissions

Ensure the app has permission to write to the logs directory:

**macOS:**
```bash
chmod 755 ~/Library/Application\ Support/onereach-ai/logs/
```

### 5. Clear and Regenerate Logs

If logs are corrupted, try clearing them:

1. Navigate to the logs directory (see step 3)
2. Delete all `.log` files
3. Restart the application
4. The logger will create new log files

### 6. Test Logger Functionality

After restarting, you should see initial log entries:
- "Logger initialized"
- "Application starting"
- "Main window created"
- Test log entries

### 7. Alternative Access

If the integrated log viewer in the test runner isn't working, try:

1. **Standalone Log Viewer**: Press `Cmd+Shift+L` (Mac) or `Ctrl+Shift+L` (Windows)
2. **Direct File Access**: Open log files directly from the logs directory with a text editor

### Common Issues and Solutions

#### Issue: "Logger not initialized" error
**Solution**: The app needs to be fully restarted. Make sure to quit completely, not just close windows.

#### Issue: No log files are created
**Solution**: 
- Check disk space
- Verify write permissions
- Try running the app as administrator (Windows)

#### Issue: Log viewer shows empty even with log files present
**Solution**:
- Check if log files contain valid JSON entries
- Look for parsing errors in the console
- Try deleting corrupted log files

### Debug Information

When reporting this issue, please provide:

1. **OS Version**: (e.g., macOS 14.0, Windows 11)
2. **App Version**: (found in About menu)
3. **Console Errors**: Copy any red error messages from developer console
4. **Log Directory Contents**: List of files in the logs directory
5. **Sample Log Entry**: First few lines of a log file (if any exist)

### Emergency Logging

If the logger completely fails, the app will fall back to console logging. Check the developer console for log entries prefixed with:
- `[INFO]`
- `[WARN]`
- `[ERROR]`
- `[DEBUG]`

These console logs can help diagnose why the file-based logger isn't working. 