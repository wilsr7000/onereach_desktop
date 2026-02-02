# Voice Task SDK v2.0

A comprehensive voice-enabled task management SDK for Electron applications.

## Features

### Voice Input
- 🎤 **Real-time Speech** - OpenAI Realtime API with WebSocket streaming
- 🔄 **Automatic Fallback** - Falls back to Whisper API if Realtime fails
- 💬 **Voice Commands** - Natural language task control
- 🔇 **Voice Activity Detection** - Server-side VAD with configurable thresholds

### Task Management (NEW in v2.0)
- ✅ **Actions** - Classifiable intents with timeouts and retries
- 📋 **Queues** - Named execution threads with concurrency control
- 🤖 **Agents** - Task resolvers with priority-based selection
- 🔀 **Router** - Rules engine for routing tasks to queues
- 🎯 **AI Classification** - OpenAI-powered intent recognition

### Knowledge System (NEW in v2.0)
- 📚 **RAG** - Retrieval-Augmented Generation for Q&A
- 🧩 **Chunking** - Multiple strategies (fixed, paragraph, sentence, semantic)
- 🔍 **Vector Search** - Cosine similarity with in-memory store
- 💡 **Answer Generation** - LLM-synthesized answers from knowledge

### UI Components (React)
- 🔮 **VoiceOrb** - Animated voice input button with visual feedback
  - `theme="firefly"` - Organic bioluminescent glow with gentle floating motion
  - `theme="default"` - Classic purple pulse animation
- 📊 **TaskHUD** - Heads-up display for current/recent tasks
- 📋 **QueuePanel** - Queue monitoring and management panel

### Electron Integration
- ⌨️ **Global Shortcuts** - System-wide keyboard shortcuts
- 🖥️ **System Tray** - Menu bar integration
- 📜 **AppleScript** - macOS automation
- 🖱️ **Input Control** - Mouse and keyboard automation

## Quick Start

### 1. Add to main.js

```javascript
// After existing realtime-speech initialization, add:
try {
  const { initializeVoiceTaskSDK } = require('./src/voice-task-sdk/integration');
  initializeVoiceTaskSDK({
    useNewSpeechService: false,  // Keep using legacy for now
    language: 'en',
    preferredBackend: 'realtime',
    enableKnowledge: true,
    enableClassification: true
  });
  console.log('[VoiceTaskSDK] Voice Task SDK initialized');
} catch (error) {
  console.error('[Startup] Error initializing Voice Task SDK:', error);
}
```

### 2. Add to preload.js

```javascript
// At the end of preload.js:
require('./src/voice-task-sdk/preload-extension');
```

### 3. Use in Renderer

```javascript
// Check SDK status
const status = await window.voiceTaskSDK.getStatus();
console.log('SDK Version:', status.version);

// Submit transcript for classification
const result = await window.voiceTaskSDK.submit('send an email to John');
if (result.action) {
  console.log('Classified as:', result.action);
}

// Use knowledge system
await window.voiceTaskSDK.addKnowledge({
  name: 'Product Docs',
  type: 'text',
  content: '...'
});

const answer = await window.voiceTaskSDK.askKnowledge('How do I configure the app?');
console.log(answer.answer);
```

## Legacy API (Backward Compatible)

The original VoiceTaskSDK class is still available:

```javascript
const { VoiceTaskSDK } = require('./src/voice-task-sdk');

const sdk = new VoiceTaskSDK({
  apiKey: 'sk-...',
  enableTaskCommands: true,
  onVoiceInput: (text) => console.log('User said:', text),
  onTaskCreated: (task) => console.log('New task:', task)
});

await sdk.startListening();
```

## Architecture

```
voice-task-sdk/
├── core/                    # Core SDK components
│   ├── types.ts            # Type definitions
│   ├── actionStore.ts      # Action registry
│   ├── queueManager.ts     # Queue management
│   ├── agentRegistry.ts    # Agent registry
│   ├── taskStore.ts        # Task state
│   ├── router.ts           # Task routing
│   ├── dispatcher.ts       # Task execution
│   ├── hooks.ts            # Lifecycle hooks
│   ├── contextManager.ts   # App context
│   ├── undoManager.ts      # Undo operations
│   └── logger.ts           # Structured logging
├── classifier/             # Intent classification
│   ├── aiClassifier.ts     # OpenAI classifier
│   ├── promptBuilder.ts    # Dynamic prompts
│   └── index.ts            # Classifier factory
├── voice/                  # Voice services
│   ├── services/
│   │   ├── realtimeSpeech.ts
│   │   ├── whisperSpeech.ts
│   │   └── speechManager.ts
│   ├── hooks/
│   │   └── useVoice.ts
│   └── stores/
│       └── useVoiceStore.ts
├── knowledge/              # RAG system
│   ├── chunker.ts
│   ├── embedder.ts
│   ├── memorySource.ts
│   ├── answerGenerator.ts
│   └── knowledgeManager.ts
├── ui/react/               # React components
│   ├── VoiceOrb.tsx
│   ├── TaskHUD.tsx
│   └── QueuePanel.tsx
├── electron/               # Electron integration
│   ├── handlers/           # System handlers
│   ├── shortcuts.ts
│   ├── ipcAdapter.ts
│   └── tray.ts
├── services/               # Legacy services
├── integration.js          # Main process integration
├── preload-extension.js    # Preload extension
└── index.js                # Entry point
```

## Configuration

```javascript
const config = {
  // Voice settings
  apiKey: 'sk-...',
  language: 'en',
  preferredBackend: 'realtime',
  
  // Task settings
  enableTaskCommands: true,
  taskStorageKey: 'onereach-tasks',
  
  // AI classification
  classifier: {
    type: 'ai',  // 'ai' | 'custom' | 'hybrid'
    model: 'gpt-4o-mini',
    temperature: 0.3
  },
  
  // Knowledge settings
  knowledge: {
    chunkSize: 1000,
    chunkOverlap: 200,
    embeddingModel: 'text-embedding-3-small'
  }
}
```

## Testing

The SDK includes 708 comprehensive tests with 92%+ coverage.

```bash
cd voice-orb-task-sdk
npm test                 # Run all tests
npm run test:coverage    # Run with coverage report
```

## Migration Guide

### From v1.x (Legacy) to v2.0

1. **Keep legacy code working**: The `VoiceTaskSDK` class is preserved
2. **Add new integration**: Use `integration.js` and `preload-extension.js`
3. **Gradual migration**: New features available via `window.voiceTaskSDK`

### API Mapping

| Legacy | New SDK |
|--------|---------|
| `sdk.startListening()` | `voiceTaskSDK.voice.start()` |
| `sdk.stopListening()` | `voiceTaskSDK.voice.stop()` |
| `sdk.tasks.add()` | `voiceTaskSDK.submit()` + agent |
| Voice commands | AI classification + routing |

## License

MIT
