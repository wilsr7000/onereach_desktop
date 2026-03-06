# ADR Multi-Track Workflow - Implementation Complete ✅

## Overview

A professional **Automated Dialogue Replacement (ADR)** system for non-destructive audio editing with multi-track support, fill tracks, and AI voice generation.

---

## 7-Phase Implementation

### ✅ Phase 1: Track Duplication
**Feature**: Right-click on any track label → "Duplicate Track"

**Files**:
- `adr-track-manager.js` - `ADRTrackManager` and `TrackContextMenu` classes
- `video-editor.html` - Script tag loading
- `video-editor-app.js` - `initADRManager()` method
- `video-editor.css` - Context menu styling

**Usage**:
1. Right-click on "Original" track (A1)
2. Select "Duplicate Track"
3. New "Working" track appears with visual waveform representation

---

### ✅ Phase 2: Insert Silence
**Feature**: Mark dead space regions on Working track (visual-only, no audio processing)

**UI**: Range marker modal → "Insert Silence" button

**What happens**:
1. Creates Working track if doesn't exist
2. Adds dead space region metadata
3. Renders orange hatched pattern on timeline

**Code**:
```javascript
// In range modal
app.insertSilence(); 

// Creates Working track + marks region
adrManager.insertSilence(startTime, endTime, name);
```

---

### ✅ Phase 3: Re-record with AI
**Feature**: One-click ADR workflow - inserts silence + generates AI voice + adds to ADR track

**UI**: Range marker modal → "Re-record with AI" button (purple gradient)

**Workflow**:
1. Calls `insertSilence()` (Phase 2)
2. Ensures ADR track exists
3. Generates ElevenLabs audio from transcription
4. Adds purple ADR clip to timeline

**Code**:
```javascript
await app.rerecordWithAI();
// → insertSilence()
// → generateElevenLabsAudio()
// → add clip to ADR track
```

---

### ✅ Phase 4: Voice Selection
**Feature**: Choose from 9 ElevenLabs voices when re-recording

**UI**: Dropdown in Re-record section

**Voices**:
- Rachel (Female, Calm) - Default
- Domi (Female, Strong)
- Bella (Female, Soft)
- Antoni (Male, Well-Rounded)
- Elli (Female, Emotional)
- Josh (Male, Deep)
- Arnold (Male, Crisp)
- Adam (Male, Narrative)
- Sam (Male, Raspy)

---

### ✅ Phase 5: Custom Voice Creation
**Feature**: Clone voice from any track using ElevenLabs voice cloning API

**UI**: Right-click track → "Create Custom Voice from Track"

**Process**:
1. Extracts 30-60 seconds of audio from track
2. Uploads to ElevenLabs `/v1/voices/add` endpoint
3. Adds custom voice to dropdown with "(Custom)" label

**Backend**: `createCustomVoiceClone()` - Multipart form upload

---

### ✅ Phase 6: Fill Track (Room Tone)
**Feature**: Auto-extract ambient background noise for natural ADR mixing

**UI**: Right-click Original track → "Create Fill Track (Room Tone)"

**Process**:
1. Uses FFmpeg `silencedetect` to find quiet sections
2. Extracts 5-10 seconds from longest quiet section
3. Creates Fill track with looping room tone
4. Renders cyan striped pattern on timeline

**Backend**: `findQuietSections()` - FFmpeg audio analysis

---

### ✅ Phase 7: Export
**Feature**: Final export merges all tracks into output video

**Triggered**: Click Export button → Detects ADR changes → Confirms with user

**Audio Mixing Layers**:
1. **Base**: Original audio with silence at dead space regions
2. **Layer 1**: Fill track room tone (looped to fill dead space)
3. **Layer 2**: ADR clips (overlaid at their timestamps)

**Backend Process**:
```javascript
exportWithADRTracks(videoPath, exportData) {
  // 1. Extract video stream (no audio)
  // 2. Extract original audio
  // 3. Apply silence to dead space regions
  // 4. Loop fill track room tone
  // 5. Mix: Working + Fill + ADR clips
  // 6. Merge mixed audio with video
}
```

**FFmpeg Operations**:
- Video extraction: `-an -vcodec copy`
- Silence application: `volume=enable='between(t,start,end)':volume=0`
- Room tone looping: `-stream_loop -1 -t duration`
- Audio mixing: `amix=inputs=N:duration=first`
- Final merge: `-vcodec copy -acodec aac`

---

## File Structure

```
/adr-track-manager.js          # ~950 lines - Core ADR logic
/video-editor.html             # UI elements, buttons, voice selector
/video-editor-app.js           # ~11,700 lines - Integration, wrappers
/video-editor.css              # Styling for dead space, clips, tracks
/video-editor.js               # ~3,900 lines - Backend FFmpeg operations
/preload-video-editor.js       # IPC exposures
```

---

## Track Types

| Type | Purpose | Color | Created When |
|------|---------|-------|--------------|
| `original` | Source video audio | Blue | Always present |
| `working` | Visual-only dead space markers | Orange | First "Insert Silence" |
| `adr` | ElevenLabs replacement clips | Purple | First "Re-record with AI" |
| `fill` | Room tone background | Cyan | "Create Fill Track" |
| `voice` | Legacy voice clips | Pink | Legacy workflow |
| `sfx` | Sound effects | Yellow | Manual creation |

---

## Usage Workflow

