# Onereach.ai Product Roadmap

> Strategic roadmap for all products within the Onereach.ai desktop application.
> Updated: January 2026 | Current Version: 3.10.0

---

## Vision

**Onereach.ai** is an AI-powered creative workstation that unifies digital workers, content creation, and intelligent automation into a single desktop experience.

---

## Products Overview

| Product | Status | Description |
|---------|--------|-------------|
| **GSX Create** | 🟢 Active | AI-powered development assistant |
| **Video Editor** | 🟢 Active | Video editing with AI features |
| **Spaces** | 🟢 Active | Content organization & storage |
| **Clipboard Manager** | 🟢 Active | Intelligent clipboard history |
| **Smart Export** | 🟢 Active | AI-enhanced content export |
| **IDW Hub** | 🟢 Active | Digital worker management |
| **AI Agents** | 🟢 Active | External AI integrations |
| **AI Creators** | 🟢 Active | Image/Video/Audio AI tools |
| **Budget Manager** | 🟢 Active | LLM cost tracking |
| **App Health** | 🟡 Beta | System monitoring dashboard |

---

## 🚀 GSX Create

*AI-powered development assistant for building apps and agents*

### Current State (v3.10.0)
- ✅ Task queue with 7-phase workflow
- ✅ Real-time progress display
- ✅ LLM summarization of activities
- ✅ Budget tracking (see how much you're spending)
- ✅ Work persists across restarts
- ✅ Graceful shutdown (never lose work)

### Roadmap

#### Q1 2026
- [ ] **Multi-repo support** - Work across multiple repositories
- [ ] **Git integration** - Visual diff, commit, branch management
- [ ] **Project templates** - Quick-start templates for common projects
- [ ] **Collaborative mode** - Share sessions with team members

#### Q2 2026
- [ ] **Custom agent personalities** - Define agent behavior/style
- [ ] **Code review mode** - AI-assisted code review workflow
- [ ] **Test generation** - Auto-generate tests from code
- [ ] **Documentation generation** - Auto-generate docs from code

#### Future
- [ ] **Plugin system** - Extend with custom tools
- [ ] **Cloud sync** - Sync projects across devices
- [ ] **Mobile companion** - Monitor/review from mobile

---

## 🎥 GSX Capture

*Screen and camera recording with P2P dual recording sessions*

### Current State (v3.10.x)
- Modern UI with glassmorphism design, mode tabs, countdown, audio meters
- Camera, screen, and screen+camera (PiP) recording modes
- Audio mixing for multi-source recording
- Save directly to Spaces

### Roadmap

#### Q1 2026
- [x] **UI Redesign** - Modern glassmorphism design with mode tabs, countdown, keyboard shortcuts
- [ ] **P2P Dual Recording** - Riverside-style sessions (Phase 1: connection + split-view)
  - Single-word session codes (say "join falcon" on a call)
  - Native WebRTC with GSX OmniGraph signaling (no third-party deps)
  - Each participant records locally at full quality
- [ ] **Track Transfer** - Guest sends recording to host via WebRTC data channel (Phase 2)
- [ ] **Post-Processing** - FFmpeg merge with side-by-side, PiP, speaker-view layouts (Phase 3)

#### Q2 2026
- [ ] **Multi-participant** - Support 3+ people in a session
- [ ] **TURN server** - Relay for corporate NAT traversal

---

## 🎬 Video Editor

*Professional video editing with AI-powered features*

### Current State (v3.10.0)
- ✅ Timeline-based editing
- ✅ Range markers with metadata
- ✅ ElevenLabs audio replacement (9 voices)
- ✅ Smart transcription (instant from existing data)
- ✅ Waveform visualization
- ✅ Scene detection
- ✅ **Electron-compatible dialogs** (v3.8.14) - Fixed prompt() crashes
- ✅ **YouTube download status** (v3.8.14) - Correct completion tracking
- ✅ **FFprobe validation** - Better error messages

### Roadmap

#### Q1 2026
- [ ] **Voice selector UI** - Choose from all ElevenLabs voices
- [ ] **Audio preview** - Preview AI audio before applying
- [ ] **Batch processing** - Process multiple ranges
- [ ] **Voice cloning** - Use custom cloned voices

#### Q2 2026
- [ ] **Multi-track timeline** - Multiple video/audio tracks
- [ ] **Transitions library** - Pre-built video transitions
- [ ] **Color grading** - Basic color correction tools
- [ ] **Export presets** - Quick export for YouTube, social, etc.

#### Q3 2026
- [ ] **AI scene composition** - Auto-arrange clips
- [ ] **Background removal** - AI-powered green screen
- [ ] **Lip sync** - Match audio to video lips
- [ ] **Auto-captions** - Burn-in captions with styling

#### Future
- [ ] **Cloud rendering** - Offload heavy processing
- [ ] **Collaboration** - Real-time multi-user editing
- [ ] **Asset library** - Stock footage, music, effects

---

## 📦 Spaces

*Content organization, storage, and synchronization*

### Current State (v3.10.0)
- ✅ Hierarchical space organization
- ✅ Drag & drop content
- ✅ GSX synchronization
- ✅ Metadata management
- ✅ Search functionality
- ✅ Browser extension integration
- ✅ **Tufte-inspired design** (v3.8.13) - Clean geometric icons, neutral palette
- ✅ **Bulk operations** (v3.8.16) - Multi-select delete and move
- ✅ **Spaces upload** (v3.8.14) - Upload to ChatGPT, Claude from Spaces
- ✅ **GSX Push to Graph** (v3.10.x) - Push assets/spaces to GSX Files + OmniGraph

### Roadmap

#### Q1 2026
- [ ] **Smart folders** - Auto-organize by rules
- [x] **Tags system** - Cross-space tagging (via GSX Push metadata)
- [x] **Version history** - Track item changes (via content hash versioning)
- [x] **SPACE Framework metadata schema** - Extensible v2.0 schema with S/P/A/C/E namespaces, AI context extraction, auto-migration
- [x] **Data Source asset type** - MCP, API, and web-scraping source configs as first-class items with REST API for external agent discovery
- [ ] **Collections** - Curated item groups

#### Q2 2026
- [ ] **Sharing** - Share spaces/items externally
- [ ] **Comments** - Annotate items
- [ ] **Activity feed** - Track all changes
- [ ] **Advanced search** - Full-text and metadata search

#### Future
- [ ] **AI organization** - Auto-categorize content
- [ ] **Duplicate detection** - Find similar items
- [ ] **Storage optimization** - Compress, dedupe

---

## 📋 Clipboard Manager

*Intelligent clipboard history and management*

### Current State
- ✅ Clipboard history
- ✅ Source detection
- ✅ Quick paste shortcuts
- ✅ Space integration

### Roadmap

#### Q1 2026
- [ ] **Pinned items** - Keep important items accessible
- [ ] **Snippets** - Reusable text snippets
- [ ] **Image editing** - Quick crop/annotate
- [ ] **Cloud sync** - Sync across devices

#### Q2 2026
- [ ] **Smart paste** - Context-aware formatting
- [ ] **Templates** - Fill-in-the-blank templates
- [ ] **OCR** - Extract text from images
- [ ] **Translation** - Quick translate clipboard

---

## 📤 Smart Export

*AI-enhanced content export with style guides*

### Current State
- ✅ Multiple export formats
- ✅ Style guide extraction
- ✅ URL-based style import
- ✅ Template system
- ✅ **File Conversion Service** (v3.12.2) - 59 agentic converter agents for format transformation (image, video, audio, markdown, HTML, PDF, office, data, URL, playbook, code, AI generation), with pipeline resolver for multi-step conversions, comprehensive event logging, REST API + IPC bridge

### Roadmap

#### Q1 2026
- [ ] **Template editor** - Visual template builder
- [ ] **Style guide library** - Save/reuse style guides
- [ ] **Batch export** - Export multiple items
- [ ] **Format preview** - Live preview before export

#### Q2 2026
- [ ] **Custom formats** - Define new export formats
- [ ] **API integration** - Export directly to services
- [ ] **Scheduling** - Auto-export on schedule
- [ ] **Webhooks** - Trigger external actions

---

## 🏢 IDW Hub

*Manage OneReach.ai Intelligent Digital Workers*

### Current State
- ✅ IDW registration & management
- ✅ GSX link configuration
- ✅ Environment handling
- ✅ Agent explorer

### Roadmap

#### Q1 2026
- [ ] **Bulk management** - Import/export configs
- [ ] **Health monitoring** - IDW status dashboard
- [ ] **Usage analytics** - Track IDW interactions
- [ ] **Quick switch** - Keyboard shortcuts for IDWs

#### Q2 2026
- [ ] **IDW marketplace** - Discover public IDWs
- [ ] **Custom branding** - Personalize IDW appearance
- [ ] **Workflow builder** - Chain IDW actions
- [ ] **Scheduling** - Automated IDW tasks

---

## 🤖 AI Agents & Creators

*Access external AI services and capture your creations*

### Current State (v3.10.0)

**Conversation Capture:**
- ✅ ChatGPT - Auto-saves to "ChatGPT Conversations" Space
- ✅ Claude - Auto-saves to "Claude Conversations" Space
- ✅ Gemini - Auto-saves to "Gemini Conversations" Space
- ✅ Grok - Auto-saves to "Grok Conversations" Space
- ✅ Perplexity - Auto-saves to "Perplexity Conversations" Space

**AI Creators:**
- ✅ Image: Midjourney, DALL-E, Ideogram, Leonardo AI
- ✅ Video: Veo3, Runway, Pika, Kling
- ✅ Audio: ElevenLabs, Suno, Udio
- ✅ Design: Stitch, Figma AI

**Custom Agents:**
- ✅ Create your own voice-activated agents
- ✅ Undo/revert when editing agents
- ✅ New agents work immediately (no restart needed)

**Task Exchange (v3.13.x):**
- ✅ 100% LLM-based agent routing (no keyword/regex bidding)
- ✅ Fast-path: informational agents answer in bid (skip execution)
- ✅ Task locking with HUD countdown timer
- ✅ Error agent for graceful failure handling
- ✅ LLM-based disambiguation for no-bid scenarios
- ✅ Task decomposition for composite requests
- ✅ Multi-agent execution (parallel and series modes)
- ✅ submitSubtask.andWait() for agent-to-agent subtask coordination

### Roadmap

#### Q1 2026
- [x] **Conversation persistence** - Resume chats across sessions, global user profile, session summaries, active learning pipeline
- [x] **Centralized HUD API + Agent Spaces** - Componentized HUD architecture with space-scoped agent groups, remote agent protocol, meeting HUD overlay with P2P sync
- [x] **Full API Migration** - Unified LLM calls via ai-service.js (8 files migrated), HUD API completion (disambiguation, multi-turn, agent-specific submission), Spaces v3 Git versioning for agent spaces
- [x] **Documentation Agent** - RAG-grounded agent that answers app questions from official docs without hallucination, with eval tests for answer quality and hallucination detection
- [x] **Calendar Agent v2** - Full calendar engine with local persistent storage, recurring events (daily/weekdays/weekly/biweekly/monthly/yearly), morning brief with conflict detection and back-to-back warnings, free-slot finder with alternative time suggestions, week summary, exception handling for recurring events
- [ ] **Multi-window** - Same agent in multiple windows
- [ ] **Keyboard shortcuts** - Quick agent switching
- [ ] **Context sharing** - Share Spaces content with AI agents

#### Q2 2026
- [ ] **Agent chaining** - Connect agents to work together
- [ ] **Agent marketplace** - Share/discover community agents (built on Agent Spaces)
- [ ] **Prompt library** - Save and reuse your best prompts
- [ ] **Cost tracking** - See how much you're spending

#### Future
- [x] **Centralized AI Service** - Unified provider abstraction (`lib/ai-service.js`) -- COMPLETE
  - Change models across the entire app from one place (model profiles)
  - Auto-retry, provider fallback, circuit breakers for resilience
- [x] **Centralized Logging Event Queue** - All logging through one pipe (`lib/log-event-queue.js`) -- COMPLETE
  - REST + WebSocket server for external tool access (port 47292)
  - Ring buffer, file persistence, real-time subscriptions, stats
  - All ~3,000 console.log calls migrated to structured logging
  - Full API docs: `LOGGING-API.md`
  - Centralized cost tracking with per-feature and per-profile breakdowns
  - All 5 phases complete: core service, 18+ agents, tools, voice/realtime/misc, old wrappers deprecated
  - 40+ files migrated; old claude-api.js, openai-api.js, unified-claude.js marked deprecated
- [ ] **Local models** - Run AI locally (Ollama, etc.) - enabled by AI service adapter pattern
- [ ] **Remote agent ecosystem** - Third-party agents via GSX-hosted endpoints

---

## 💰 Budget Manager

*Track and control LLM spending*

### Current State
- ✅ Cost tracking per operation
- ✅ Budget limits
- ✅ Usage dashboard
- ✅ Price configuration

### Roadmap

#### Q1 2026
- [ ] **Alerts** - Notify on budget thresholds
- [ ] **Reports** - Weekly/monthly cost reports
- [ ] **Per-project budgets** - Budget by space/project
- [ ] **Cost optimization** - Suggestions to reduce costs

#### Q2 2026
- [ ] **Team budgets** - Shared budget pools
- [ ] **Billing integration** - Connect to actual billing
- [ ] **Forecasting** - Predict future costs
- [ ] **Audit log** - Detailed cost breakdown

---

## 🏥 App Health Dashboard

*System monitoring and diagnostics*

### Current State
- ✅ Basic health metrics
- ✅ Log viewer
- ✅ Error tracking

### Roadmap

#### Q1 2026
- [ ] **Performance metrics** - CPU, memory, disk
- [ ] **Network monitoring** - API latency, failures
- [ ] **Crash reporting** - Automatic crash reports
- [ ] **Self-healing** - Auto-fix common issues

#### Q2 2026
- [ ] **Predictive alerts** - Warn before problems
- [ ] **Remote diagnostics** - Support can view health
- [ ] **Update management** - Manage app updates
- [ ] **Backup/restore** - Full app backup

---

## Platform Roadmap

### Q1 2026 - Foundation
- [x] **Full API Migration** - Unified LLM (ai-service.js), HUD API completion, Spaces v3 Git versioning
- [x] **App Menu API Refactor** - Modularized menu.js (4,900 -> 1,700 lines), promoted MenuDataManager as single Menu API
- [ ] **Notarization** - Apple notarized builds
- [ ] **Windows signing** - SmartScreen trusted
- [ ] **Auto-update improvements** - Delta updates
- [ ] **Performance optimization** - Faster startup

### Q2 2026 - Expansion
- [ ] **Linux support** - Full Linux builds
- [ ] **Plugin architecture** - Third-party extensions
- [ ] **API platform** - External app integration
- [ ] **Multi-language** - Internationalization

### Q3 2026 - Enterprise
- [ ] **Team features** - Shared workspaces
- [ ] **SSO integration** - Enterprise auth
- [ ] **Admin console** - Manage deployments
- [ ] **Audit logging** - Compliance features

### Q4 2026 - Cloud
- [ ] **Cloud sync** - Cross-device sync
- [ ] **Web companion** - Browser-based access
- [ ] **Mobile apps** - iOS/Android apps
- [ ] **Offline mode** - Full offline capability

---

## Release Schedule

| Version | Target | Focus |
|---------|--------|-------|
| 3.10.0 | Jan 2026 | **Released** - Custom agent improvements |
| 3.11.0 | Feb 2026 | Voice selector for Video Editor |
| 3.12.0 | Mar 2026 | Mac App Store ready |
| 4.0.0 | Q2 2026 | Plugin system, multi-project support |
| 5.0.0 | Q3 2026 | Cloud sync, Team features |

---

## Contributing

### Suggesting Features
1. Check existing roadmap items
2. Open GitHub issue with `[Feature Request]` prefix
3. Describe use case and expected behavior

### Prioritization Criteria
- User impact (how many users benefit)
- Strategic alignment (fits product vision)
- Technical feasibility (can we build it well)
- Resource requirements (time/cost to build)

---

*This roadmap is a living document and will be updated as priorities evolve.*

