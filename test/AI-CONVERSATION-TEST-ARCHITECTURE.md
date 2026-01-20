# AI Conversation Capture Test Architecture

## Test Flow Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                     TEST SUITE START                         │
│              (Playwright + Electron)                         │
└──────────────────┬──────────────────────────────────────────┘
                   │
                   │ Launch Electron App
                   ▼
┌─────────────────────────────────────────────────────────────┐
│               ELECTRON APP (TEST MODE)                       │
│  Environment: TEST_MODE=true, NODE_ENV=test                 │
├─────────────────────────────────────────────────────────────┤
│  ✓ Main Process initialized                                 │
│  ✓ Spaces API initialized                                   │
│  ✓ Conversation Capture initialized                         │
│  ✓ Test-only IPC handlers registered                        │
└──────────────────┬──────────────────────────────────────────┘
                   │
                   │ Enable capture in settings
                   ▼
┌─────────────────────────────────────────────────────────────┐
│               SETTINGS CONFIGURATION                         │
│                                                              │
│  aiConversationCapture:                                      │
│    ✓ enabled: true                                           │
│    ✓ enableUndoWindow: true                                  │
│    ✓ undoWindowMinutes: 5                                    │
│    ✓ conversationTimeoutMinutes: 30                          │
└──────────────────┬──────────────────────────────────────────┘
                   │
                   │ Run test scenarios
                   ▼
┌─────────────────────────────────────────────────────────────┐
│            TEST SCENARIO 1: CLAUDE CAPTURE                   │
└─────────────────────────────────────────────────────────────┘
                   │
                   ├─► Open Claude Window
                   │   └─► Verify window created
                   │   └─► Verify URL correct
                   │
                   ├─► Check AI Overlay
                   │   └─► Verify .ai-overlay exists
                   │   └─► Verify status badge shows "Recording"
                   │   └─► Verify control buttons present
                   │
                   ├─► Simulate Conversation
                   │   └─► Call conversation:test-capture IPC
                   │   └─► Pass: { serviceId: 'Claude', conversation: {...} }
                   │   └─► Capture creates/updates active conversation
                   │   └─► Saves to Spaces API
                   │
                   ├─► Verify Space Creation
                   │   └─► Query spaces:list
                   │   └─► Find "Claude Conversations"
                   │   └─► Verify icon: 🤖, color: #ff6b35
                   │
                   ├─► Verify Conversation Saved
                   │   └─► Query spaces:items:list(claudeSpaceId)
                   │   └─► Get most recent item
                   │   └─► Verify content format:
                   │       ├─► Header: # 🤖 Conversation with Claude
                   │       ├─► Metadata: Started, Model, Exchanges
                   │       ├─► Messages: ### 👤 You, ### 🤖 Claude
                   │       ├─► Separators: ---
                   │       └─► Footer: Conversation ID
                   │
                   ├─► Test Privacy Controls
                   │   ├─► Pause
                   │   │   └─► Click pause button
                   │   │   └─► Verify status: "Paused"
                   │   │   └─► Verify conversation:isPaused() = true
                   │   │
                   │   ├─► Resume
                   │   │   └─► Click resume button
                   │   │   └─► Verify status: "Recording"
                   │   │
                   │   ├─► Do Not Save
                   │   │   └─► Click "Don't Save This"
                   │   │   └─► Verify status: "Not Recording This"
                   │   │   └─► Verify button: "Won't be saved"
                   │   │
                   │   └─► Undo Save
                   │       └─► Verify toast appears with "Undo" button
                   │       └─► Click undo
                   │       └─► Verify item deleted from Space
                   │
                   └─► Test Complete
                       └─► Proceed to next scenario

┌─────────────────────────────────────────────────────────────┐
│        TEST SCENARIO 2: MULTI-SERVICE CAPTURE                │
└─────────────────────────────────────────────────────────────┘
                   │
                   ├─► Simulate ChatGPT Conversation
                   │   └─► Verify "ChatGPT Conversations" Space
                   │   └─► Verify icon: 💬, color: #10a37f
                   │
                   ├─► Simulate Gemini Conversation
                   │   └─► Verify "Gemini Conversations" Space
                   │   └─► Verify icon: ✨, color: #4285f4
                   │
                   ├─► Simulate Grok Conversation
                   │   └─► Verify "Grok Conversations" Space
                   │   └─► Verify icon: 🚀, color: #6b7280
                   │
                   └─► Verify Isolation
                       └─► Each Space contains only its service's conversations
                       └─► Metadata correctly identifies service

