# Onereach.ai Desktop Application - Complete Feature Reference

> Version: 3.8.15 | Last Updated: January 2026

**Onereach.ai** is an AI-powered creative workstation that unifies digital workers, content creation, and intelligent automation into a single desktop experience.

---

## Table of Contents

1. [GSX Create](#1-gsx-create)
2. [Video Editor](#2-video-editor)
3. [Spaces](#3-spaces)
4. [Clipboard Manager](#4-clipboard-manager)
5. [Smart Export](#5-smart-export)
6. [IDW Hub](#6-idw-hub)
7. [AI Agents](#7-ai-agents)
8. [AI Creators](#8-ai-creators)
9. [Budget Manager](#9-budget-manager)
10. [App Health Dashboard](#10-app-health-dashboard)
11. [Recorder](#11-recorder)
12. [Black Hole Widget](#12-black-hole-widget)
13. [Built-in Browser](#13-built-in-browser)
14. [Website Monitor](#14-website-monitor)
15. [Web Scraper](#15-web-scraper)
16. [GSX File Sync](#16-gsx-file-sync)
17. [Transcription Service](#17-transcription-service)
18. [Release Manager](#18-release-manager)
19. [Module Manager](#19-module-manager)
20. [Settings & Configuration](#20-settings--configuration)

---

## 1. GSX Create

*AI-powered development assistant using Aider for code generation*

### Overview
GSX Create is a powerful AI coding assistant that leverages Aider to help developers write, refactor, and improve code. It supports multiple AI models and provides real-time feedback on code changes.

### Key Features

| Feature | Description |
|---------|-------------|
| **Task Queue** | 7-phase workflow for organized code generation |
| **Agent Activity HUD** | Real-time updates on agent actions |
| **LLM Summarization** | Automatic summaries of agent activities |
| **Branch Manager** | Sandboxed Aider processes per branch |
| **Multi-Model Support** | Switch between Claude, GPT-5.2, and others |
| **State Persistence** | Saves state across app restarts |
| **Graceful Shutdown** | Automatic state save on exit |

### Technical Details
- **File**: `aider-ui.html`, `app-manager-agent.js`, `aider-bridge-client.js`
- **Python Bridge**: `aider_bridge/` directory
- **Models**: Claude Opus 4.5, GPT-5.2 (256K context)

### Workflow Phases
1. Task Analysis
2. Planning
3. Code Generation
4. Review
5. Testing
6. Integration
7. Completion

---

## 2. Video Editor

*Professional video editing with AI-powered features*

### Overview
A DaVinci Resolve-inspired video editor with timeline-based editing, AI transcription, and audio replacement capabilities.

### Key Features

| Feature | Description |
|---------|-------------|
| **Timeline Editing** | Professional timeline-based video editing |
| **Range Markers** | Mark and annotate video segments with metadata |
| **ElevenLabs Audio** | AI voice replacement and audio generation |
| **Transcription** | Word-level transcription with speaker diarization |
| **Waveform Visualization** | Audio waveform display and scrubbing |
| **Scene Detection** | Automatic scene boundary detection |
| **Version Control** | Branch and version video projects |
| **Story Beats** | AI-assisted story beat planning |
| **Line Script** | Production script formatting |
| **Teleprompter** | Built-in teleprompter with sync |

### Layout Modes
1. **Edit Mode** - Primary video editing interface
2. **Line Script Mode** - Production script view
3. **Story Beats Mode** - Narrative planning view

### Production Script Features
- Camera angles (Eye Level, High Angle, Low Angle, Dutch, POV, etc.)
- Shot types (Extreme Wide, Wide, Medium, Close-Up, etc.)
- Camera movements (Pan, Tilt, Dolly, Tracking, Crane, etc.)
- Technical directions and screenplay formatting

### Video Processing Capabilities
- Trim and splice video
- Speed adjustment
- Concatenation
- Transcoding
- Watermarking
- Thumbnail generation
- Screengrab capture
- Slideshow creation

### Technical Details
- **File**: `video-editor.html`, `video-editor.js`, `video-editor-app.js`
- **Source**: `src/video/`, `src/video-editor/`
- **Dependencies**: FFmpeg, FFprobe

---

## 3. Spaces

*Content organization, storage, and synchronization*

### Overview
Spaces is a hierarchical content management system that organizes all captured content, files, and data in customizable containers.

### Key Features

| Feature | Description |
|---------|-------------|
| **Hierarchical Organization** | Nested spaces with parent-child relationships |
| **Drag & Drop** | Easy content organization via drag-drop |
| **GSX Synchronization** | Two-way sync with OneReach GSX |
| **Metadata Management** | Rich metadata for all items |
| **Search** | Full-text search across all spaces |
| **Browser Extension** | Chrome extension for web capture |
| **Item Types** | Text, images, files, code, HTML, URLs, videos, audio, PDFs |
| **Bulk Operations** | Multi-select and batch actions |

### Space Properties
- Unique ID
- Name
- Icon (customizable)
- Color (hex)
- Item count
- Created/Updated timestamps
- Metadata

### Item Properties
- ID, Space ID
- Type (text, image, file, code, html, url, video, audio, pdf)
- Content/File path
- Source information
- AI-generated metadata
- Timestamps

### APIs
- **SpacesAPI**: Unified API for space/item management
- **Items API**: Add, get, update, delete, move, search items
- **Content Ingestion**: Unified layer for all content additions

### Technical Details
- **File**: `clipboard-viewer.html`, `spaces-api.js`, `clipboard-storage-v2.js`
- **Storage**: File-based with JSON index

---

## 4. Clipboard Manager

*Intelligent clipboard history and management*

### Overview
Automatically captures and organizes clipboard content with source detection and quick paste capabilities.

### Key Features

| Feature | Description |
|---------|-------------|
| **Clipboard History** | Persistent history of copied content |
| **Source Detection** | Tracks where content was copied from |
| **Quick Paste Shortcuts** | Fast access to recent items |
| **Space Integration** | Save clipboard items directly to Spaces |
| **Content Type Detection** | Automatic type identification |
| **Multi-format Support** | Text, HTML, images, files |

### Captured Data
- Plain text
- Rich HTML
- Images
- File references
- Source URL/Application
- Timestamp

### Technical Details
- **File**: `clipboard-manager-v2-adapter.js`, `clipboard-storage-v2.js`
- **Storage**: Integrated with Spaces system

---

## 5. Smart Export

*AI-enhanced content export with style guides*

### Overview
Export content from Spaces in multiple formats with AI-powered formatting and style guide support.

### Key Features

| Feature | Description |
|---------|-------------|
| **Multiple Formats** | Export to various document formats |
| **Style Guide Extraction** | Import style guides from URLs |
| **Template System** | Reusable export templates |
| **Format Preview** | Live preview before export |
| **Mermaid Diagrams** | Support for flowcharts and diagrams |

### Export Formats
- Word Documents (DOCX)
- PowerPoint (PPTX)
- Excel (XLSX)
- PDF
- HTML
- Markdown
- Plain Text

### Technical Details
- **File**: `smart-export-preview.html`, `smart-export-format-modal.html`
- **Dependencies**: docx, pptxgenjs, exceljs

---

## 6. IDW Hub

*Manage OneReach.ai Intelligent Digital Workers*

### Overview
Central management hub for OneReach.ai digital workers, allowing configuration, monitoring, and interaction with IDWs.

### Key Features

| Feature | Description |
|---------|-------------|
| **IDW Registration** | Register and manage digital workers |
| **GSX Link Config** | Configure GSX connection links |
| **Environment Handling** | Support for staging, production, etc. |
| **Agent Explorer** | Browse and interact with agents |
| **Session Management** | Handle authentication sessions |

### Supported Environments
- Production
- Edison
- Staging
- Store

### Technical Details
- **File**: `setup-wizard.html`, `idw-registry.js`
- **Storage**: `idw-entries.json`, `gsx-links.json`

---

## 7. AI Agents

*External AI service integrations*

### Overview
Built-in browser windows for accessing external AI services with session persistence and integrated clipboard/Spaces support.

### Supported AI Services

| Service | Features |
|---------|----------|
| **ChatGPT** | Full chat interface, code execution, DALL-E integration |
| **Claude** | Claude.ai web interface with artifacts |
| **Gemini** | Google's AI assistant |
| **Perplexity** | Research and search AI |
| **Grok** | X's conversational AI |
| **Custom Agents** | Add custom AI endpoints |

### Key Features
- Session persistence across app restarts
- Automatic conversation capture to Spaces
- Copy/paste integration
- Artifact extraction (code, images, SVGs)
- Privacy controls (pause capture, private mode)

### AI Conversation Capture
- Auto-captures conversations with images and files
- Per-service dedicated Spaces
- Markdown formatting with metadata
- Multi-Space copying
- Undo functionality

### Technical Details
- **File**: `src/ai-conversation-capture.js`, `preload-external-ai.js`
- **API**: `claude-api.js`, `openai-api.js`

---

## 8. AI Creators

*Image, Video, and Audio AI tools*

### Overview
Access to AI-powered creative tools for generating images, videos, and audio content.

### Image Creators

| Tool | Description |
|------|-------------|
| **DALL-E** | OpenAI's image generation |
| **Midjourney** | High-quality artistic images |
| **Stable Diffusion** | Open-source image generation |
| **Leonardo.ai** | AI art creation platform |
| **Adobe Firefly** | Adobe's generative AI |

### Video Creators

| Tool | Description |
|------|-------------|
| **Veo3** | Google's video generation |
| **Runway** | AI video editing and generation |
| **Pika** | Text-to-video creation |
| **Synthesia** | AI avatar video generation |

### Audio Generators

| Tool | Description |
|------|-------------|
| **ElevenLabs** | Voice synthesis and cloning |
| **Murf** | AI voice generation |
| **Suno** | AI music generation |

### UI Design Tools

| Tool | Description |
|------|-------------|
| **Stitch** | AI-powered UI design |
| **Figma AI** | Figma with AI features |

### Technical Details
- **File**: `menu.js` (menu configuration)
- **Storage**: `image-creators.json`, `video-creators.json`, `audio-generators.json`, `ui-design-tools.json`

---

## 9. Budget Manager

*Track and control LLM spending*

### Overview
Centralized cost tracking system for all AI API usage across the application.

### Key Features

| Feature | Description |
|---------|-------------|
| **Cost Tracking** | Per-operation cost monitoring |
| **Budget Limits** | Daily, weekly, monthly limits |
| **Hard/Soft Limits** | Block or warn on budget exceed |
| **Usage Dashboard** | Visual cost breakdown |
| **Project Budgets** | Per-project cost allocation |
| **Feature Breakdown** | Costs by feature category |

### Feature Categories
- GSX Create
- Chat
- Code Generation
- Code Review
- Documentation
- Testing
- Refactoring
- Transcription
- Voice Generation
- Image Analysis

### Budget Configuration
- Daily limit with alert threshold
- Weekly limit with alert threshold
- Monthly limit with alert threshold
- Hard limit enforcement option

### Technical Details
- **File**: `budget-manager.js`, `budget-estimator.html`, `budget-dashboard.html`
- **Storage**: `budget-data/budget.json`
- **Pricing**: `pricing-config.js`

---

## 10. App Health Dashboard

*System monitoring and diagnostics*

### Overview
Monitor application health, view logs, and diagnose issues.

### Key Features

| Feature | Description |
|---------|-------------|
| **Health Metrics** | System status indicators |
| **Log Viewer** | Searchable application logs |
| **Error Tracking** | Error aggregation and analysis |
| **Filter System** | Filter by log level and source |

### Log Levels
- Debug
- Info
- Warning
- Error

### Technical Details
- **File**: `log-viewer.html`, `app-health-dashboard.js`
- **Logging**: `electron-log`, `event-logger.js`

---

## 11. Recorder

*Video recording with camera and screen capture*

### Overview
Standalone video recorder with instruction support for capturing camera and screen content.

### Key Features

| Feature | Description |
|---------|-------------|
| **Camera Capture** | Record from webcam |
| **Screen Capture** | Record screen content |
| **Instruction Mode** | Follow recording instructions |
| **Live Preview** | Real-time preview with duration |
| **Direct Save** | Save directly to Space/Project |
| **Teleprompter** | Built-in teleprompter display |

### Supported Modes
- Camera only
- Screen only
- Camera + Screen (Picture-in-Picture)

### Technical Details
- **File**: `recorder.html`, `recorder.js`, `src/recorder/`
- **Preload**: `preload-recorder.js`

---

## 12. Black Hole Widget

*Quick content capture widget*

### Overview
A floating widget for quickly capturing content from clipboard or drag-drop directly into Spaces.

### Key Features

| Feature | Description |
|---------|-------------|
| **Paste Capture** | Quick paste to selected Space |
| **Drag & Drop** | Drop files/content directly |
| **Space Selection** | Choose target Space with search |
| **Recent Spaces** | Quick access to recently used Spaces |
| **Content Preview** | Preview before saving |
| **Keyboard Shortcuts** | Global hotkeys for quick access |

### Workflow
1. Global shortcut opens Black Hole
2. Paste or drag content
3. Select target Space
4. Confirm to save

### Technical Details
- **File**: `black-hole.html`, `black-hole.js`
- **Preload**: `preload-black-hole.js`

---

## 13. Built-in Browser

*Tabbed web browser with GSX integration*

### Overview
Full-featured tabbed browser with Chrome-like functionality and integrated GSX/Spaces support.

### Key Features

| Feature | Description |
|---------|-------------|
| **Tabbed Browsing** | Multiple tabs with tab management |
| **Chrome-like UI** | Familiar browser interface |
| **GSX Window Support** | Special windows for GSX content |
| **Session Isolation** | Per-environment session partitioning |
| **Download Integration** | Downloads integrated with Spaces |
| **Auth Handling** | Google OAuth and SSO support |

### Special Integrations
- OneReach.ai sites
- Google authentication
- Microsoft authentication
- AI service websites

### Technical Details
- **File**: `browserWindow.js`, `tabbed-browser.html`
- **Features**: WebView support, permission handling

---

## 14. Website Monitor

*Web page change monitoring*

### Overview
Monitor websites for changes and automatically capture updates to Spaces.

### Key Features

| Feature | Description |
|---------|-------------|
| **Change Detection** | Monitor specific CSS selectors |
| **Screenshots** | Capture page screenshots on change |
| **Notifications** | Alert on detected changes |
| **Scheduled Checks** | Configurable check intervals |
| **Content Hashing** | Detect content modifications |

### Monitor Configuration
- URL to monitor
- Name/identifier
- CSS selector to watch
- Check interval
- Target Space for captures
- Screenshot option

### Technical Details
- **File**: `website-monitor.js`
- **Engine**: Playwright

---

## 15. Web Scraper

*HTML content extraction utility*

### Overview
Scrape and extract content from web pages using Puppeteer.

### Key Features

| Feature | Description |
|---------|-------------|
| **HTML Extraction** | Get full page HTML |
| **CSS Selectors** | Target specific elements |
| **Wait Conditions** | Wait for elements or network idle |
| **Resource Blocking** | Block images/CSS for faster scraping |

### Extraction Methods
- Full HTML content
- Selected elements only
- Text content extraction
- Structured data extraction

### Technical Details
- **File**: `web-scraper.js`
- **Engine**: Puppeteer

---

## 16. GSX File Sync

*Two-way synchronization with OneReach GSX*

### Overview
Synchronize files and spaces with OneReach GSX cloud storage.

### Key Features

| Feature | Description |
|---------|-------------|
| **Two-way Sync** | Bi-directional file synchronization |
| **Token Management** | Automatic token refresh |
| **Sync History** | Track sync operations |
| **Progress Tracking** | Visual sync progress |
| **Selective Sync** | Choose what to synchronize |

### Sync Paths
- Default sync paths (always synced)
- Optional sync paths (user-selected)

### Technical Details
- **File**: `gsx-file-sync.js`, `gsx-sync-progress.html`
- **SDK**: `@or-sdk/files-sync-node`

---

## 17. Transcription Service

*Unified audio/video transcription*

### Overview
High-quality speech-to-text transcription using ElevenLabs Scribe.

### Key Features

| Feature | Description |
|---------|-------------|
| **Speech-to-Text** | Accurate transcription |
| **Word Timestamps** | Word-level timing data |
| **Speaker Diarization** | Identify multiple speakers |
| **Language Detection** | Automatic language identification |
| **Multi-Channel** | Separate channel transcripts |

### Output Format
- Full text transcription
- Word-level timestamps
- Speaker IDs
- Language probability
- Segment data

### Technical Details
- **File**: `src/transcription/TranscriptionService.js`
- **Provider**: ElevenLabs Scribe

---

## 18. Release Manager

*Publish videos to YouTube and Vimeo*

### Overview
Upload and publish videos directly to YouTube and Vimeo from the Video Editor.

### YouTube Integration

| Feature | Description |
|---------|-------------|
| **OAuth Authentication** | Google account login |
| **Resumable Upload** | Large file support |
| **Privacy Settings** | Public, unlisted, private |
| **Category Selection** | YouTube categories |
| **Metadata** | Title, description, tags |

### Vimeo Integration

| Feature | Description |
|---------|-------------|
| **OAuth Authentication** | Vimeo account login |
| **TUS Upload** | Resumable uploads |
| **Privacy Settings** | Multiple privacy options |
| **Metadata** | Title, description |

### Technical Details
- **File**: `src/video/release/YouTubeUploader.js`, `VimeoUploader.js`
- **Auth**: OAuth 2.0 flow

---

## 19. Module Manager

*Extend application with custom modules*

### Overview
Plugin architecture for extending the application with custom functionality.

### Key Features

| Feature | Description |
|---------|-------------|
| **Module Loading** | Load custom JavaScript modules |
| **Hot Reload** | Update modules without restart |
| **API Access** | Modules can access app APIs |
| **UI Integration** | Add custom UI elements |

### Module Structure
```
module-folder/
  ├── index.html
  ├── module.js
  └── module.json (metadata)
```

### Technical Details
- **File**: `module-manager.js`, `module-manager-ui.html`
- **Example**: `example-module/`

---

## 20. Settings & Configuration

*Application configuration and preferences*

### Overview
Centralized settings management for all application features.

### Settings Categories

| Category | Settings |
|----------|----------|
| **General** | Theme, startup behavior |
| **AI/LLM** | API keys, default models, provider selection |
| **Video Editor** | Default paths, export settings |
| **Spaces** | Storage location, sync settings |
| **Budget** | Limits, alerts, tracking preferences |
| **Keyboard Shortcuts** | Global hotkeys |

### API Key Management
- OpenAI API key
- Anthropic (Claude) API key
- ElevenLabs API key
- GSX Token
- YouTube OAuth
- Vimeo OAuth

### Technical Details
- **File**: `settings.html`, `settings-manager.js`
- **Storage**: Electron userData directory

---

## Keyboard Shortcuts

### Global Shortcuts
| Shortcut | Action |
|----------|--------|
| `Cmd/Ctrl+Shift+V` | Open Black Hole |
| `Cmd/Ctrl+Shift+Space` | Open Spaces |
| `Cmd/Ctrl+,` | Open Settings |

### Video Editor Shortcuts
| Shortcut | Action |
|----------|--------|
| `Space` | Play/Pause |
| `J/K/L` | Playback control |
| `I` | Set in point |
| `O` | Set out point |
| `M` | Add marker |
| `Cmd/Ctrl+Z` | Undo |
| `Cmd/Ctrl+S` | Save |

---

## File Structure Overview

```
Onereach_app/
├── main.js                    # Main Electron process
├── menu.js                    # Application menu
├── browserWindow.js           # Browser window management
├── preload.js                 # Main preload script
├── renderer.js                # Main renderer
│
├── # Core Features
├── aider-ui.html              # GSX Create UI
├── video-editor.html          # Video Editor
├── clipboard-viewer.html      # Spaces/Clipboard Manager
├── settings.html              # Settings
│
├── # APIs
├── spaces-api.js              # Unified Spaces API
├── claude-api.js              # Claude API client
├── openai-api.js              # OpenAI API client
│
├── # Services
├── budget-manager.js          # Cost tracking
├── gsx-file-sync.js           # GSX synchronization
├── recorder.js                # Video recorder
├── website-monitor.js         # Web monitoring
├── web-scraper.js             # Content scraping
│
├── # Source Modules
├── src/
│   ├── video/                 # Video processing
│   ├── video-editor/          # Editor components
│   ├── transcription/         # Transcription service
│   ├── ai-conversation-capture.js
│   └── ...
│
├── lib/                       # Shared libraries
└── resources/                 # Browser extensions, etc.
```

---

## Dependencies

### Production Dependencies
| Package | Purpose |
|---------|---------|
| `@anthropic-ai/sdk` | Claude API |
| `electron-log` | Logging |
| `electron-updater` | Auto-updates |
| `fluent-ffmpeg` | Video processing |
| `puppeteer` | Web automation |
| `playwright` | Browser automation |
| `docx` | Word document generation |
| `exceljs` | Excel generation |
| `pptxgenjs` | PowerPoint generation |
| `youtube-dl-exec` | YouTube downloads |
| `keytar` | Secure credential storage |

### Dev Dependencies
| Package | Purpose |
|---------|---------|
| `electron` | Desktop app framework |
| `electron-builder` | App packaging |
| `vitest` | Testing |
| `playwright/test` | E2E testing |

---

## Platform Support

| Platform | Status |
|----------|--------|
| macOS (Apple Silicon) | Full Support |
| macOS (Intel) | Full Support |
| Windows (x64) | Full Support |
| Windows (ARM64) | Full Support |
| Linux | Planned |

---

*This document is automatically generated from the codebase and may be updated as features evolve.*
