# What's New in Video Editor 🎬

## Two Powerful New Features!

### 1. 🎙️ Replace Audio with ElevenLabs AI

**Generate AI voice from transcriptions and replace audio in video segments!**

#### Where to Find It
- Open/Edit a **Range Marker** in the modal
- Add transcription (type or auto-transcribe)
- Button appears: **"🎙️ Replace Audio with ElevenLabs"**

#### How It Works
1. Mark IN and OUT points on your video
2. Click "🎤 Auto-Transcribe" to get text
3. Click "🎙️ Replace Audio with ElevenLabs"
4. Wait ~30 seconds for AI voice generation
5. New video created with AI-replaced audio!

#### Features
- ✅ 9 pre-configured AI voices (Rachel, Domi, Bella, Antoni, Josh, etc.)
- ✅ Preserves video quality
- ✅ Keeps audio before/after the range unchanged
- ✅ High-quality AI voice synthesis
- ✅ Perfect for dubbing, re-voicing, or improving audio

#### Setup Required
```bash
export ELEVENLABS_API_KEY="your-api-key-here"
```
Get your key at: https://elevenlabs.io

---

### 2. ⚡ Smart Transcription

**Auto-Transcribe now checks for existing transcriptions first!**

#### What Changed
Before:
- Always called OpenAI Whisper API
- Cost: ~$0.006 per minute
- Time: 10-30 seconds

After:
- Checks Space metadata for existing transcription
- Extracts relevant portion based on timecode
- Only calls OpenAI if needed
- Cost: **$0.00** for videos with existing transcription
- Time: **< 1 second** for instant extraction

#### Benefits
- **YouTube Videos**: Instant transcription extraction from captions
- **Previously Transcribed**: Reuse existing data
- **Cost Savings**: Up to 100% on re-transcription
- **Faster Workflow**: No waiting for API calls

#### How It Works
```
1. Video has transcription? (e.g., YouTube captions)
   ↓ YES
2. Has timecoded segments?
   ↓ YES
3. Extract text from segments in your range
   ↓ INSTANT!
4. Fill in transcription field
   ✅ DONE in < 1 second!

   ↓ NO (at any step)
5. Call OpenAI Whisper API
   ✅ DONE in 10-30 seconds
```

---

## Complete Workflow Example

### Scenario: YouTube Video with AI Voice Replacement

1. **Load Video from Space**
   - Open a YouTube video that's in your Space
   - Video Editor loads with existing scenes

2. **Create Story Beat**
   - Mark IN at 00:05
   - Mark OUT at 00:15
   - Modal opens automatically

3. **Get Transcription (INSTANT!)**
   - Click "🎤 Auto-Transcribe"
   - Status: "📚 Fetching transcription from Space..."
   - Status: "✅ Extracted from 3 segments"
   - **Time: < 1 second** ⚡
   - **Cost: $0.00** 💰

4. **Replace with AI Voice**
   - Button appears: "🎙️ Replace Audio with ElevenLabs"
   - Click it
   - Confirm the action
   - Status: "Generating audio with ElevenLabs..."
   - Status: "Processing video..."
   - **Time: ~30 seconds**

5. **Result**
   - New video file created
   - Audio in range (00:05-00:15) is AI-generated voice
   - Rest of video unchanged
   - Load and preview!

**Total Time: ~31 seconds**
**Total Cost: ~$0.02 (ElevenLabs only)**

---

## Button Location

The **🎙️ Replace Audio with ElevenLabs** button is in the **Range Marker Modal**:

```
Add/Edit Marker Modal
  ├─ Type: [Spot] [Range ✓]
  ├─ Name: _____________
  ├─ IN/OUT times
  ├─ 📝 Extended Metadata (click to expand)
  │   ├─ Description
  │   ├─ Transcription
  │   │   ├─ [Textarea]
  │   │   ├─ [🎤 Auto-Transcribe] button
  │   │   └─ ╔══════════════════════╗
  │   │       ║ 🎙️ Replace Audio    ║  ← HERE!
  │   │       ║    with ElevenLabs  ║
  │   │       ╚══════════════════════╝
  │   ├─ Tags
  │   └─ Notes
  └─ [Cancel] [Save]
```

**The button dynamically appears when:**
- ✅ Range type is selected (not Spot)
- ✅ Transcription field has text

---

## Files Changed

### Frontend
- `video-editor.html`
  - Added ElevenLabs button to modal
  - Updated transcribeMarkerRange() to check existing transcriptions
  - Added replaceAudioWithElevenLabsFromModal() function
  - Added updateElevenLabsButton() visibility logic

### Backend
- `video-editor.js`
  - Added replaceAudioWithElevenLabs() implementation
  - Added generateElevenLabsAudio() - API integration
  - Added replaceAudioSegment() - FFmpeg audio replacement
  - Added buildReplacedAudioTrack() - audio concatenation
  - Added IPC handler: 'video-editor:replace-audio-elevenlabs'

- `preload-video-editor.js`
  - Exposed replaceAudioWithElevenLabs to renderer

### Documentation
- `ELEVENLABS_AUDIO_REPLACEMENT.md` - Complete feature guide
- `ELEVENLABS_BUTTON_LOCATION.md` - Where to find the button
- `SETUP_ELEVENLABS.md` - Quick setup guide
- `SMART_TRANSCRIPTION.md` - Smart transcription documentation
- `TEST_ELEVENLABS_BUTTON.md` - Testing instructions
- `IMPLEMENTATION_SUMMARY.md` - Technical details
- `WHATS_NEW.md` - This file!

---

## Setup Instructions

### 1. Set API Key
```bash
# Terminal
export ELEVENLABS_API_KEY="your-key-here"

# Or add to ~/.zshrc for persistence
echo 'export ELEVENLABS_API_KEY="your-key-here"' >> ~/.zshrc
source ~/.zshrc
```

### 2. Rebuild App
```bash
cd /Users/richardwilson/Onereach_app
npm run package:mac
```

### 3. Launch
```bash
open dist/mac-arm64/Onereach.ai.app
```

### 4. Test!
1. Load a YouTube video from Spaces
2. Create a range marker (Mark In → Mark Out)
3. Click "🎤 Auto-Transcribe" → Instant!
4. Click "🎙️ Replace Audio with ElevenLabs"
5. Enjoy AI-powered voice! 🎉

---

## Troubleshooting

### Button Doesn't Appear
1. Is it a **Range** marker? (not Spot)
2. Does the **Transcription** field have text?
3. Did you **expand** the "📝 Extended Metadata" section?

### "API key not found" Error
```bash
# Check if set
echo $ELEVENLABS_API_KEY

# If empty, set it
export ELEVENLABS_API_KEY="your-key-here"

# Restart app
```

### Transcription Not Instant
- Video might not have existing transcription
- Check console: Should see "Fetching transcription from Space..."
- Fallback to OpenAI is normal for videos without transcriptions

---

## What's Next?

Future enhancements:
- [ ] Voice selector UI (choose from 9 voices)
- [ ] Preview AI audio before applying
- [ ] Batch processing multiple ranges
- [ ] Custom voice cloning support
- [ ] Undo/revert functionality
- [ ] Save voice preferences per project

---

**Enjoy your new AI-powered video editing features!** 🚀🎬🎙️

For detailed documentation, see:
- [ELEVENLABS_AUDIO_REPLACEMENT.md](./ELEVENLABS_AUDIO_REPLACEMENT.md)
- [SMART_TRANSCRIPTION.md](./SMART_TRANSCRIPTION.md)


