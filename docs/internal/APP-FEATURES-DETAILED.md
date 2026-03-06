# Onereach.ai Desktop Application - Detailed Feature Documentation

> Version: 3.8.15 | Last Updated: January 2026

This document provides an exhaustive breakdown of every feature in the Onereach.ai desktop application.

---

# Part 1: GSX Create (AI Code Generation)

## Overview
GSX Create is an AI-powered development assistant that uses Aider (an open-source AI pair programming tool) to help developers write, refactor, and improve code directly from the desktop app.

## Core Features

### 1.1 Task Queue System
- **7-Phase Workflow**:
  1. **Task Analysis** - AI analyzes the task requirements
  2. **Planning** - Creates implementation strategy
  3. **Code Generation** - Writes the actual code
  4. **Review** - Self-reviews generated code
  5. **Testing** - Suggests/generates tests
  6. **Integration** - Helps integrate changes
  7. **Completion** - Final verification

### 1.2 Agent Activity HUD
- Real-time display of what the AI agent is doing
- Shows current file being edited
- Displays token usage
- Progress indicators for long-running tasks
- Stream output from Aider in real-time

### 1.3 Branch Manager (Multi-Branch Aider)
Each coding branch gets its own sandboxed Aider instance:
- **Branch Isolation**: Separate Aider processes per branch
- **File Sandboxing**: Each branch can only edit files in its directory
- **Read-Only Files**: Specify files that can be read but not modified
- **Branch Logging**: Separate log files per branch
- **Orchestration Logging**: Master log of all branch activities

### 1.4 LLM Model Support
- **Claude Opus 4.5** - Primary model for code generation
- **Claude Sonnet 4.5** - Faster responses for simpler tasks
- **GPT-5.2** - Alternative with 256K context window
- Model switching per project/task

### 1.5 State Persistence
- Task queue survives app restarts
- Undo stack persisted to localStorage
- Emergency save on visibility change (tab hidden)
- Periodic backup every 10 seconds
- Graceful shutdown with state save

### 1.6 Budget Integration
- Real-time cost display in header
- Budget progress bar with color coding (green/yellow/red)
- Click to open budget dashboard
- Per-session and per-project tracking

### 1.7 Tab System
- Multiple project tabs open simultaneously
- Tab status indicators (idle, running, success, error)
- Hover tooltips with detailed progress
- Close buttons with unsaved changes warning
- "Main" overview tab with project grid

### 1.8 UI Elements
- Dark theme optimized for coding
- Monospace font (SF Mono, Fira Code)
- Color-coded status indicators
- Responsive layout

---

# Part 2: Video Editor

## Overview
A professional-grade video editor inspired by DaVinci Resolve, featuring timeline-based editing with AI-powered features for transcription, audio replacement, and content analysis.

## Core Features

### 2.1 Timeline System
- **Video Track**: Main video with thumbnail preview
- **Audio Tracks**: Multiple audio layers
  - Original audio track
  - ADR/replacement tracks
  - Speaker-separated tracks
  - Music/ambient tracks
- **Zoom Controls**: 1x to 20x zoom levels
- **Scroll Sync**: Timeline synced with video playback
- **Waveform Display**: Visual audio representation

### 2.2 Multi-Source Video System
For multi-camera and multi-take editing:
- **Video Sources**: Array of source videos with metadata
- **Video Clips**: Clips placed on timeline from sources
- **Active Source**: Currently playing source
- **Source Switching**: Instant switch between angles

### 2.3 Markers System
**Marker Types:**
- **Spot Markers**: Single point in time
- **Range Markers**: In/Out points defining segments
- **Line Script Markers** (by template):
  - Podcast: Quote, Topic, Clip, Speaker Change
  - Product: Feature, Demo, B-Roll, Testimonial
  - Promo: Hook, Beat, Transition, Logo
  - Learning: Chapter, Key Point, Quiz, Concept, Example
  - Analysis: ZZZ (boring), Highlight, CTA

**Marker Features:**
- 8 color options
- Name and description
- Thumbnail generation
- Export to EDL format
- Cross-view sync (Edit ↔ Line Script ↔ Story Beats)