┌─────────────────────────────────────────────────────────────┐
│          TEST SCENARIO 3: FORMATTING VALIDATION              │
└─────────────────────────────────────────────────────────────┘
                   │
                   ├─► Test Code Blocks
                   │   └─► Simulate conversation with ```javascript
                   │   └─► Verify code block preserved
                   │   └─► Verify metadata.hasCode = true
                   │
                   ├─► Test Long Conversations
                   │   └─► Simulate 10+ exchanges
                   │   └─► Verify all messages saved
                   │   └─► Verify proper separators
                   │   └─► Verify exchange count
                   │
                   └─► Test Special Characters
                       └─► Simulate: & < > " ' 🎉 ✨ 🚀
                       └─► Verify all characters preserved
                       └─► Verify emoji rendered correctly

┌─────────────────────────────────────────────────────────────┐
│               TEST SCENARIO 4: CLEANUP                       │
└─────────────────────────────────────────────────────────────┘
                   │
                   └─► Delete All Test Data
                       ├─► Query all Spaces with "Conversations"
                       ├─► For each Space:
                       │   └─► Query all items
                       │   └─► Delete each item
                       └─► Verify clean state

┌─────────────────────────────────────────────────────────────┐
│                    TEST SUITE COMPLETE                       │
│                                                              │
│  ✅ 17 tests passed                                          │
│  ⏱️  Duration: ~35 seconds                                   │
│  📊 Report: test-results/html/index.html                     │
└─────────────────────────────────────────────────────────────┘
```

---

## Component Interaction Diagram

```
┌──────────────────┐
│  Playwright Test │
│     Runner       │
└────────┬─────────┘
         │
         │ electron.launch()
         ▼
┌─────────────────────────────────────────────────────────────┐
│                    ELECTRON APP                              │
│                                                              │
│  ┌────────────┐         ┌──────────────┐                    │
│  │   Main     │◄────────┤ IPC Handlers │                    │
│  │  Process   │         │              │                    │
│  └─────┬──────┘         └──────▲───────┘                    │
│        │                       │                             │
│        │                       │                             │
│        │  ┌────────────────────┴──────────────┐             │
│        │  │                                    │             │
│        ▼  ▼                                    │             │
│  ┌─────────────────┐                   ┌──────┴──────┐      │
│  │ Conversation    │                   │   Spaces    │      │
│  │    Capture      │──────saves to────►│     API     │      │
│  │                 │                   │             │      │
│  └─────────────────┘                   └─────────────┘      │
│                                                              │
└─────────────────────────────────────────────────────────────┘
         ▲                                        │
         │                                        │
         │ window.evaluate(() =>                  │
         │   ipcRenderer.invoke(...))             │
         │                                        │
         │                                        ▼
┌────────┴────────┐                    ┌─────────────────┐
│  Test Assertions│◄───────verify──────│  Spaces Data    │
│                 │                    │                 │
│ expect(space)   │                    │ { id, name,     │
│ expect(content) │                    │   items: [...] }│
└─────────────────┘                    └─────────────────┘
```

---

## IPC Communication Flow

```
TEST                    RENDERER                  MAIN PROCESS
────                    ────────                  ────────────

 │                          │                          │
 │ mainWindow.evaluate()    │                          │
 ├─────────────────────────►│                          │
 │                          │                          │
 │                          │ ipcRenderer.invoke()     │
 │                          ├─────────────────────────►│
 │                          │ 'conversation:test-capture'
 │                          │                          │
 │                          │                          ├─► ConversationCapture
 │                          │                          │   .capturePrompt()
 │                          │                          │   .captureResponse()
 │                          │                          │   ._saveConversation()
 │                          │                          │
 │                          │                          ├─► SpacesAPI
 │                          │                          │   .create()
 │                          │                          │   .items.add()
 │                          │                          │
 │                          │      result              │
 │                          │◄─────────────────────────┤
 │        result            │ { success, itemId }      │
 │◄─────────────────────────┤                          │
 │                          │                          │
 │ expect(result.success)   │                          │
 │                          │                          │
```

---

## Data Flow for Conversation Capture

