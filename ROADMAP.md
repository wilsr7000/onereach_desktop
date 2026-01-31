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

### Roadmap

#### Q1 2026
- [ ] **Smart folders** - Auto-organize by rules
- [ ] **Tags system** - Cross-space tagging
- [ ] **Version history** - Track item changes
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

### Roadmap

#### Q1 2026
- [ ] **Conversation persistence** - Resume chats across sessions
- [ ] **Multi-window** - Same agent in multiple windows
- [ ] **Keyboard shortcuts** - Quick agent switching
- [ ] **Context sharing** - Share Spaces content with AI agents

#### Q2 2026
- [ ] **Agent chaining** - Connect agents to work together
- [ ] **Prompt library** - Save and reuse your best prompts
- [ ] **Cost tracking** - See how much you're spending

#### Future
- [ ] **Local models** - Run AI locally (Ollama, etc.)
- [ ] **Agent marketplace** - Share/discover community agents

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