### 2.4 Version Control System
- **Project Versioning**: Multiple versions per project
- **Branch Support**: Create branches from any version
- **Version Tree Visualization**: See version history
- **Version Dropdown**: Quick switch between versions
- **Auto-save**: Versions saved automatically

### 2.5 Layout Modes

#### Edit Mode
- Primary video editing interface
- Timeline with markers
- Video preview with controls
- Trim handles and slice markers
- Export controls

#### Line Script Mode
- Production script formatting
- View modes: Spotting, Edit, Review, Production, Export
- Templates: Podcast, Learning, Promo, Highlight, Dynamic
- Auto-scroll during playback
- AI metadata generation for markers

#### Story Beats Mode
- Narrative planning view
- Scene structure
- Character tracking
- Coverage tracking

### 2.6 Audio Features

#### Waveform Visualization
- Real-time waveform rendering
- Zoom-adaptive detail levels
- Click-to-seek on waveform
- Audio scrubbing

#### ElevenLabs Integration
- Text-to-speech audio generation
- Voice selection (Rachel, Josh, Adam, etc.)
- Audio replacement on timeline
- Budget-tracked API calls

#### Speaker Diarization
- Identify multiple speakers
- Color-coded speaker tracks
- Speaker reassignment UI
- Transcript segments by speaker

#### ADR Track Manager
- Create ADR replacement tracks
- Visual reference clips
- Room tone fill clips
- Audio clip positioning

### 2.7 Transcription Features
- **Word-Level Timestamps**: Every word has start/end time
- **Speaker Identification**: Multi-speaker support
- **Language Detection**: Automatic language identification
- **Transcript Display**: Optional words on waveform
- **Teleprompter Mode**: Scrolling transcript during playback

### 2.8 Production Script Elements
**Camera Angles:**
- Eye Level, High Angle, Low Angle
- Bird's Eye View, Dutch Angle
- Over the Shoulder, Point of View

**Shot Types:**
- Extreme Wide, Wide, Medium Wide
- Medium, Medium Close-Up, Close-Up
- Extreme Close-Up, Two-Shot, Over Shoulder

**Camera Movements:**
- Pan, Tilt, Dolly, Tracking
- Crane, Handheld, Steadicam
- Zoom, Push In, Pull Out

### 2.9 Scene Detection
- Automatic scene boundary detection
- Based on audio silence
- Configurable thresholds
- Manual adjustment supported

### 2.10 Video Processing Operations
| Operation | Description |
|-----------|-------------|
| Trim | Cut start/end with optional fades |
| Transcode | Convert between formats |
| Concatenate | Join multiple videos |
| Speed | Adjust playback speed |
| Splice | Insert video at point |
| Watermark | Add image/text overlay |
| Thumbnail | Generate preview images |
| Screengrab | Capture frame as image |
| Slideshow | Create video from images |

### 2.11 Export Features
- Multiple format support (MP4, WebM, MOV, AVI, MKV)
- Quality presets (Low, Medium, High, Ultra)
- Custom resolution and bitrate
- Playlist export (multiple segments)
- EDL export for external editors

### 2.12 Undo/Redo System
- 100 undo states
- State captured before each operation
- Redo support
- Persistent across sessions
- Emergency save on crash

---

# Part 3: Spaces (Content Management)

## Overview
Spaces is a hierarchical content management system that stores and organizes all captured content including text, images, code, files, URLs, videos, and audio.

## Core Features

### 3.1 Space Management
- **Create Spaces**: Name, icon, color
- **Edit Spaces**: Rename, change icon/color
- **Delete Spaces**: Items move to Unclassified
- **Space Metadata**: Purpose, tags, category

### 3.2 Item Types
| Type | Description | Storage |
|------|-------------|---------|
| text | Plain text content | Direct in DB |
| html | Rich HTML content | HTML file |
| image | Screenshots, photos | PNG/JPG file |
| code | Source code | Text file |
| file | Any file type | Original file |
| url | Web URLs | Metadata only |
| video | Video files | Video file |
| audio | Audio files | Audio file |
| pdf | PDF documents | PDF file |
| ai-conversation | AI chat exports | Markdown file |

### 3.3 Item Properties
- Unique ID (UUID)
- Space assignment
- Type classification
- Preview text (first 100 chars)
- File path (for file-based items)
- Thumbnail path
- Metadata path
- Source information (URL, app name)
- Tags array
- Pinned status
- Timestamps (created, modified)
- AI-generated metadata

