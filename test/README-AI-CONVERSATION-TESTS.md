# AI Conversation Capture Tests

## Overview

Automated end-to-end tests for the AI conversation capture feature that validates:
- Conversation capture across multiple AI services (Claude, ChatGPT, Gemini, Grok, Perplexity)
- Automatic saving to Spaces with proper formatting
- Privacy controls (pause, do not save, undo)
- Multi-service space separation
- Markdown formatting for readability in Spaces Manager

## Test File

`test/e2e/ai-conversation-capture.spec.js`

## Running Tests

### Full Test Suite

```bash
npm run test:e2e -- ai-conversation-capture.spec.js
```

### Specific Test Suite

```bash
# Claude conversation tests only
npx playwright test test/e2e/ai-conversation-capture.spec.js --grep "Conversation Capture - Claude"

# Multi-service tests
npx playwright test test/e2e/ai-conversation-capture.spec.js --grep "Multi-Service"

# Formatting validation
npx playwright test test/e2e/ai-conversation-capture.spec.js --grep "Formatting Validation"
```

### Debug Mode

```bash
# Run with Playwright Inspector
PWDEBUG=1 npx playwright test test/e2e/ai-conversation-capture.spec.js

# Run headed (visible browser)
npx playwright test test/e2e/ai-conversation-capture.spec.js --headed
```

## Prerequisites

### 1. Install Playwright

```bash
npm install --save-dev @playwright/test
npx playwright install
```

### 2. Enable Test Mode IPC Handlers

The test suite requires special IPC handlers in `main.js`. These are added in the "Test Support" section:

```javascript
// Test Support - IPC handlers for automated testing
if (process.env.NODE_ENV === 'test' || process.env.TEST_MODE === 'true') {
  // conversation:test-capture - Simulate conversation capture for testing
  ipcMain.handle('conversation:test-capture', async (event, data) => {
    // Implementation in main.js
  });
  
  // conversation:isPaused - Check pause state
  ipcMain.handle('conversation:isPaused', async () => {
    // Implementation in main.js
  });
}
```

### 3. AI Service Credentials (Optional)

For full integration tests that interact with real AI services:

1. Create `.env.test` with credentials:
```
CLAUDE_SESSION_TOKEN=your_token
CHATGPT_SESSION_TOKEN=your_token
# etc.
```

2. The test suite can run without credentials by using simulated captures.

## Test Structure

### Test Suites

1. **Conversation Capture - Claude**
   - Opens Claude in external window
   - Verifies AI overlay injection
   - Tests conversation capture and saving
   - Validates Space creation
   - Tests formatting for readability
   - Tests privacy controls (pause, resume, do not save)
   - Tests undo functionality

2. **Multi-Service Capture**
   - Tests all AI services (ChatGPT, Gemini, Grok, Perplexity)
   - Verifies separate Spaces for each service
   - Validates conversation isolation

3. **Formatting Validation**
   - Code block preservation
   - Long conversation handling
   - Special characters and emoji
   - Markdown readability

4. **Cleanup**
   - Removes test data after run

### Key Test Cases

#### ✅ Space Creation
- Verifies service-specific Spaces are created automatically
- Validates Space metadata (name, icon, color)

#### ✅ Conversation Capture
- Captures user prompts and AI responses
- Maintains conversation context
- Stores metadata (model, timestamp, exchange count)

#### ✅ Markdown Formatting
```markdown
# 🤖 Conversation with Claude

**Started:** 1/17/2026, 2:30:00 PM
**Model:** claude-3-5-sonnet
**Exchanges:** 1

---

### 👤 You
*2:30:00 PM*

Hello, this is a test message.

---

### 🤖 Claude
*2:30:05 PM*

This is a test response.

---

<sub>Conversation ID: conv-1234567890</sub>
```

#### ✅ Privacy Controls
- **Pause**: Stops all conversation capture
- **Do Not Save**: Excludes current conversation only
- **Undo**: Removes saved conversation within time window

#### ✅ Multi-Service Isolation
- Each AI service gets its own Space
- Conversations are never mixed between services
- Metadata correctly identifies source service

## Expected Results

### Successful Test Run

```
✓ should open Claude in external window
✓ should show AI overlay in Claude window
✓ should show "Recording" status by default
✓ should create Claude Conversations space
✓ should capture and save conversation to Space
✓ should format conversation properly for Spaces Manager
✓ should pause conversation capture
✓ should resume conversation capture
✓ should mark conversation as "do not save"
✓ should show undo toast after saving
✓ should undo conversation save
✓ should create separate spaces for each AI service
✓ should keep conversations separate by service
✓ should format code blocks properly
✓ should handle long conversations
✓ should handle special characters and emoji
✓ should clean up test data

17 passed (45s)
```

## Troubleshooting

### Test Fails: "Cannot find overlay"

The AI window overlay may not have loaded. Ensure:
1. `src/ai-window-overlay.js` is being injected via preload
2. Window has loaded completely before checking for overlay
3. Test timeout is sufficient (default 60s)

### Test Fails: "Space not created"

The Spaces API may not be initialized. Verify:
1. Spaces API is available via IPC
2. Settings have conversation capture enabled
3. No errors in main process logs

### Test Fails: "Conversation not saved"

Check:
1. Conversation capture is not paused
2. Conversation is not marked "do not save"
3. Spaces API save operation completed
4. Check logs for retry attempts and errors

### Playwright Not Launching Electron

Ensure:
```bash
npm install --save-dev playwright @playwright/test
export ELECTRON_ENABLE_LOGGING=1
```

## Continuous Integration

### GitHub Actions Example

```yaml
name: E2E Tests

on: [push, pull_request]

jobs:
  test:
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: 18
      - run: npm ci
      - run: npx playwright install
      - run: npm run test:e2e -- ai-conversation-capture.spec.js
      - uses: actions/upload-artifact@v3
        if: always()
        with:
          name: test-results
          path: test-results/
```

## Test Coverage

Current coverage:
- ✅ Claude conversation capture
- ✅ Multi-service capture (ChatGPT, Gemini, Grok, Perplexity)
- ✅ Space creation and isolation
- ✅ Markdown formatting
- ✅ Privacy controls (pause, do not save, undo)
- ✅ Special characters and emoji handling
- ✅ Code block preservation
- ✅ Long conversations

Not yet covered:
- ⏳ Real authentication flows (requires credentials)
- ⏳ Image and file attachments
- ⏳ Conversation timeout and finalization
- ⏳ Manual "Copy to Space" functionality
- ⏳ Settings UI integration
- ⏳ Error handling and retry logic

## Next Steps

1. **Add Real Service Integration**: 
   - Add authenticated tests with real AI services
   - Test actual DOM interactions (typing, clicking)

2. **Add Media Tests**:
   - Test image capture and saving
   - Test file attachment handling
   - Verify media is linked to conversations

3. **Add Performance Tests**:
   - Test with large conversations (100+ exchanges)
   - Test concurrent captures across multiple services
   - Memory leak detection

4. **Add Edge Case Tests**:
   - Network failures during save
   - App restart during active conversation
   - Corrupted conversation data

## Related Documentation

- `AI-CONVERSATION-QUICK-START.md` - User guide
- `AI-CONVERSATION-CAPTURE-COMPLETE.md` - Full feature documentation
- `src/ai-conversation-capture.js` - Main implementation
- `src/ai-window-overlay.js` - UI overlay component

## Support

For issues or questions:
1. Check main process logs: `~/Library/Logs/Onereach.ai/`
2. Check renderer process console in DevTools
3. Enable verbose logging: Set `DEBUG=true` in environment
4. Review failed test screenshots in `test-results/`
