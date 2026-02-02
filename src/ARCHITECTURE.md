# Modular Architecture Guide

This document describes the modular architecture used in the `src/` directory.

## Overview

The codebase follows a modular, service-oriented architecture where each module is self-contained and focused on a single responsibility.

## Directory Structure

```
src/
├── video/              # Backend video processing (Electron main process)
├── video-editor/       # Frontend video editor UI modules (renderer process)
├── agentic-player/     # AI-driven video player
├── recorder/           # Screen/camera recording
├── aider/              # Aider integration (TypeScript)
└── templates/          # Template definitions (TypeScript)
```

## Module Details

### `src/video/` - Backend Video Processing

**Entry Point:** `src/video/index.js` exports `VideoEditor` class

```javascript
const { VideoEditor } = require('./src/video/index.js');
const videoEditor = new VideoEditor();
videoEditor.setupIPC(mainWindow);
```

**Services:**

| Directory | Services | Purpose |
|-----------|----------|---------|
| `core/` | VideoProcessor, ThumbnailService, WaveformService | Core FFmpeg operations |
| `editing/` | TrimService, TranscodeService, SpliceService, ConcatenateService, SpeedService, WatermarkService | Video editing operations |
| `audio/` | AudioExtractor, AudioReplacer, ElevenLabsService | Audio processing |
| `scenes/` | SceneDetector, SceneManager | Scene detection & workflow |
| `translation/` | TranslationPipeline, TranslationEvaluator | Multi-LLM translation |
| `export/` | PlaylistExporter, ScreengrabService, SlideshowService | Export operations |
| `ipc/` | VideoEditorIPC | All IPC handler registration |

### `src/video-editor/` - Frontend UI Modules

**Entry Point:** `src/video-editor/index.js` exports `initVideoEditorModules()`

```javascript
import { initVideoEditorModules } from './src/video-editor/index.js';
const modules = initVideoEditorModules(app);
```

**Modules:**

| Directory | Components | Purpose |
|-----------|------------|---------|
| `teleprompter/` | TeleprompterUI, TranscriptSync, TeleprompterMarkers | Transcript display |
| `waveform/` | WaveformRenderer, WaveformCache, WaveformTypes | Audio visualization |
| `markers/` | MarkerManager, MarkerRenderer, MarkerModal | Video markers |
| `utils/` | TimeFormatter, ContextMenu | Shared utilities |

### `src/agentic-player/` - AI Video Player

**Entry Point:** `src/agentic-player/index.js` exports `createPlayer()`

```javascript
import { createPlayer } from './src/agentic-player/index.js';
const player = createPlayer();
```

### `src/recorder/` - Recording Module

**Entry Point:** `src/recorder/index.js` exports `createRecorder()`

```javascript
import { createRecorder } from './src/recorder/index.js';
const recorder = createRecorder();
```

## Design Principles

1. **Single Responsibility** - Each service handles one concern
2. **Factory Functions** - Top-level modules use factory patterns
3. **Dependency Injection** - Services receive dependencies via constructor
4. **Progress Callbacks** - Long operations support progress reporting
5. **Unified Facades** - Coordinator classes provide simple APIs

## Adding New Features

1. Create a new service class in the appropriate directory
2. Export from the directory's `index.js`
3. Import into the main coordinator class
4. Add IPC handler if needed in `VideoEditorIPC.js`

## Migration from Legacy

The old monolithic `video-editor.js` has been archived to `_legacy/`. Do not use it.


