### 3.4 Storage Backend

#### DuckDB Integration
- Primary storage for fast queries
- SQL-based item search
- Indexed by space, type, timestamp
- Concurrent read support

#### JSON Backup
- Legacy backup system
- Migration from JSON to DuckDB
- Human-readable format

### 3.5 Search & Filter
- Full-text search across items
- Filter by type
- Filter by date range
- Sort by date, name, size
- Pinned items at top

### 3.6 Drag & Drop
- Drag items between spaces
- Drag files into spaces
- Visual drop indicators
- Multi-item selection

### 3.7 AI Metadata Generation
Automatic metadata extraction based on content type:

**For Images:**
- Visual description
- Text extraction (OCR)
- Application detection
- Suggested title and tags

**For Code:**
- Language detection
- Function/class extraction
- Dependency analysis
- Suggested documentation

**For Text:**
- Summary generation
- Key points extraction
- Topic classification
- Suggested tags

### 3.8 Browser Extension
- Capture web content to Spaces
- Right-click to save
- Selection capture
- Full page capture

---

# Part 4: Clipboard Manager

## Overview
Intelligent clipboard history that automatically captures and organizes copied content with source detection.

## Features

### 4.1 Automatic Capture
- Text content
- Rich HTML
- Images
- File references
- URL detection

### 4.2 Source Tracking
- Source application name
- Source URL (for web content)
- Timestamp of copy
- Copy count tracking

### 4.3 Quick Paste
- Recent items list
- Search through history
- Keyboard shortcuts
- Preview before paste

### 4.4 Space Integration
- Save clipboard item to any Space
- Quick save to recent Spaces
- Batch move to Spaces

---

# Part 5: Smart Export

## Overview
AI-enhanced content export system that converts content from Spaces into various document formats with intelligent formatting.

## Features

### 5.1 Export Formats
| Format | Library | Features |
|--------|---------|----------|
| DOCX | docx | Styled paragraphs, headers, lists |
| PPTX | pptxgenjs | Slides, images, layouts |
| XLSX | exceljs | Tables, formulas, styling |
| PDF | HTML→PDF | Full styling support |
| HTML | Native | Complete web page |
| Markdown | Native | GitHub-flavored |

### 5.2 Style Guide System
- Import style from URL
- Extract styles from documents
- Save and reuse style guides
- AI-powered style matching

### 5.3 Template System
- Pre-built templates
- Custom template creation
- Variable substitution
- Conditional sections

### 5.4 Mermaid Diagram Support
- Flowcharts
- Sequence diagrams
- Class diagrams
- Auto-rendered in exports

---

# Part 6: IDW Hub (Digital Worker Management)

## Overview
Central hub for managing OneReach.ai Intelligent Digital Workers (IDWs) - AI-powered agents hosted on the OneReach platform.

## Features

### 6.1 IDW Registration
- Add new IDW environments
- Configure chat URLs
- Set environment labels
- Environment types: Production, Edison, Staging, Store

### 6.2 GSX Link Configuration
- Configure GSX (Studio) links per environment
- Account ID management
- Token management
- Link grouping by environment

### 6.3 Session Management
- Per-environment session isolation
- Cookie partitioning
- Authentication persistence
- Session refresh handling

### 6.4 Quick Access
- Keyboard shortcuts (Cmd+1 through Cmd+9)
- Menu bar integration
- Recently used IDWs
- Favorites list

---

# Part 7: AI Agents (External AI Services)

## Overview
Built-in integration with external AI services through dedicated browser windows with capture and privacy controls.

## Supported Services

### 7.1 ChatGPT
- Full ChatGPT web interface
- Code execution (Advanced Data Analysis)
- DALL-E image generation
- GPT-4/GPT-5 model access
- Conversation capture to Spaces

### 7.2 Claude
- Claude.ai web interface
- Artifact support (code, documents)
- Claude 3.5/4 model access
- Conversation capture to Spaces

### 7.3 Gemini
- Google Gemini interface
- Multi-modal support
- Google account integration
- Conversation capture

### 7.4 Perplexity
- Research-focused AI
- Citation support
- Web search integration
- Conversation capture

