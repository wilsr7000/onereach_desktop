# ADR Workflow - Quick Start Guide

## 🎬 Complete Professional ADR in 5 Minutes

### Prerequisites
- ElevenLabs API key configured in Settings
- Video with dialogue loaded in Video Editor

---

## Quick Workflow

### 1. Create Fill Track (Optional but Recommended)
**Right-click Original track** → "Create Fill Track (Room Tone)"

What happens:
- Analyzes video for quiet sections
- Extracts 5-10 seconds of room tone
- Creates cyan Fill track that loops throughout video

---

### 2. Mark ADR Ranges
**Click words in transcript** to create range markers:
- Click first word → Sets IN point
- Click last word → Sets OUT point
- Modal opens automatically

---

### 3. Re-record with AI
In the range marker modal:
1. **Select voice** from dropdown (Rachel is default)
2. **Enter/edit transcription** (auto-filled from transcript)
3. **Click "Re-record with AI"** (purple button)

What happens:
- Working track created (if needed)
- Orange dead space region appears
- ADR track created (if needed)
- Purple ADR clip generated and added
- Modal closes

Repeat for as many ranges as needed!

---

### 4. Export Final Video
**Click Export button** in toolbar

What happens:
- Detects ADR changes
- Shows confirmation with summary
- Merges all audio layers:
  - Original audio (with silence in dead space regions)
  - Fill track (room tone looping in background)
  - ADR clips (your AI-generated dialogue)
- Exports final video with professional ADR

---

## Advanced Features

### Create Custom Voice
**Right-click any track** → "Create Custom Voice from Track"
- Clones the voice from that track's audio
- Adds to voice dropdown
- Use for consistent voice across all ADR

### Track Operations
**Right-click any track**:
- Duplicate Track
- Rename Track
- Solo/Mute Track
- Create Custom Voice
- Delete Track (except Original)

---

## Visual Guide

### Track Colors
- 🔵 **Blue** - Original audio (never modified)
- 🟠 **Orange hatched** - Dead space (silence regions)
- 🟣 **Purple** - ADR clips (AI-generated dialogue)
- 🔵 **Cyan stripes** - Fill track (room tone)

### Timeline View
```
┌─────────────────────────────────────────┐
│ V1  [████████ Video Track ███████████] │
│ A1  [████████ Original ██████████████] │ ← Right-click here
│ A2  [███ 🔇  ████ 🔇  █████████████]  │ ← Working (orange gaps)
│ A3  [     🎙️       🎙️               ] │ ← ADR clips
│ A4  [▓▓▓▓▓▓▓▓▓▓▓ Room Tone ▓▓▓▓▓▓▓▓▓] │ ← Fill (loops)
└─────────────────────────────────────────┘
```

---

## Keyboard Shortcuts

- **M** - Add marker at playhead
- **I** - Mark IN point (start range)
- **O** - Mark OUT point (end range)
- **Space** - Play/Pause
- **⌘D** - Duplicate track (from context menu)

---

## Pro Tips

1. **Create fill track first** - Better ambient matching
2. **Use short ranges** - 5-15 seconds ideal for ADR
3. **Test voices** - Try different voices for best match
4. **Clone original voice** - Most natural results
5. **Export often** - Save incremental versions

---

## Troubleshooting

**"Re-record with AI" button not showing?**
→ Make sure marker type is "Range" (not "Spot") and transcription field has text

**No context menu on track?**
→ Reload the video editor window (should see console logs about ADR initialization)

**Export fails?**
→ Check console for FFmpeg errors, ensure all ADR clips still have audio files

**No room tone found?**
→ Your video may be too noisy - Fill track will use silence (still works for export)

---

## Files Modified

**Core ADR Module**:
- `adr-track-manager.js` (~950 lines) - All ADR logic

**Integration**:
- `video-editor-app.js` - Wrapper methods, UI integration
- `video-editor.html` - Buttons, voice selector, modal updates
- `video-editor.css` - Visual styling for tracks and clips
- `video-editor.js` - Backend FFmpeg operations, voice cloning
- `preload-video-editor.js` - IPC exposures

---

Ready to test! See `ADR_WORKFLOW_IMPLEMENTATION.md` for detailed technical documentation.




