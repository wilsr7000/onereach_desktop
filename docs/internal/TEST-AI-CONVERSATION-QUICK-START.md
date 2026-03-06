# AI Conversation Capture - Test Quick Start

## 🚀 Run Tests in 3 Steps

### 1. Install Dependencies (One-time setup)

```bash
npm install
npm install --save-dev @playwright/test
npx playwright install
```

### 2. Run the Tests

```bash
# Quick run (recommended)
./test/run-ai-conversation-tests.sh

# Or using npm
npm run test:e2e:ai-conversation
```

### 3. View Results

Tests will automatically show results in the console. For detailed HTML report:

```bash
npx playwright show-report test-results/html
```

---

## 📋 Test Modes

### Standard Test Run
```bash
npm run test:e2e:ai-conversation
```

### Headed Mode (See Browser)
```bash
npm run test:e2e:ai-conversation:headed
# or
./test/run-ai-conversation-tests.sh --headed
```

### Debug Mode (Step Through)
```bash
npm run test:e2e:ai-conversation:debug
# or
./test/run-ai-conversation-tests.sh --debug
```

### Interactive UI Mode
```bash
./test/run-ai-conversation-tests.sh --ui
```

---

## ✅ What Gets Tested

### ✓ Core Features
- Opening AI services (Claude, ChatGPT, Gemini, Grok)
- AI overlay injection and visibility
- Conversation capture (prompts + responses)
- Automatic Space creation
- Markdown formatting for readability

### ✓ Privacy Controls
- Pause/Resume recording
- "Don't Save This" conversation exclusion
- Undo save within time window

### ✓ Multi-Service
- Separate Spaces per AI service
- Conversation isolation
- Correct metadata tagging

### ✓ Formatting
- Code block preservation
- Long conversations (100+ messages)
- Special characters and emoji
- Proper markdown structure

---

## 📊 Expected Output

```
AI Conversation Capture

  Conversation Capture - Claude
    ✓ should open Claude in external window (3s)
    ✓ should show AI overlay in Claude window (1s)
    ✓ should show "Recording" status by default (500ms)
    ✓ should create Claude Conversations space (2s)
    ✓ should capture and save conversation to Space (4s)
    ✓ should format conversation properly for Spaces Manager (1s)
    ✓ should pause conversation capture (500ms)
    ✓ should resume conversation capture (500ms)
    ✓ should mark conversation as "do not save" (500ms)
    ✓ should show undo toast after saving (2s)
    ✓ should undo conversation save (1s)

  Multi-Service Capture
    ✓ should create separate spaces for each AI service (5s)
    ✓ should keep conversations separate by service (2s)

  Formatting Validation
    ✓ should format code blocks properly (2s)
    ✓ should handle long conversations (3s)
    ✓ should handle special characters and emoji (2s)

  Cleanup
    ✓ should clean up test data (1s)

  17 passed (35s)
```

---

## 🔍 Troubleshooting

### Playwright Not Found
```bash
npm install --save-dev @playwright/test
npx playwright install
```

### Permission Denied on Script
```bash
chmod +x test/run-ai-conversation-tests.sh
```

### Tests Timeout
Edit `playwright.config.js`:
```javascript
timeout: 120 * 1000, // Increase to 2 minutes
```

### Can't Find Overlay
Check that `src/ai-window-overlay.js` is loaded via preload script. The overlay should auto-inject when AI services are opened.

### Spaces Not Created
Verify:
1. Spaces API is running (main process logs)
2. Settings have `aiConversationCapture.enabled: true`
3. No errors in console

---

## 📝 Test Configuration

Tests use simulated conversation capture rather than real AI interactions. This means:

- ✅ **No login required** - Tests work out of the box
- ✅ **Fast execution** - No waiting for AI responses
- ✅ **Reliable** - No network dependencies
- ✅ **Deterministic** - Same results every time

For **real integration testing** with actual AI services, see `test/README-AI-CONVERSATION-TESTS.md`.

---

## 🎯 CI/CD Integration

### GitHub Actions

```yaml
name: AI Conversation Tests

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
      - run: npm run test:e2e:ai-conversation
      - uses: actions/upload-artifact@v3
        if: always()
        with:
          name: playwright-report
          path: test-results/
```

---

## 📚 More Information

- **Full Test Documentation**: `test/README-AI-CONVERSATION-TESTS.md`
- **User Guide**: `AI-CONVERSATION-QUICK-START.md`
- **Implementation**: `src/ai-conversation-capture.js`
- **UI Overlay**: `src/ai-window-overlay.js`

---

## 💡 Pro Tips

1. **Run specific test suites**:
   ```bash
   npx playwright test --grep "Conversation Capture - Claude"
   npx playwright test --grep "Formatting"
   ```

2. **View traces on failure**:
   ```bash
   npx playwright show-trace test-results/.../trace.zip
   ```

3. **Update snapshots**:
   ```bash
   npx playwright test --update-snapshots
   ```

4. **Run in parallel** (faster):
   Edit `playwright.config.js`:
   ```javascript
   fullyParallel: true,
   workers: 4,
   ```

---

## ✨ Quick Commands Reference

| Command | Description |
|---------|-------------|
| `npm run test:e2e:ai-conversation` | Run all tests |
| `npm run test:e2e:ai-conversation:headed` | Run with visible UI |
| `npm run test:e2e:ai-conversation:debug` | Debug mode |
| `./test/run-ai-conversation-tests.sh` | Interactive script |
| `./test/run-ai-conversation-tests.sh --ui` | Playwright UI mode |
| `npx playwright show-report` | View HTML report |

---

**Happy Testing! 🎉**
