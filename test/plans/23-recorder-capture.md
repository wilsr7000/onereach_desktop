# 23 -- Recorder & GSX Capture

## Overview

Screen, camera, and audio recording tool with live transcription, meeting HUD, P2P session sharing, multi-source audio mixing, and save-to-Space integration.

**Key files:** `recorder.html`, `recorder.js`, `preload-recorder.js`, `lib/capture-signaling.js`

## Prerequisites

- App running with camera and microphone permissions granted
- macOS screen recording permission granted
- OpenAI API key configured (for Whisper live transcription)
- At least one Space created (for save-to-Space)

## Features

### Recording Modes
- **Camera:** Front-facing camera capture with live preview
- **Screen:** Screen/window picker with source selection grid
- **Camera + Screen:** PiP camera overlay (200x150px, draggable) on screen recording

### Recording Controls
- Record button (large red with pulse animation)
- 3-2-1 countdown before recording starts
- Pause/resume during recording
- Stop recording
- Duration display (monospace timer with target duration)
- Recording indicator (animated red dot + "REC")

### Audio Mixing
- Multi-source mixer panel with 4 sources:
  - Microphone (0-150% volume)
  - Desktop audio (0-150% volume)
  - External 1 (0-150% volume)
  - External 2 (0-150% volume)
- Volume sliders per source
- Audio level meter (real-time bar visualization)

### Live Transcription
- Real-time Whisper-based transcription during recording
- Transcript display in Meeting HUD

### Meeting HUD
- Slide-in right sidebar panel
- Agent toggles for meeting intelligence
- Item categories: action items, decisions, notes, bookmarks
- Manual entry input field
- Filter and count indicators
- Agent integration for automated categorization

### P2P Session Sharing
- WebRTC-based session creation
- Signaling (offer/answer/ICE)
- Join existing session
- Session status and roster

### Review Mode
- Playback recorded video after stopping
- Discard recording
- Record again
- Save to Space

### Save to Space
- Filename input
- Space picker dropdown
- Project picker dropdown
- Saves base64 blob via IPC to clipboard manager

### Permission Handling
- macOS camera/microphone permission detection
- Screen recording permission request
- Permission request overlay in UI

### Keyboard Shortcuts
- Space: start/stop recording
- Esc: stop recording
- S: save
- Comma: open settings panel

---

## Checklist

### Window Lifecycle
- [ ] [A] Recorder window opens via Video Editor or IPC
- [ ] [A] Window loads without console errors
- [ ] [A] Window closes cleanly

### Permission Handling
- [ ] [A] Camera permission status checked via `recorder:request-permissions`
- [ ] [A] Microphone permission status checked
- [ ] [M] Permission request overlay displays when permissions not granted
- [ ] [M] Granting permissions removes the overlay

### Recording Modes
- [ ] [M] Camera mode shows live camera preview
- [ ] [M] Screen mode opens source picker grid
- [ ] [M] Screen source picker shows available windows/screens
- [ ] [M] Camera + Screen mode shows PiP overlay on screen recording
- [ ] [M] PiP overlay is draggable

### Recording Controls
- [ ] [M] Record button starts 3-2-1 countdown
- [ ] [M] Recording starts after countdown
- [ ] [M] Recording indicator (red dot + "REC") appears
- [ ] [M] Duration display counts up during recording
- [ ] [M] Pause button pauses recording
- [ ] [M] Resume continues recording
- [ ] [M] Stop button ends recording

### Audio Mixing
- [ ] [M] Mixer panel shows 4 audio sources
- [ ] [M] Volume sliders adjust from 0-150%
- [ ] [M] Audio level meter responds to microphone input
- [ ] [M] Desktop audio toggle enables system audio capture

### Live Transcription
- [ ] [P] Transcription starts automatically when OpenAI key is configured
- [ ] [P] Real-time text appears during recording
- [ ] [A] Transcript saved via `recorder:write-live-transcript`

### Meeting HUD
- [ ] [M] Meeting HUD toggle opens slide-in sidebar
- [ ] [M] Action items, decisions, notes, bookmarks categories visible
- [ ] [M] Manual entry input creates new items
- [ ] [P] Agent integration categorizes content automatically
- [ ] [M] Filter controls work for each category

### Review Mode
- [ ] [M] After stopping, recorded video plays back in preview
- [ ] [M] "Discard" removes the recording
- [ ] [M] "Record Again" resets to recording mode
- [ ] [M] "Save to Space" opens save dialog

### Save to Space
- [ ] [M] Save dialog shows filename input
- [ ] [M] Space picker dropdown lists available Spaces
- [ ] [M] Project picker lists projects in selected Space
- [ ] [A] Save operation calls `recorder:save-to-space` IPC
- [ ] [A] Saved recording appears in the selected Space

### P2P Session Sharing
- [ ] [A] `recorder:session-create` creates a new session
- [ ] [A] `recorder:session-find` finds an existing session
- [ ] [A] `recorder:session-answer` posts an answer
- [ ] [A] `recorder:session-cleanup-signaling` cleans up
- [ ] [M] Session status displays in UI

### Keyboard Shortcuts
- [ ] [M] Space bar starts/stops recording
- [ ] [M] Escape stops recording
- [ ] [M] S key triggers save
- [ ] [M] Comma key opens settings panel

### Screen Sources
- [ ] [A] `recorder:get-screen-sources` returns available sources
- [ ] [M] Source picker grid shows thumbnails for each source
- [ ] [M] Selecting a source starts screen capture

---

## Automation Notes

- Window lifecycle testable via IPC
- Permission tests need macOS system preference mocking or pre-granted permissions
- Recording tests require actual media devices (camera/mic) -- mostly manual
- Audio mixing tests require audio input -- manual verification
- P2P signaling IPC methods are testable programmatically
- Save-to-Space flow can be tested by mocking the recording blob
- Live transcription requires OpenAI API key and real audio -- use short test clips
- Meeting HUD DOM interactions can be partially automated via Playwright
