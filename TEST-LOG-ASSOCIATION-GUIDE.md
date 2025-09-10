# Test Log Association Guide

## Overview

The OneReach.ai application now includes comprehensive test context tracking and log association features that automatically tag all logs generated during test execution with relevant test information.

## Key Features

### 1. **Automatic Test Context Tagging**

All logs generated during test execution are automatically enriched with:
- **Test ID**: Unique identifier for the test
- **Test Name**: Human-readable test name  
- **Test Category**: General category (core, auth, spaces, etc.)
- **Test Area**: Specific functional area being tested
- **Test Progress**: Current test index and total test count
- **Test Duration**: How long the test has been running

### 2. **Test Area Categorization**

Tests are organized into specific functional areas for better log filtering:

#### Core Functionality
- `clipboard-monitoring`: Clipboard text/image capture
- `content-classification`: Source type detection
- `search-indexing`: Search functionality
- `drag-drop-interface`: Drop zone widget

#### Authentication & APIs
- `authentication`: Google OAuth, login flows
- `ai-integration`: Claude, OpenAI connections
- `security`: API key encryption, data protection

#### Spaces Management
- `spaces-management`: Create, delete, move operations
- `spaces-filtering`: Space-based content filtering

#### Settings & Storage
- `settings-persistence`: Save/load settings
- `auto-updates`: Update checking system
- `backup-restore`: Rollback functionality

#### Export Features
- `export-functionality`: PDF, HTML, Markdown export
- `export-templates`: Template management

#### UI Components
- `ui-navigation`: Tab navigation
- `ui-components`: Modals, dropdowns
- `ui-feedback`: Notifications
- `ui-interaction`: Keyboard shortcuts
- `ui-theming`: Dark mode
- `ui-responsiveness`: Responsive design

#### File Handling
- `file-management`: Upload, download
- `file-preview`: Preview functionality
- `file-classification`: Type detection

#### AI Features
- `ai-content-generation`: Content creation
- `ai-summarization`: Summary generation
- `ai-translation`: Language translation
- `ai-suggestions`: Smart suggestions

#### Performance & Security
- `performance-monitoring`: Memory, startup time
- `performance-optimization`: Search speed
- `performance-scalability`: Large data handling
- `security-validation`: XSS, injection prevention
- `security-permissions`: Access control
- `security-privacy`: Data privacy

## Log Structure

### Test Context in Logs

When a test is running, all logs include a `testContext` object:

```json
{
  "timestamp": "2024-01-15T10:30:45.123Z",
  "level": "INFO",
  "message": "API Call successful",
  "window": "Test Runner",
  "testContext": {
    "testId": "clipboard-text",
    "testName": "Clipboard Text Monitoring",
    "testCategory": "core",
    "testArea": "clipboard-monitoring",
    "testIndex": 3,
    "totalTests": 25
  }
}
```

### Test-Specific Log Events

The test runner generates specific log events:

1. **Test Run Start**
   ```json
   {
     "message": "Test run started",
     "testArea": "test-runner",
     "action": "run-start",
     "testCount": 25,
     "testIds": ["clipboard-text", "api-auth", ...]
   }
   ```

2. **Individual Test Start**
   ```json
   {
     "message": "Test execution started",
     "testArea": "test-runner",
     "action": "test-start",
     "testId": "clipboard-text",
     "testName": "Clipboard Text Monitoring"
   }
   ```

3. **Test Pass/Fail**
   ```json
   {
     "message": "Test passed",
     "testArea": "test-runner",
     "action": "test-pass",
     "result": "Text clipboard monitoring works",
     "duration": 523
   }
   ```

4. **Test Run Complete**
   ```json
   {
     "message": "Test run completed",
     "testArea": "test-runner", 
     "action": "run-complete",
     "passed": 23,
     "failed": 2,
     "duration": 45
   }
   ```

## Using the Log Viewer

### Filtering by Test Area

1. Open the Event Log Viewer
2. Use the "Test Area" dropdown to filter logs by functional area
3. Select specific areas like "Clipboard Monitoring" or "AI Integration"

### Visual Indicators

Logs with test context show a special badge:
- **Blue badge**: Shows test progress (e.g., "Test 3/25: clipboard-monitoring")
- **Hover**: Reveals full test name

### Combining Filters

For precise log analysis, combine multiple filters:
- **Level**: Error only
- **Test Area**: AI Integration
- **Window**: Test Runner
- Shows only errors occurring during AI integration tests

## Best Practices

### 1. **Structured Logging in Tests**

When writing tests, use descriptive log messages:
```javascript
this.logger.info('Starting clipboard validation', {
    testStep: 'validation',
    expectedContent: testText,
    actualContent: clipboardContent
});
```

### 2. **Error Context**

Always include relevant context in error logs:
```javascript
this.logger.error('API connection failed', {
    endpoint: apiUrl,
    statusCode: response.status,
    errorMessage: error.message,
    retryCount: attempts
});
```

### 3. **Performance Tracking**

Log performance metrics for analysis:
```javascript
const startTime = Date.now();
// ... test operation ...
this.logger.info('Operation completed', {
    operation: 'clipboard-sync',
    duration: Date.now() - startTime,
    itemCount: items.length
});
```

## Troubleshooting

### Missing Test Context

If logs don't show test context:
1. Ensure the test runner is using the latest version
2. Check that `testContextManager` is properly initialized
3. Verify the event logger is running

### Filter Not Working

If test area filter shows no results:
1. Refresh the log viewer
2. Check that tests have been run recently
3. Verify logs are being written to disk

### Performance Issues

For large log volumes:
1. Use specific test area filters
2. Limit time range when exporting
3. Clear old log files periodically

## Integration with CI/CD

The test log association system supports automated testing:

1. **Export Test Logs**
   ```bash
   # Export only test-related logs
   npm run export-test-logs --area="clipboard-monitoring"
   ```

2. **Parse Test Results**
   - Filter logs by `testArea: "test-runner"`
   - Look for `action: "run-complete"` events
   - Extract pass/fail statistics

3. **Debug Failed Tests**
   - Filter by failed test ID
   - Review all logs with that test context
   - Identify the exact failure point

## Future Enhancements

Planned improvements include:
- Test execution timeline visualization
- Automatic error grouping by test area
- Performance regression detection
- Test flakiness analysis based on historical logs 