### 7.5 Grok
- X (Twitter) AI assistant
- Real-time information
- Conversation capture

### 7.6 Custom Agents
- Add custom AI endpoints
- Configure authentication
- Custom capture rules

## AI Conversation Capture

### Auto-Capture Features
- Automatic conversation detection
- Image and file capture
- Artifact extraction
- Markdown formatting
- Metadata preservation

### Privacy Controls
- **Pause Capture**: Temporarily stop capturing
- **Private Mode**: Per-window private sessions
- **Undo**: Remove recently captured content
- **Per-Service Spaces**: Separate space per AI service

---

# Part 8: AI Creators

## Overview
Quick access to AI-powered creative tools for generating images, videos, and audio.

## Image Creators
| Tool | Description |
|------|-------------|
| DALL-E | OpenAI's image generation |
| Midjourney | High-quality artistic images |
| Stable Diffusion | Open-source generation |
| Leonardo.ai | AI art platform |
| Adobe Firefly | Adobe's generative AI |
| Ideogram | Text-in-image specialist |
| Playground | Multiple model access |

## Video Creators
| Tool | Description |
|------|-------------|
| Veo3 | Google's video AI |
| Runway | AI video editing |
| Pika | Text-to-video |
| Synthesia | AI avatar videos |
| HeyGen | AI spokesperson videos |
| Luma | AI video generation |

## Audio Generators
| Tool | Description |
|------|-------------|
| ElevenLabs | Voice synthesis |
| Murf | AI voice generation |
| Suno | AI music creation |
| Udio | AI music generation |

## UI Design Tools
| Tool | Description |
|------|-------------|
| Stitch | AI-powered UI design |
| Figma AI | Figma with AI features |
| Galileo | AI UI generation |
| Uizard | AI prototyping |

---

# Part 9: Budget Manager

## Overview
Centralized cost tracking for all LLM API usage across the application.

## Features

### 9.1 Usage Tracking
- Per-operation cost logging
- Token count tracking (input/output)
- Provider breakdown (OpenAI, Anthropic, ElevenLabs)
- Model-specific pricing

### 9.2 Budget Limits
| Period | Configuration |
|--------|---------------|
| Daily | Limit + Alert threshold |
| Weekly | Limit + Alert threshold |
| Monthly | Limit + Alert threshold |

### 9.3 Hard/Soft Limits
- **Soft Limit**: Warning only, operations continue
- **Hard Limit**: Block operations when exceeded

### 9.4 Feature Categories
- GSX Create (code generation)
- Chat (conversations)
- Code Generation
- Code Review
- Documentation
- Testing
- Refactoring
- Transcription
- Voice Generation
- Image Analysis

### 9.5 Project Budgets
- Per-project cost allocation
- Project-specific limits
- Cost breakdown by project

### 9.6 Dashboard
- Visual cost breakdown
- Time-series charts
- Provider comparison
- Feature usage breakdown

---

# Part 10: App Health Dashboard

## Overview
System monitoring and diagnostics dashboard for application health.

## Features

### 10.1 Log Viewer
- Searchable application logs
- Filter by log level (Debug, Info, Warn, Error)
- Filter by source/component
- Time-range filtering
- Export logs

### 10.2 Health Metrics
- Memory usage
- CPU utilization
- Active windows count
- Storage usage

### 10.3 Error Tracking
- Error aggregation
- Stack trace display
- Error frequency tracking
- Recent errors list

### 10.4 App Manager Agent
Autonomous LLM-powered agent that:
- Scans event logs for errors
- Diagnoses issues using AI
- Applies automatic fixes
- Escalates recurring issues

**Fix Strategies:**
- Retry operation
- Regenerate thumbnail
- Regenerate metadata
- Rebuild index
- Cleanup orphan files
- Repair metadata
- Skip (for non-critical)
- Escalate to user

---

# Part 11: Recorder

## Overview
Standalone video recorder for capturing camera and screen content.

## Features

### 11.1 Capture Modes
- **Camera Only**: Webcam recording
- **Screen Only**: Desktop/window capture
- **Camera + Screen**: Picture-in-picture

### 11.2 Recording Features
- Live preview
- Duration counter
- Pause/resume
- Microphone selection
- Camera selection

