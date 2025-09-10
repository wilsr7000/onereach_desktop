# IDW Automated Tests

This document describes the automated tests for IDW (Intelligent Digital Worker) management in the OneReach.ai application.

## Overview

The IDW automated tests verify the complete lifecycle of IDW environment management:
- Listing existing IDW environments
- Adding new IDW environments
- Editing existing IDW environments
- Removing IDW environments
- Verifying IDW navigation menu
- Checking GSX links generation

## Test Details

### 1. Get IDW Environments (`get-idw-list`)
- **Purpose**: Retrieves and validates the list of configured IDW environments
- **Validation**: Ensures the API returns a proper array and logs all environments
- **Expected**: Array of IDW environments with label and environment properties

### 2. Add IDW Environment (`add-idw`)
- **Purpose**: Tests automated addition of a new IDW environment
- **Process**:
  - Creates a test IDW with timestamp-based unique ID
  - Adds to localStorage
  - Saves via IPC to persist
  - Verifies addition was successful
- **Test Data**:
  ```javascript
  {
    id: 'test-idw-{timestamp}',
    type: 'idw',
    homeUrl: 'https://idw.edison.onereach.ai/test-automation',
    chatUrl: 'https://idw.edison.onereach.ai/chat/test-automation-chat',
    gsxAccountId: '05bd3c92-5d3c-4dc5-a95d-0c584695cea4',
    environment: 'edison',
    label: 'test-automation-{timestamp}'
  }
  ```

### 3. Edit IDW Environment (`edit-idw`)
- **Purpose**: Tests automated editing of an existing IDW
- **Process**:
  - Finds IDW to edit (prefers test IDW from add test)
  - Modifies label, chat URL, and GSX account ID
  - Saves changes
  - Verifies edits were applied
- **Changes Made**:
  - Label: Appends "-edited"
  - Chat URL: Adds "?edited=true" parameter
  - GSX Account ID: Changes to different test ID

### 4. Remove IDW Environment (`remove-idw`)
- **Purpose**: Tests automated removal of an IDW
- **Process**:
  - Finds IDW to remove (prefers test IDW)
  - If none exists, creates temporary IDW
  - Removes from environment list
  - Verifies removal was successful
- **Cleanup**: Removes test IDW created in add test

### 5. IDW Navigation & Menu (`idw-navigation`)
- **Purpose**: Verifies IDW navigation menu functionality
- **Validation**:
  - Checks if environments are accessible via API
  - Validates each environment has required properties (label, homeUrl, chatUrl)
  - Reports total number of environments in menu

### 6. IDW GSX Links Generation (`idw-gsx-links`)
- **Purpose**: Tests that GSX links are properly generated for each IDW
- **Expected Links per IDW**:
  - HITL
  - Action Desk
  - Designer
  - Tickets
  - Calendar
  - Developer
- **Validation**: Checks for missing links and reports totals

## Running the Tests

### Method 1: Using Test Runner UI
1. Open the application
2. Navigate to Help → Test Runner (or press Cmd/Ctrl+Shift+T)
3. In the "IDW Management" section, click individual "Run" buttons or select tests and click "Run Selected"

### Method 2: Command Line (Headless)
```bash
# Run all IDW tests
node test/run-idw-tests.js

# Or using npm script (if configured)
npm run test:idw
```

### Method 3: Programmatically
```javascript
// In test runner console
const idwTests = ['get-idw-list', 'add-idw', 'edit-idw', 'remove-idw', 'idw-navigation', 'idw-gsx-links'];
for (const test of idwTests) {
    await testRunner.runSingleTest(test);
}
```

## Test Data Used

The tests use existing IDW environments from the attached data, including:
- `marvin-2` (edison environment)
- `it-security-expert` (edison environment)
- `marketing-team` (edison environment)
- `bob_lawbla` (staging environment)

Test IDWs are created with timestamps to ensure uniqueness and are cleaned up after testing.

## Success Criteria

All tests should pass with:
- ✓ Proper API responses
- ✓ Successful CRUD operations
- ✓ Valid data structures
- ✓ Correct GSX link generation
- ✓ No orphaned test data

## Troubleshooting

If tests fail:
1. Check localStorage for corrupted IDW data
2. Verify IPC handlers are registered in main.js
3. Ensure test has proper permissions to modify localStorage
4. Check console logs for detailed error messages

## Integration with CI/CD

These tests can be integrated into CI/CD pipelines:
```yaml
# Example GitHub Actions
- name: Run IDW Tests
  run: |
    npm run test:idw
    if [ $? -ne 0 ]; then
      echo "IDW tests failed"
      exit 1
    fi
``` 