# Legacy Code Archive

This folder contains deprecated code that has been replaced by the new modular architecture.

## Files

| File | Replaced By | Status |
|------|-------------|--------|
| `video-editor.js` | `src/video/` | Deprecated Dec 2025 |

## Why Archived?

The monolithic `video-editor.js` (3600+ lines) was refactored into a clean modular architecture:

```
src/video/
├── core/           # VideoProcessor, ThumbnailService, WaveformService
├── editing/        # TrimService, TranscodeService, SpliceService, etc.
├── audio/          # AudioExtractor, AudioReplacer, ElevenLabsService
├── scenes/         # SceneDetector, SceneManager
├── translation/    # TranslationPipeline, TranslationEvaluator
├── export/         # PlaylistExporter, ScreengrabService, SlideshowService
├── ipc/            # VideoEditorIPC (all IPC handlers)
└── index.js        # Main VideoEditor coordinator class
```

## Do Not Use

These files are kept for reference only. The application now uses:

```javascript
// main.js
const { VideoEditor } = require('./src/video/index.js');
```

## Removal Plan

These files will be permanently deleted in a future release after the modular architecture has been validated in production.


















