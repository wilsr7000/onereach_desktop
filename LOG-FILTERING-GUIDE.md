# Event Log Viewer - Enhanced Filtering Guide

## Overview

The Event Log Viewer now includes advanced filtering options to help you quickly find and analyze logs from specific sources, windows, and functions.

## Filter Options

### 1. **Level Filter**
Filter logs by severity level:
- **Debug**: Detailed debugging information
- **Info**: General informational messages
- **Warn**: Warning messages
- **Error**: Error messages

Click the level buttons to toggle them on/off. Active levels are highlighted.

### 2. **Source Filter**
Filter by where the log originated:
- **All Sources**: Show all logs
- **Main Process**: Logs from the Electron main process
- **Renderer**: Logs from renderer processes (web pages)

### 3. **Window Filter**
Filter by specific window or component:
- Automatically populated with all unique windows found in logs
- Examples: "Main Window", "Settings", "Log Viewer", "Console.log", etc.

### 4. **Function Filter**
Filter by specific function or operation:
- Automatically populated with function names extracted from log messages
- Includes:
  - IPC channel names (e.g., "logger:get-recent-logs")
  - Console methods (e.g., "Console.log", "Console.error")
  - Function names from error messages
  - Event names

### 5. **Search**
Free-text search across all log content:
- Searches in message text and all log data
- Case-insensitive
- Press Enter or click Search button

## Visual Indicators

Each log entry displays contextual badges:

- **Source Badge**: 
  - 🟦 Blue: Window-specific logs
  - 🟩 Green: Renderer process
  - 🟧 Orange: Main process

- **Function Badge**:
  - 🟪 Purple: Shows the function/method that generated the log

## Usage Examples

### Finding Errors in a Specific Window
1. Set Level filter to only "Error"
2. Select the window from the Window dropdown
3. View all errors from that specific window

### Tracking IPC Communication
1. Set Function filter to an IPC channel (e.g., "logger:get-recent-logs")
2. See all logs related to that IPC channel

### Debugging Console Output
1. Set Window filter to "Console.log" or "Console.error"
2. See all console output from the application

### Finding Background Process Logs
1. Set Source filter to "Main Process"
2. Optionally filter by specific function names

## Auto-Refresh

The log viewer automatically refreshes every 5 seconds when the "Auto-refresh" checkbox is enabled. Disable it when analyzing specific logs to prevent the view from updating.

## Exporting Filtered Logs

The export function respects your current filters, allowing you to export only the logs you're interested in:

1. Apply your desired filters
2. Click "Export Logs"
3. Choose time range and format
4. The exported file will contain only the filtered logs 