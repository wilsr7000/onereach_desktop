# Integrated Test Runner Guide

## Overview
The Onereach.ai app now includes an integrated test runner that allows you to run automated tests and maintain manual test checklists directly within the app.

## Accessing the Test Runner

### Via Hidden Menu
1. First, activate the test menu by pressing `Cmd+Alt+H` (Mac) or `Ctrl+Alt+H` (Windows)
2. You'll see a notification: "Test menu activated"
3. Go to Help menu → 🧬 Integrated Test Runner
4. Or use the keyboard shortcut: `Cmd+Shift+T` (Mac) or `Ctrl+Shift+T` (Windows)

### Features

#### 1. Automated Tests Tab
- **Core Functionality**: Tests clipboard monitoring, source detection, search
- **Spaces Management**: Tests space creation, item movement, deletion
- **Settings & Storage**: Tests settings persistence and API encryption
- **IDW Management**: Tests IDW environment listing and management
- **External AI Integration**: Tests external AI bots and image creators
- **AI Insights**: Tests RSS feed API and reading log storage
- **Export & Smart Export**: Tests template availability and style guides
- **Performance**: Tests search speed and memory usage

#### 2. Manual Checklist Tab
- **Visual & UX**: UI appearance, animations, window resizing
- **OS Integration**: Drag & drop, system tray, notifications
- **IDW & AI Manual Tests**: IDW navigation, external AI launch, GSX tools, setup wizard
- **AI Insights Manual Tests**: Article loading, reading time, progress tracking
- Each item can be checked off and includes a notes feature
- Progress is automatically saved

#### 3. Test History Tab
- View previous test runs
- Shows pass/fail statistics
- Keeps last 100 test runs

### Running Tests

#### Automated Tests
1. Select tests by checking the boxes (or press Ctrl+A to select all)
2. Click "Run Selected Tests" or "Run All Tests"
3. Watch the progress bar and live log
4. View results summary when complete

#### Manual Tests
1. Check off tests as you complete them
2. Click "Notes" to add detailed observations
3. All progress is automatically saved
4. Background color changes to indicate completed items

### Test Results

#### Saving Results
- Click "Save Results" to store test run data
- Results are saved in JSON format with timestamps

#### Exporting Reports
- Click "Export Report" to generate a Markdown report
- Includes summary statistics, detailed logs, and system info
- Useful for documentation or sharing results

### Test Data Storage

Test data is stored in the app's user data directory:
- **Test Results**: `test-results.json`
- **Test History**: `test-history.json`
- **Manual Test Notes**: `manual-test-notes.json`
- **Manual Test Status**: `manual-test-status.json`

### Writing New Tests

To add new automated tests, edit `test-runner.js`:

```javascript
this.tests.set('my-new-test', {
    name: 'My New Test',
    category: 'core',
    async run() {
        // Test implementation
        if (testPassed) {
            return { success: true, message: 'Test passed!' };
        } else {
            throw new Error('Test failed: reason');
        }
    }
});
```

### Keyboard Shortcuts

- `Cmd/Ctrl+Alt+H`: Toggle test menu visibility
- `Cmd/Ctrl+Shift+T`: Open test runner
- `Cmd/Ctrl+A`: Select all tests (when test runner is focused)

### Best Practices

1. Run automated tests after major changes
2. Use manual checklists for UI/UX testing
3. Export reports for version releases
4. Add notes for failed tests to track issues
5. Keep test history for regression tracking

### Troubleshooting

If tests fail to run:
1. Check the browser console for errors
2. Ensure the app has necessary permissions
3. Verify clipboard access is enabled
4. Check that settings are properly configured

### Security Note

The test runner has access to app internals and clipboard. It's hidden by default for security. Only activate when needed for testing.

### Complete Test Coverage

The integrated test runner now covers all major features of the Onereach.ai app:

**Automated Tests (19 total):**
- Clipboard operations (4 tests)
- Space management (3 tests)  
- Settings (2 tests)
- IDW management (2 tests)
- External AI integration (2 tests)
- AI Insights/RSS (2 tests)
- Export features (2 tests)
- Performance (2 tests)

**Manual Tests (10+ categories):**
- Visual design & UX
- OS integration features
- IDW navigation & authentication
- External AI launch verification
- GSX tools functionality
- AI Insights article reading
- Setup wizard operations
- Export preview & generation

This comprehensive test suite ensures all features work correctly across updates. 