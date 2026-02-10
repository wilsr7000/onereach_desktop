# Conversations Test Plan

## Prerequisites

- App running (`npm start`)
- AI Conversation Capture enabled in Settings (`aiConversationCapture.enabled: true`)
- At least one AI service tab open (Claude, ChatGPT, Gemini, Perplexity, or Grok)

## Features Documentation

The AI Conversation Capture system (`src/ai-conversation-capture.js`) automatically captures conversations from AI service windows (Claude, ChatGPT, Gemini, Perplexity, Grok). It injects an overlay script into AI service tabs to intercept responses, formats them, and saves to dedicated Spaces (one per service). The system supports pause/resume, per-conversation opt-out, undo save (5-minute window), and media capture (images, files, code blocks).

**Key files:** `src/ai-conversation-capture.js`, `src/ai-window-overlay.js`
**IPC namespace:** `conversation:*`
**Settings key:** `aiConversationCapture` (object with sub-fields)
**Supported services:** Claude, ChatGPT, Gemini, Perplexity, Grok

## Checklist

### Enable/Disable
- [ ] `[A]` `conversation:isEnabled()` returns true when setting enabled
- [ ] `[A]` `conversation:isEnabled()` returns false when setting disabled
- [ ] `[P]` Disabling capture stops all active monitoring (no new saves)

### Pause/Resume
- [ ] `[A]` `conversation:setPaused(true)` pauses capture, `isPaused()` returns true
- [ ] `[A]` `conversation:setPaused(false)` resumes capture, `isPaused()` returns false
- [ ] `[M]` While paused, AI conversations are not saved to Spaces

### Per-Conversation Opt-Out
- [ ] `[A]` `conversation:markDoNotSave(serviceId)` marks current conversation
- [ ] `[A]` `conversation:isMarkedDoNotSave(serviceId)` returns true after marking
- [ ] `[M]` Marked conversations do not appear in the service's Space

### Capture Flow
- [ ] `[M]` Open Claude tab, send a message -- conversation captured and saved to "Claude Conversations" space
- [ ] `[M]` Open ChatGPT tab, send a message -- captured to "ChatGPT Conversations" space
- [ ] `[M]` Verify captured conversation includes user prompt and AI response text

### Undo and Copy
- [ ] `[M]` After capture, call `conversation:undoSave(itemId)` within 5 minutes -- item removed
- [ ] `[M]` `conversation:copyToSpace(conversationId, targetSpaceId)` copies to another space

### Privacy
- [ ] `[M]` Private mode session does not capture conversations
- [ ] `[M]` Recording indicator visible in AI tab when capture is active (if `showRecordingIndicator` enabled)

## Automation Notes

- **Existing coverage:** `test/e2e/ai-conversation-smoke.spec.js` (4 tests, not in journey suite)
- **Gaps:** Actual capture flow requires live AI service interaction -- hard to automate
- **Spec file:** IPC-level tests (enable/disable/pause) can be automated via `electronApp.evaluate`
- **Note:** Capture flow tests are inherently `[M]` since they require real AI service interaction