### 11.3 Instruction Mode
- Display recording instructions
- Target duration display
- Guided recording

### 11.4 Direct Save
- Save to specific Space
- Save to Project folder
- Automatic file naming
- Metadata generation

### 11.5 Permissions
- macOS camera permission
- macOS microphone permission
- Screen recording permission

---

# Part 12: Black Hole Widget

## Overview
Floating widget for quick content capture from clipboard or drag-drop.

## Features

### 12.1 Content Capture
- Paste from clipboard
- Drag files directly
- Drag text content
- Drag images

### 12.2 Space Selection
- Search all Spaces
- Recent Spaces list
- Quick keyboard navigation
- Visual preview

### 12.3 Content Preview
- Type indicator
- Text preview
- Image thumbnail
- File info

### 12.4 Quick Actions
- Confirm with Enter
- Cancel with Escape
- Global shortcut activation

---

# Part 13: Built-in Browser

## Overview
Full-featured tabbed browser with GSX integration and Spaces support.

## Features

### 13.1 Tabbed Browsing
- Multiple tabs
- Tab management
- Tab history

### 13.2 GSX Windows
- Special windows for GSX content
- Session partitioning per environment
- Shared cookies within environment
- Minimal toolbar (back, forward, refresh, close)

### 13.3 Navigation
- Back/Forward buttons
- Refresh/Clear cache
- URL bar
- Mission Control (show all windows)

### 13.4 Session Isolation
- Per-environment cookies
- Separate auth sessions
- Cookie persistence

### 13.5 Authentication Support
- Google OAuth handling
- Microsoft OAuth handling
- OneReach authentication

### 13.6 Keep-Alive System
- Ping/pong monitoring
- Zombie window detection
- Emergency UI for lost connections
- Cleanup on close

---

# Part 14: Website Monitor

## Overview
Monitor websites for changes and automatically capture updates.

## Features

### 14.1 Monitor Configuration
- URL to monitor
- CSS selector for specific element
- Check interval (default: 1 hour)
- Target Space for captures

### 14.2 Change Detection
- Content hashing
- Diff generation
- Screenshot capture
- Notification on change

### 14.3 Notifications
- Desktop notifications
- In-app alerts
- Email (optional)

---

# Part 15: Web Scraper

## Overview
Utility for extracting content from web pages.

## Features

### 15.1 Scraping Methods
- Full HTML extraction
- CSS selector targeting
- Text-only extraction
- Structured data extraction

### 15.2 Options
- Wait for selectors
- Wait for network idle
- Custom user agent
- Resource blocking (images, CSS)

### 15.3 Output
- Raw HTML
- Cleaned text
- Structured JSON
- Screenshot

---

# Part 16: GSX File Sync

## Overview
Two-way synchronization with OneReach GSX cloud storage.

## Features

### 16.1 Sync Operations
- Upload to GSX
- Download from GSX
- Bi-directional sync
- Conflict resolution

### 16.2 Token Management
- Automatic token refresh
- Token validation
- Error recovery

### 16.3 Sync Paths
- Default sync paths (always synced)
- Optional paths (user-selected)
- Exclusion patterns

### 16.4 Progress Tracking
- Visual progress UI
- File count display
- Error reporting
- Sync history

---

# Part 17: Transcription Service

## Overview
Unified transcription using ElevenLabs Scribe for audio/video files.

## Features

### 17.1 Transcription Options
- Language auto-detection
- Manual language selection
- Speaker diarization
- Multi-channel support
- Word-level timestamps

### 17.2 Output Format
- Full text transcription
- Word array with timing
- Speaker IDs per word
- Confidence scores
- Language probability

### 17.3 Integration
- Video Editor integration
- Spaces item transcription
- Clipboard audio transcription

---

# Part 18: Release Manager

## Overview
Publish videos directly to YouTube and Vimeo.

## YouTube Features
- OAuth 2.0 authentication
- Resumable upload
- Privacy settings (Public, Unlisted, Private)
- Category selection
- Title, description, tags
- Thumbnail upload
- Playlist assignment

## Vimeo Features
- OAuth 2.0 authentication
- TUS resumable upload
- Privacy settings
- Title, description
- Password protection

---

# Part 19: Voice Task SDK

