# Setup Wizard Test Suite

This test suite provides comprehensive testing for the Setup Wizard functionality in the Onereach.ai desktop application.

## Overview

The test suite validates:
- ✅ Creating new IDW environments
- ✅ Editing existing environments
- ✅ Menu updates after changes
- ✅ File persistence
- ✅ IPC communication between renderer and main process
- ✅ Data serialization and deserialization

## Running the Tests

### Basic Test Run
```bash
npm run test:wizard
```

### Debug Mode (shows DevTools)
```bash
DEBUG_TESTS=1 npm run test:wizard
```

### Run Specific Tests
You can configure which tests to run by editing the `TEST_CONFIG` object in `setup-wizard-test-suite.js`:

```javascript
scenarios: {
  createNew: true,      // Test creating new environments
  editExisting: true,   // Test editing existing environments
  deleteExisting: true, // Test deleting environments (not implemented yet)
  menuUpdates: true,    // Test menu updates
  filePersistence: true,// Test file persistence
  ipcCommunication: true// Test IPC communication
}
```

## Test Output

The test suite provides:
1. **Console Output**: Real-time test progress with color-coded results
2. **JSON Report**: Detailed test report saved to `test/test-report-{timestamp}.json`

### Console Output Example
```
[2024-06-14T10:30:00.000Z] 🧪 Starting Setup Wizard Test Suite
[2024-06-14T10:30:00.100Z] 📘 Setting up test environment...
[2024-06-14T10:30:00.200Z] ✅ Test environment setup: PASSED
[2024-06-14T10:30:01.000Z] ✅ Edit existing environment: PASSED - Edited environment successfully
[2024-06-14T10:30:02.000Z] ✅ Menu updates: PASSED - Found 3 environment items in menu
```

## Test Data

The test suite:
- **Backs up** your existing configuration before running
- **Restores** your configuration after tests complete
- Uses isolated test data that doesn't affect your production setup

## Troubleshooting

### Tests Failing
1. Check the console output for specific error messages
2. Run in debug mode to see the DevTools console
3. Check the JSON report for detailed error information

### Common Issues
- **"Add button not found"**: The UI might have changed. Check selector in test code.
- **"IPC timeout"**: The main process handlers might not be set up correctly.
- **"File not found"**: Check file permissions in the user data directory.

## Extending the Tests

To add new tests:

1. Add a new test function:
```javascript
async function testNewFeature(window) {
  log('Testing: New Feature', 'test');
  
  return new Promise((resolve) => {
    window.webContents.executeJavaScript(`
      // Your test code here
    `).then(result => {
      addTestResult('New Feature', result.success, result.message);
      resolve(result.success);
    });
  });
}
```

2. Call it in `runAllTests()`:
```javascript
if (TEST_CONFIG.scenarios.newFeature) {
  await testNewFeature(setupWizardWindow);
}
```

3. Add configuration option:
```javascript
scenarios: {
  // ... existing scenarios
  newFeature: true
}
```

## CI/CD Integration

The test suite exits with:
- **Exit code 0**: All tests passed
- **Exit code 1**: One or more tests failed

This makes it suitable for CI/CD pipelines.

## Maintenance

- Keep the test suite updated when UI changes are made
- Review test reports regularly to catch regressions early
- Add new tests for new features 