### Basic ADR Workflow
1. Load video with dialogue
2. Click word in transcript → Create range marker
3. Click "Re-record with AI" → Generates ADR
4. Export → Final video with ADR applied

### Professional ADR Workflow
1. Load video
2. **Create Fill Track**: Right-click Original → "Create Fill Track"
3. **Mark ranges** in transcript for ADR
4. **Re-record multiple sections** with AI
5. **Optional**: Create custom voice from original track
6. **Export** → Professional ADR with room tone matching

---

## Key Features

### Non-Destructive Editing
- Original video never modified
- Dead space is visual-only (metadata)
- ADR clips stored separately
- All processing happens at export time

### Visual Feedback
- **Orange hatched pattern**: Dead space regions
- **Purple gradient clips**: ADR replacements
- **Cyan stripes**: Fill track room tone
- **Blue clips**: Visual reference (duplicated tracks)

### Performance
- Waveform/thumbnail caching to disk
- Video stream copy (no re-encoding until export)
- Parallel FFmpeg operations where possible

---

## API Reference

### ADRTrackManager Methods

```javascript
// Track operations
adrManager.duplicateTrack(trackId, options)
adrManager.ensureWorkingTrack()
adrManager.ensureADRTrack()
adrManager.findTrack(trackId)
adrManager.findTrackByType(type)

// ADR workflow
adrManager.insertSilence(startTime, endTime, name)
adrManager.rerecordWithAI(startTime, endTime, text, name, voice)
adrManager.renderDeadSpaceRegions()

// Advanced
adrManager.createCustomVoice(trackId, voiceName)
adrManager.createFillTrack()
adrManager.exportWithADRTracks()
```

### App Integration

```javascript
// In video-editor-app.js
app.insertSilence()           // From range modal
app.rerecordWithAI()          // From range modal
app.exportWithADR()           // From export button
app.initADRManager()          // Called in init()
```

---

## Backend Methods (video-editor.js)

```javascript
// ElevenLabs
generateElevenLabsAudio(text, voice)
createCustomVoiceClone({ name, audioPath })

// Audio analysis
findQuietSections(videoPath, options)

// Export
exportWithADRTracks(videoPath, exportData)
  ├─ _extractVideoStream()
  ├─ _extractAudioStream()
  ├─ _applyDeadSpaceRegions()
  ├─ _createLoopedFill()
  ├─ _mixAudioLayers()
  └─ _mergeVideoAndAudio()
```

---

## Configuration

### Voice IDs (ElevenLabs)
Defined in `ElevenLabsService.js`:
```javascript
{
  'Rachel': '21m00Tcm4TlvDq8ikWAM',
  'Domi': 'AZnzlk1XvdvUeBnXmlld',
  'Bella': 'EXAVITQu4vr4xnSDxMaL',
  // ... etc
}
```

### Custom Voices
Stored in `app.customVoices`:
```javascript
[{
  id: 'voice_xyz',
  name: 'My Custom Voice',
  createdFrom: 'Original',
  createdAt: '2025-12-17T...'
}]
```

---

## Testing Checklist

- [ ] **Phase 1**: Right-click track → Duplicate appears → New track created
- [ ] **Phase 2**: Range marker → Insert Silence → Orange dead space visible
- [ ] **Phase 3**: Range with text → Re-record → Purple ADR clip appears
- [ ] **Phase 4**: Change voice dropdown → Re-record → Different voice
- [ ] **Phase 5**: Right-click → Create Voice → Appears in dropdown
- [ ] **Phase 6**: Right-click Original → Fill Track → Cyan pattern appears
- [ ] **Phase 7**: Export button → ADR detected → Final video with ADR

---

## Known Limitations

1. **Room tone detection**: May not find quiet sections in very noisy videos
2. **Audio sync**: ADR clips must match original timing (no automatic alignment)
3. **Voice cloning**: Requires ElevenLabs API key and quota
4. **Export time**: Complex FFmpeg operations may take time for long videos

---

## Future Enhancements

- [ ] Visual waveform on ADR clips
- [ ] Drag to reposition ADR clips
- [ ] Real-time playback preview (multi-track mixing)
- [ ] Batch ADR export (multiple ranges at once)
- [ ] Custom room tone upload (vs auto-detect)
- [ ] ADR clip trimming/editing
- [ ] Export presets (quality, format options)

---

## Troubleshooting

**Context menu doesn't appear**:
- Reload the video editor window
- Check console for: `[ADRTrackManager] Initialized`

**Re-record button hidden**:
- Ensure marker type is "Range" (not "Spot")
- Enter transcription text
- Button appears when both conditions met

**Export fails**:
- Check for ADR clips with missing audio files
- Verify ElevenLabs API key is set
- Check console for FFmpeg errors

**No room tone found**:
- Video may not have quiet sections
- Fill track will use silence instead
- Can still proceed with ADR

---

## Architecture Notes

### Why Global Class Pattern?

The ADR module uses `window.ADRTrackManager` instead of ES modules because:
1. **Electron compatibility**: File:// protocol has ES module issues
2. **Script tag loading**: Works reliably in all contexts
3. **IDE-friendly**: Separate file keeps `video-editor-app.js` from growing
4. **Gradual adoption**: Can migrate other features the same way

### Module Size
- `adr-track-manager.js`: ~950 lines (all 7 phases)
- Kept `video-editor-app.js` at ~11,700 lines (was 12,000+)
- `video-editor-beats.js`: ~780 lines (extracted separately)

---

Generated: December 17, 2025
Version: 1.0.0




