# @onereach/voice-sdk

<p align="center">
  <img src="assets/orb-graphic.png" alt="Voice Orb" width="300" />
</p>

<p align="center">
  A comprehensive voice-enabled task management SDK with a beautiful firefly-animated orb UI, real-time speech transcription, AI classification, and RAG knowledge system.
</p>

---

## Features


### Voice Input
- **Real-time Speech** - OpenAI Realtime API with WebSocket streaming
- **Automatic Fallback** - Falls back to Whisper API if Realtime fails
- **Voice Activity Detection** - Server-side VAD with configurable thresholds

### Task Management
- **Actions** - Classifiable intents with timeouts and retries
- **Queues** - Named execution threads with concurrency control
- **Agents** - Task resolvers with priority-based selection
- **Router** - Rules engine for routing tasks to queues
- **AI Classification** - OpenAI-powered intent recognition

### Knowledge System (RAG)
- **Chunking** - Multiple strategies (fixed, paragraph, sentence, semantic)
- **Vector Search** - Cosine similarity with in-memory store
- **Answer Generation** - LLM-synthesized answers from knowledge

### UI Components (React)
- **VoiceOrb** - Animated voice input button with firefly theme
- **TaskHUD** - Heads-up display for current/recent tasks
- **QueuePanel** - Queue monitoring and management panel

### Electron Integration
- **Global Shortcuts** - System-wide keyboard shortcuts
- **System Tray** - Menu bar integration
- **Floating Orb Window** - Always-on-top voice input
- **AppleScript** - macOS automation
- **Input Control** - Mouse and keyboard automation

## Installation

```bash
npm install @onereach/voice-sdk
```

## Quick Start

### React Component

```tsx
import { VoiceOrb } from '@onereach/voice-sdk/react'

function App() {
  return (
    <VoiceOrb
      apiKey="sk-..."
      theme="firefly"  // Organic bioluminescent glow
      onTranscript={(text) => console.log('Heard:', text)}
    />
  )
}
```

### Electron Integration

```javascript
// main.js
const { initialize, showOrb, hideOrb } = require('@onereach/voice-sdk/electron')

app.whenReady().then(() => {
  initialize({
    toggleShortcut: 'CommandOrControl+Shift+O',
    showInTray: true,
  })
})
```

### Core SDK

```typescript
import { createVoiceTaskSDK } from '@onereach/voice-sdk'

const sdk = createVoiceTaskSDK({
  apiKey: 'sk-...',
  enableKnowledge: true,
  enableClassification: true,
})

// Register an action
sdk.registerAction({
  name: 'send_email',
  description: 'Send an email to someone',
  parameters: ['recipient', 'subject', 'body'],
})

// Submit transcript for classification
const result = await sdk.submit('send an email to John about the meeting')
console.log(result.action) // 'send_email'
console.log(result.params) // { recipient: 'John', subject: 'the meeting', ... }
```

## VoiceOrb Themes

### Firefly Theme (Default)

Organic bioluminescent glow with gentle floating motion, inspired by fireflies.

- Green glow in idle state
- Yellow/gold when actively listening
- Orange when processing
- Randomized glow intensity for organic feel
- Gentle floating animation

```tsx
<VoiceOrb apiKey="..." theme="firefly" />
```

### Default Theme

Classic purple pulse animation with volume-reactive glow.

```tsx
<VoiceOrb apiKey="..." theme="default" color="#6366f1" />
```

## API Reference

### VoiceOrb Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `apiKey` | `string` | required | OpenAI API key |
| `size` | `number` | `80` | Orb size in pixels |
| `theme` | `'firefly' \| 'default'` | `'firefly'` | Visual theme |
| `color` | `string` | `'#6366f1'` | Primary color (default theme) |
| `showTranscript` | `boolean` | `true` | Show transcript below orb |
| `onTranscript` | `(text: string) => void` | - | Transcript callback |
| `onError` | `(error: Error) => void` | - | Error callback |
| `preferredBackend` | `'realtime' \| 'whisper'` | `'realtime'` | Speech backend |
| `language` | `string` | `'en'` | Language code |
| `disabled` | `boolean` | `false` | Disabled state |

### SDK Configuration

```typescript
interface VoiceTaskSDKConfig {
  apiKey: string
  language?: string
  preferredBackend?: 'realtime' | 'whisper'
  enableKnowledge?: boolean
  enableClassification?: boolean
  classifier?: {
    type: 'ai' | 'custom' | 'hybrid'
    model?: string
    temperature?: number
  }
  knowledge?: {
    chunkSize?: number
    chunkOverlap?: number
    embeddingModel?: string
  }
}
```

### SDK Methods

```typescript
interface VoiceTaskSDK {
  // Voice
  voice: {
    start(): Promise<void>
    stop(): Promise<void>
    getState(): VoiceState
  }
  
  // Actions & Classification
  registerAction(action: Action): void
  submit(transcript: string): Promise<ClassificationResult>
  
  // Queues
  createQueue(name: string, options?: QueueOptions): Queue
  
  // Agents
  registerAgent(agent: Agent): void
  
  // Knowledge (RAG)
  addKnowledge(source: KnowledgeSource): Promise<string>
  searchKnowledge(query: string): Promise<SearchResult[]>
  askKnowledge(question: string): Promise<Answer>
  
  // Lifecycle
  destroy(): void
}
```

## Electron Handlers

The SDK provides system-level handlers for Electron apps:

```typescript
import { registerHandlers } from '@onereach/voice-sdk/electron'

// Available handlers:
// - activeApp: Get active application info
// - applescript: Run AppleScript (macOS)
// - filesystem: File operations
// - keyboard: Keyboard automation
// - mouse: Mouse automation
// - screenshot: Screen capture
// - spotlight: Spotlight search (macOS)
// - terminal: Terminal commands
```

## Architecture

```
@onereach/voice-sdk/
├── src/
│   ├── index.ts           # Main entry point
│   ├── createSDK.ts       # SDK factory
│   ├── core/              # Core components
│   │   ├── actionStore    # Action registry
│   │   ├── queueManager   # Queue management
│   │   ├── agentRegistry  # Agent registry
│   │   ├── taskStore      # Task state
│   │   ├── router         # Task routing
│   │   ├── dispatcher     # Task execution
│   │   └── hooks          # Lifecycle hooks
│   ├── classifier/        # AI classification
│   ├── voice/             # Voice services
│   ├── knowledge/         # RAG system
│   ├── ui/react/          # React components
│   └── electron/          # Electron integration
```

## License

MIT - OneReach.ai
