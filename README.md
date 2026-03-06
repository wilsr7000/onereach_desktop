# Onereach.ai

An AI-powered creative workstation that unifies digital workers, content management, voice agents, and intelligent automation into a single desktop experience. Built with Electron for macOS (Windows coming soon).

## Features

- **Voice Orb** -- Talk to AI agents hands-free. 18+ built-in agents for calendar, weather, search, music, meeting notes, and more. Create your own custom agents with voice, memory, and daily briefing support.
- **Spaces** -- Organize files, notes, clips, URLs, and data sources. Drag-and-drop content, bulk operations, GSX sync, and full-text search. REST API at port 47291.
- **WISER Meeting** -- Record camera, screen, or both with P2P dual recording (Riverside-style). Live captions, diarized transcripts, and post-processing with layout options.
- **Video Editor** -- Timeline-based editing with AI audio replacement (9 ElevenLabs voices), smart transcription, scene detection, and waveform visualization.
- **GSX Create** -- AI-powered development assistant with 7-phase task workflow, real-time progress, and budget tracking.
- **IDW Hub** -- Manage OneReach.ai Intelligent Digital Workers with GSX link configuration and OmniGraph-backed store.
- **AI Agents** -- External AI integrations (ChatGPT, Claude, Gemini, Grok, Perplexity) with automatic conversation capture to Spaces. AI creators for image, video, audio, and design.
- **Smart Export** -- 59 agentic converter agents for format transformation across 12 categories.
- **Budget Manager** -- Track LLM costs per operation with per-feature breakdowns.
- **Browsing API** -- Session-based web automation with anti-detection stealth, LLM-driven task runner, and safety guardrails.

## Prerequisites

- **Node.js** v20 or higher
- **npm** v9 or higher
- **macOS** 12+ (Apple Silicon or Intel)
- **API Keys** (configured in Settings > API Keys):
  - OpenAI (required for voice, transcription, embeddings)
  - Anthropic (required for AI agents, chat, analysis)
  - ElevenLabs (optional, for voice synthesis in Video Editor)

## Getting Started

```bash
# Clone the repository
git clone https://github.com/wilsr7000/Onereach_Desktop_App.git
cd Onereach_Desktop_App

# Install dependencies
npm install

# Start the application
npm start

# Development mode (with extra logging)
npm run dev
```

On first launch, the intro wizard will guide you through setup including API key configuration.

## Development

```bash
# Run unit tests
npm test

# Run E2E tests (requires app to be running)
npm run test:e2e

# Full test journey (smoke + API + spaces + settings)
npm run test:journey

# Lint and format
npm run lint
npm run format
```

## Building

```bash
# Package for macOS (universal)
npm run package:mac

# Package for macOS (ARM64 only)
npm run package:mac:arm64

# Full release (version bump, build, publish)
npm run release
```

## Architecture

- **Main process**: `main.js` -- app lifecycle, IPC handlers, window management
- **AI service**: `lib/ai-service.js` -- centralized LLM calls (OpenAI, Anthropic) with model profiles, retry, and fallback
- **Agent exchange**: `packages/task-exchange/` -- LLM-based agent routing and bidding
- **Spaces storage**: `clipboard-storage-v2.js` -- DuckDB-backed content storage with JSON index
- **Voice pipeline**: `src/voice-task-sdk/` -- real-time speech, agent coordination, conversation history
- **REST APIs**: Spaces (port 47291), Logs (port 47292), Agent Exchange (WebSocket port 3456)

## Key Directories

```
lib/                  AI service, agents tools, screen service, converters
packages/agents/      18+ built-in voice agents
packages/task-exchange/  Agent routing and bidding engine
src/voice-task-sdk/   Voice pipeline and exchange bridge
test/                 Unit tests (Vitest) and E2E tests (Playwright)
scripts/              Build, release, and notarization scripts
```

## Documentation

- `PUNCH-LIST.md` -- Bug tracker and feature status
- `ROADMAP.md` -- Product roadmap
- `LOGGING-API.md` -- Structured logging API reference
- `TOOL-APP-SPACES-API-GUIDE.md` -- Spaces REST API guide
- Swagger UI at `http://127.0.0.1:47291/api/docs/` (when app is running)

## License

ISC