```
┌──────────────────┐
│ User Prompt      │
│ "Hello, test"    │
└────────┬─────────┘
         │
         ▼
┌──────────────────────────────────────┐
│  conversation:test-capture IPC       │
│  {                                   │
│    serviceId: 'Claude',              │
│    conversation: {                   │
│      messages: [{...}],              │
│      exchangeCount: 1                │
│    }                                 │
│  }                                   │
└────────┬─────────────────────────────┘
         │
         ▼
┌──────────────────────────────────────┐
│  ConversationCapture                 │
│  .activeConversations.set()          │
│                                      │
│  {                                   │
│    id: 'conv-123...',                │
│    serviceId: 'Claude',              │
│    startTime: '2026-01-17...',       │
│    messages: [...],                  │
│    exchangeCount: 1,                 │
│    model: 'claude-3-5-sonnet',       │
│    savedItemId: null                 │
│  }                                   │
└────────┬─────────────────────────────┘
         │
         │ _saveConversation()
         ▼
┌──────────────────────────────────────┐
│  _getOrCreateServiceSpace()          │
│  ├─► Check cache                     │
│  ├─► Check existing Spaces           │
│  └─► Create if needed                │
│                                      │
│  Returns: spaceId                    │
└────────┬─────────────────────────────┘
         │
         │ _formatConversationMarkdown()
         ▼
┌──────────────────────────────────────┐
│  Markdown Formatted Conversation     │
│                                      │
│  # 🤖 Conversation with Claude       │
│                                      │
│  **Started:** 1/17/2026...           │
│  **Model:** claude-3-5-sonnet        │
│  **Exchanges:** 1                    │
│  ---                                 │
│  ### 👤 You                          │
│  *2:30:00 PM*                        │
│  Hello, test                         │
│  ---                                 │
│  ### 🤖 Claude                       │
│  *2:30:05 PM*                        │
│  Test response                       │
│  ---                                 │
│  <sub>Conversation ID: conv-123</sub>│
└────────┬─────────────────────────────┘
         │
         │ spacesAPI.items.add()
         ▼
┌──────────────────────────────────────┐
│  Spaces Storage                      │
│                                      │
│  Space: "Claude Conversations"       │
│  └─► Item: {                         │
│        id: 'item-456...',            │
│        type: 'text',                 │
│        content: [markdown],          │
│        metadata: {                   │
│          aiService: 'Claude',        │
│          model: '...',               │
│          exchangeCount: 1,           │
│          tags: ['ai-conversation']   │
│        }                             │
│      }                               │
└────────┬─────────────────────────────┘
         │
         │ Return to test
         ▼
┌──────────────────────────────────────┐
│  Test Assertions                     │
│  ✓ result.success === true           │
│  ✓ result.itemId exists              │
│  ✓ Space created with correct name   │
│  ✓ Item content formatted correctly  │
│  ✓ Metadata complete and accurate    │
└──────────────────────────────────────┘
```

---

## Test Execution Timeline

```
Time  │ Action
──────┼────────────────────────────────────────────────────
0s    │ Launch Electron app
1s    │ Wait for app ready
2s    │ Enable conversation capture settings
3s    │ ────── TEST: Open Claude window ──────
4s    │ Verify window created
5s    │ ────── TEST: Check AI overlay ──────
6s    │ Verify overlay exists, status = "Recording"
7s    │ ────── TEST: Simulate conversation ──────
8s    │ Call test-capture IPC
9s    │ Create conversation object
10s   │ Save to Space (with retry)
11s   │ ────── TEST: Verify Space ──────
12s   │ Query Spaces list
13s   │ Find "Claude Conversations"
14s   │ ────── TEST: Verify format ──────
15s   │ Get item content
16s   │ Validate markdown structure
17s   │ ────── TEST: Pause capture ──────
18s   │ Click pause button
19s   │ Verify paused state
20s   │ ────── TEST: Resume capture ──────
21s   │ Click resume button
22s   │ ────── TEST: Do not save ──────
23s   │ Click "Don't Save This"
24s   │ ────── TEST: Undo save ──────
25s   │ Simulate save with toast
26s   │ Click undo
27s   │ Verify item deleted
28s   │ ────── TEST: Multi-service ──────
29s   │ Capture ChatGPT conversation
30s   │ Capture Gemini conversation
31s   │ Capture Grok conversation
32s   │ Verify separate Spaces
33s   │ ────── TEST: Formatting ──────
34s   │ Test code blocks, long conversations, special chars
35s   │ ────── TEST: Cleanup ──────
36s   │ Delete all test items
37s   │ ────── ALL TESTS COMPLETE ──────
```

---

## File Dependencies

```
test/e2e/ai-conversation-capture.spec.js
  │
  ├─► requires: @playwright/test
  ├─► requires: playwright (electron)
  │
  └─► interacts with:
      │
      ├─► main.js
      │   └─► IPC Handler: conversation:test-capture
      │
      ├─► src/ai-conversation-capture.js
      │   ├─► ConversationCapture class
      │   ├─► AI_SERVICE_CONFIG
      │   └─► getConversationCapture()
      │
      ├─► src/ai-window-overlay.js
      │   └─► AIWindowOverlay class
      │
      └─► Spaces API (via IPC)
          ├─► spaces:list
          ├─► spaces:get
          ├─► spaces:items:list
          ├─► spaces:items:get
          └─► spaces:items:delete
```

---

This architecture ensures:
- ✅ Fast test execution (~35 seconds)
- ✅ No external dependencies (no real AI login)
- ✅ Deterministic results
- ✅ Full test coverage of capture flow
- ✅ Easy to debug and maintain
