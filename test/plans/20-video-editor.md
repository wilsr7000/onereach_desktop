# 20 -- Video Editor

## Overview

Full non-linear editor (NLE) with timeline, multi-track audio, markers, translation pipeline, ADR, audio sweetening, teleprompter, version management, production planning, and line script system.

**Key files:** `video-editor.html`, `video-editor.js`, `video-editor-app.js`, `preload-video-editor.js`, `src/video/`, `src/video-editor/`

## Prerequisites

- App running with FFmpeg bundled (included in app resources)
- At least one video file available (local or in a Space)
- ElevenLabs API key configured (for TTS/ADR/sweetening tests)
- Anthropic API key configured (for translation/scene description tests)

## Features

### Core Editor
- Open video files from local filesystem or Spaces
- Three layout modes: Edit, Line Script, Story Beats
- Video preview with detach-to-window option
- Video controls: play/pause, skip back/forward, volume, time display
- Undo/redo stack
- Export and release workflows

### Timeline
- Zoomable timeline with presets (Fit, 30s, 1m, 2m, 5m, 10m)
- Ruler with time markers
- Video track (V1) with clip thumbnails
- Audio waveform track
- Dynamic audio tracks: Voice, Dub, Music, SFX, Ambience, Blank
- Add track menu
- Markers track with scene/range markers
- Region action bar (Translate, AI Video, Sweetening)
- Segment navigation

### Tools Sidebar
- **Trim:** Start/end time inputs
- **Splice:** Cut start/end, remove section
- **Convert:** Format, resolution, quality selectors
- **Quick Tools:** Extract Audio, Compress, Generate Thumbnails, Transcribe
- **Markers:** Add scene marker, set IN/OUT points, marker navigation
- **Video Info:** Duration, resolution, FPS, codec, bitrate display

### Markers & Story Beats
- Point markers and range markers
- Marker properties: type, name, time, color, description, transcription, tags, notes
- Screen grab from marker position
- ADR actions on markers (insert silence, re-record with AI voice)
- Story Beats editor with mini timeline

### Translation Pipeline
- Multi-language translation with quality scoring
- Quality dimensions: accuracy, fluency, adequacy, cultural, timing
- Iterative refinement (1/3/5 passes)
- TTS voice generation for translated audio

### ADR (Automated Dialogue Replacement)
- Insert silence in timeline
- Re-record with ElevenLabs AI voices
- Voice selection and preview

### Audio Sweetening
- ElevenLabs SFX integration
- Categories: whoosh, impact, ambient, transition, UI sounds
- Insert SFX at timeline position

### Teleprompter
- Horizontal scrolling transcript overlay on video
- Sync to video playback position
- Toggle on/off

### Waveform Visualization
- Configurable display settings
- Waveform settings modal

### Version Management
- Git-like branching and versioning
- Version tree modal with visual branch graph
- Create branch, switch branch, compare branches
- Side-by-side diff viewer (files changed, insertions, deletions)

### Project Management
- Spaces integration for projects
- Create project modal
- Project versions and assets

### Production Planning Panel
- Right sidebar with tabs: Characters, Scenes, Locations, Story Beats
- Add/import/export for each category
- AI-enhanced metadata generation

### Line Script System
- AI-enhanced spotting with templates (Podcast, Product, Promo, Learning)
- 4 modes: Spot, Edit, Review, Export
- Voice spotting commands
- Stats, timecode, transcript display
- Mini timeline
- Keyboard shortcut reference
- Adaptive mode switching

### Playlist Builder
- Drag-and-drop playlist assembly
- AI-powered playlist generation

---

## Checklist

### Window Lifecycle
- [ ] [A] Video Editor window opens via menu (Cmd+Shift+V) or IPC
- [ ] [A] Window loads without console errors
- [ ] [A] Window closes cleanly without orphaned processes
- [ ] [M] All three layout modes (Edit, Line Script, Story Beats) render correctly

### File Operations
- [ ] [M] Open video file from local filesystem via file dialog
- [ ] [P] Open video from Spaces via media browser sidebar
- [ ] [A] Video info populates (duration, resolution, FPS, codec, bitrate)
- [ ] [M] Save project to Space

### Video Preview
- [ ] [M] Video loads and displays in preview area
- [ ] [M] Play/pause toggles playback
- [ ] [M] Skip forward/back buttons work
- [ ] [M] Volume slider adjusts audio
- [ ] [M] Time display updates during playback
- [ ] [M] Detach player opens `detached-video-player.html` in separate window