## Overview
SDK combining voice input with task management.

## Voice Features
- Real-time speech-to-text (OpenAI Realtime API)
- Fallback to Whisper API
- Voice commands (mute/unmute)
- Silence detection
- Floating orb UI

## Task Features
- Create tasks from voice
- List and filter tasks
- Sort by priority/date/status
- Update task status
- Delete tasks
- Tags and categories
- Due dates

---

# Part 20: Generative Search

## Overview
LLM-powered semantic filtering for Spaces items.

## Filter Types

### Context-Aware
- Related to Project
- Similar to Selected Item
- Useful For (custom goal)

### Quality Filters
- Quality Score
- Interesting/Novel
- Recent Favorites

### Purpose-Based
- Good Visual For
- Reference Material
- Working Example Of
- Inspiration For

### Content Analysis
- Has Actionable Insights
- Explains Concept
- Contains Data

### Organizational
- Needs Attention
- Likely Duplicates
- Incomplete Items

---

# Part 21: Settings & Configuration

## Categories

### General Settings
- Theme selection
- Startup behavior
- Window position memory

### AI/LLM Settings
- OpenAI API key
- Anthropic API key
- ElevenLabs API key
- Default model selection
- Provider preference

### Video Editor Settings
- Default export path
- Thumbnail quality
- Waveform resolution
- Auto-save interval

### Spaces Settings
- Storage location
- Backup frequency
- Sync settings

### Budget Settings
- Daily/Weekly/Monthly limits
- Alert thresholds
- Hard limit toggle
- Notification preferences

### Keyboard Shortcuts
- Global shortcuts
- App-specific shortcuts
- Customization

---

# Part 22: Keyboard Shortcuts

## Global Shortcuts
| Shortcut | Action |
|----------|--------|
| Cmd/Ctrl+Shift+V | Open Black Hole |
| Cmd/Ctrl+Shift+Space | Open Spaces |
| Cmd/Ctrl+, | Open Settings |
| Cmd/Ctrl+1-9 | Open IDW 1-9 |

## Video Editor
| Shortcut | Action |
|----------|--------|
| Space | Play/Pause |
| J | Play backward |
| K | Pause |
| L | Play forward |
| I | Set In point |
| O | Set Out point |
| M | Add marker |
| Left/Right | Frame step |
| Home | Go to start |
| End | Go to end |
| Cmd/Ctrl+Z | Undo |
| Cmd/Ctrl+Shift+Z | Redo |
| Cmd/Ctrl+S | Save |
| Cmd/Ctrl+E | Export |

## Spaces
| Shortcut | Action |
|----------|--------|
| Cmd/Ctrl+F | Search |
| Cmd/Ctrl+N | New Space |
| Delete | Delete item |
| Enter | Open item |

---

# Part 23: Technical Architecture

## Main Process (Electron)
- `main.js` - Main entry point
- `menu.js` - Application menu
- `browserWindow.js` - Window management
- IPC handlers for all features

## Renderer Processes
- Main window (tabbed browser)
- Video Editor window
- Spaces window
- Settings window
- GSX Create window
- Recorder window
- Black Hole widget

## Preload Scripts
| Script | Purpose |
|--------|---------|
| preload.js | Main window API bridge |
| preload-video-editor.js | Video editor API |
| preload-external-ai.js | AI agent capture |
| preload-recorder.js | Recorder API |
| preload-black-hole.js | Black Hole API |
| preload-minimal.js | Minimal API set |

## Data Storage
- **DuckDB**: Primary structured storage
- **JSON Files**: Configuration, preferences
- **File System**: Content files (images, videos, etc.)
- **localStorage**: UI state, undo stack

## External Dependencies
| Package | Purpose |
|---------|---------|
| fluent-ffmpeg | Video processing |
| puppeteer | Web scraping |
| playwright | Browser automation |
| @anthropic-ai/sdk | Claude API |
| docx | Word documents |
| exceljs | Excel files |
| pptxgenjs | PowerPoint |
| keytar | Secure credential storage |
| electron-updater | Auto-updates |
| youtube-dl-exec | YouTube downloads |

---

*This documentation covers all major features of Onereach.ai v3.8.15. For specific API documentation, see the inline code comments and JSDoc annotations in the source files.*
