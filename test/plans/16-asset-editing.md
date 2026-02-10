# Asset Editing Test Plan

## Prerequisites

- App running (`npm start`)
- Spaces API healthy on port 47291
- A test space with items of each type: text, code, image, HTML, PDF, video, audio
- FFmpeg available (for video/audio operations)
- Video Editor accessible

## Features Documentation

Each asset type in Spaces supports different editing capabilities. Text and code items can be edited inline in the metadata modal or Spaces UI. Images support viewing and metadata editing. HTML items have a rich preview and source editing mode. PDFs support viewing and metadata editing. Video items integrate with the Video Editor for trim, splice, speed change, reverse, and audio replacement. Audio items support extraction, playback, and speaker identification via the transcription service.

**Key files:** `clipboard-viewer.js` (inline editing), `video-editor.js` + `src/video/ipc/VideoEditorIPC.js` (video ops), `src/transcription/TranscriptionService.js` (audio)
**Video IPC:** `video-editor:trim`, `video-editor:splice`, `video-editor:change-speed`, `video-editor:reverse`, `video-editor:extract-audio`
**Window:** Video Editor via `video-editor.html`, Spaces UI via `clipboard-viewer.html`

## Checklist

### Text/Code Editing
- [ ] `[M]` Open text item in Spaces UI -- content displays correctly
- [ ] `[M]` Edit text content inline -- changes save and persist (verify via API)
- [ ] `[M]` Code item displays with syntax highlighting
- [ ] `[P]` Update item content via API (`PUT /api/spaces/:id/items/:itemId`) -- content updates

### Image Viewing
- [ ] `[M]` Open image item -- image renders in preview panel
- [ ] `[M]` Image metadata modal shows AI-generated fields (title, description, tags)

### HTML Editing
- [ ] `[M]` Open HTML item -- rich preview renders correctly
- [ ] `[M]` Switch to source view -- raw HTML editable
- [ ] `[M]` Save edited HTML -- changes persist

### PDF Viewing
- [ ] `[M]` Open PDF item -- PDF renders in viewer
- [ ] `[M]` PDF metadata editable (title, description, tags)

### Video Editing
- [ ] `[A]` `video-editor:get-info` returns video metadata (duration, resolution, codec)
- [ ] `[A]` `video-editor:generate-thumbnail` creates a thumbnail image
- [ ] `[P]` `video-editor:trim` trims video to specified start/end times
- [ ] `[P]` `video-editor:extract-audio` extracts audio track from video

## Automation Notes

- **Existing coverage:** None
- **Gaps:** All items need new tests
- **Spec file:** Video IPC tests in `test/e2e/video-editor.spec.js`; text/HTML editing mostly manual
- **Strategy:** Video IPC operations testable via `electronApp.evaluate` with test media files
- **Note:** Most editing tests are `[M]` because they require visual verification of rendered content
- **Dependency:** Video tests need a small test video file in `test/fixtures/`