### Timeline
- [ ] [M] Timeline renders with ruler and time markers
- [ ] [M] Zoom presets change timeline scale (Fit, 30s, 1m, etc.)
- [ ] [M] Video track shows clip representation
- [ ] [M] Audio waveform track renders waveform
- [ ] [M] Clicking timeline seeks video to that position
- [ ] [M] Markers appear on markers track

### Trim Tool
- [ ] [P] Setting start/end times and applying trim produces correct output
- [ ] [A] Trim with fade-in/fade-out applies effects correctly (FFmpeg verification)
- [ ] [A] Trim without fades uses stream copy (fast, no re-encode)

### Splice Tool
- [ ] [P] Cut start/end removes a section from the video
- [ ] [P] "Remove Section" button executes the splice

### Convert Tool
- [ ] [P] Format selector lists available output formats
- [ ] [P] Resolution and quality options apply to export
- [ ] [A] Conversion produces a valid output file in the selected format

### Quick Tools
- [ ] [A] "Extract Audio" produces an audio-only file
- [ ] [A] "Compress" reduces file size
- [ ] [A] "Generate Thumbnails" produces thumbnail images at intervals
- [ ] [P] "Transcribe" sends audio to Whisper and returns transcript

### Markers
- [ ] [M] Add scene marker at current position
- [ ] [M] Set IN/OUT points for range selection
- [ ] [M] Edit marker properties (name, color, description, tags)
- [ ] [M] Navigate between markers
- [ ] [P] Screen grab captures frame at marker position
- [ ] [M] Marker appears on timeline markers track

### Translation Pipeline
- [ ] [P] Select target language and quality iterations
- [ ] [P] Translation produces translated text with quality scores
- [ ] [P] Quality dimensions (accuracy, fluency, adequacy, cultural, timing) display scores
- [ ] [P] TTS generates audio from translated text

### ADR
- [ ] [M] Insert silence at selected range
- [ ] [P] Re-record with AI voice (ElevenLabs) produces audio
- [ ] [M] Voice selection dropdown lists available voices

### Audio Sweetening
- [ ] [P] Browse SFX categories (whoosh, impact, ambient, etc.)
- [ ] [P] Generate SFX via ElevenLabs API
- [ ] [M] Insert SFX at timeline position

### Teleprompter
- [ ] [M] Toggle teleprompter overlay on/off
- [ ] [M] Transcript scrolls horizontally synced to playback
- [ ] [M] Teleprompter text is readable over video

### Waveform
- [ ] [M] Waveform renders for loaded video audio
- [ ] [M] Waveform settings modal opens and applies changes

### Version Management
- [ ] [A] Create new version from current state
- [ ] [A] Create branch from version
- [ ] [A] Switch between branches
- [ ] [M] Version tree modal shows visual branch graph
- [ ] [P] Compare branches shows diff (files changed, insertions, deletions)

### Project Management
- [ ] [M] Create project modal opens and accepts name/description
- [ ] [A] Project saves to Space with version metadata
- [ ] [P] Project assets are tracked and listable

### Production Planning
- [ ] [M] Planning panel opens with Characters/Scenes/Locations/Beats tabs
- [ ] [M] Add items to each category
- [ ] [P] Import/export planning data

### Line Script
- [ ] [M] Template selector switches between Podcast/Product/Promo/Learning
- [ ] [M] Mode controls switch between Spot/Edit/Review/Export
- [ ] [M] Transcript and timecode display for spotted segments
- [ ] [P] Voice spotting captures commands
- [ ] [P] AI generate metadata populates from content

### Export & Release
- [ ] [P] Export produces output file in selected format/resolution
- [ ] [M] Export progress modal shows during processing
- [ ] [P] Release workflow completes without errors

### Playlist
- [ ] [M] Drag-and-drop clips into playlist order
- [ ] [P] AI-powered playlist generation produces a coherent sequence

---

## Automation Notes

- Window lifecycle tests can use existing `window-smoke.spec.js` pattern
- FFmpeg operations (trim, splice, convert, thumbnails, audio extract) are testable via IPC from Playwright
- Translation and ADR tests require API keys and cost real money; mock for CI, test with real keys locally
- Timeline and UI interactions mostly require manual verification due to canvas/complex DOM
- Version management uses git operations that can be tested via IPC
- Line Script and Story Beats modes are layout changes testable via DOM class checks
