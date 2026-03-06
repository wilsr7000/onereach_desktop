# Video Editor Production System - Quick Start Guide

## 🎯 What's Been Built

A complete video production system with:
- **Standalone Recorder** - Controlled recording with instructions
- **Video Editor** - Translation, multi-track audio, AI video replacement, story beats
- **Agentic Player** - Dynamic API-driven seamless playback

---

## 🚀 Quick Start

### Step 1: Configure API Keys

Create or edit `settings.json` in your app's userData directory:

**macOS/Linux:**
```bash
~/Library/Application Support/Onereach/settings.json
```

**Windows:**
```bash
%APPDATA%\Onereach\settings.json
```

**Contents:**
```json
{
  "openaiApiKey": "sk-proj-...",
  "anthropicApiKey": "sk-ant-...",
  "elevenlabsApiKey": "..."
}
```

### Step 2: Launch the Application

```bash
npm start
```

### Step 3: Test the Recorder

1. Open Video Editor from main app
2. Click the **🎙️ Recorder** icon in header
3. Select camera/screen
4. Click the red record button
5. Record a test video (10-30 seconds)
6. Click stop, review the recording
7. Click "Save to Space"
8. Select a space and save

### Step 4: Test Translation Workflow

1. In video editor, the recorded video should load
2. Use trim markers to select a 5-10 second region
3. Click **🌐 Translate** button in action bar
4. Translation panel slides in
5. Select source/target languages
6. Click **🌐 Translate**
7. Watch the TEaR pipeline:
   - Translation appears
   - Quality scores show (5 dimensions)
   - If score < 9.0, improvements suggested
   - Iterates until 9.0+ or max iterations
8. Click **🎙️ Generate Audio**
9. Preview the generated voice
10. Click **✓ Apply to Timeline**
11. See green checkmark on timeline

### Step 5: Test Multi-Track Audio

1. Click **+ Add Track** at bottom of timeline
2. Select "Music" or "SFX"
3. Click **🎵 Sweetening** button
4. Click a sound effect (e.g., "💨 Whoosh")
5. See it added to the SFX track
6. Try drag-and-drop an MP3 file
7. Test mute/solo buttons

### Step 6: Test Story Beats

1. Click **Story Beats** in header navigation
2. Layout switches to beats mode
3. Click **+ Add Beat** button
4. Fill in:
   - Name: "Introduction"
   - Description: "Host introduces the topic"
5. Click **🎤 Auto-Transcribe** (uses Whisper)
6. Add tags: "intro", "hook"
7. Click **Save Beat**
8. Add 2-3 more beats
9. Switch to **Graph** tab - see visualization
10. Switch to **Deploy** tab

### Step 7: Test in Agentic Player

1. In Deploy tab, click **▶ Test in Agentic Player**
2. New window opens with your video + beats
3. Click beats in right sidebar to jump
4. Test navigation

### Step 8: Test Dynamic Playlist Player

1. Open `agentic-player/test-player.html` in browser
2. Configure:
   - Batch size: 3
   - Total clips: 10
   - API delay: 500ms
3. Click **Start Test**
4. In player iframe, enter prompt: "test playback"
5. Click **Start Session**
6. Observe:
   - Clips play seamlessly
   - No black frames between clips
   - API log shows requests
   - Queue management works
7. Try enabling **Simulate Errors** - player should retry

---

## 🎬 Workflows

### Workflow 1: Translation

```
1. Record/Import Video
2. Switch to Edit Layout
3. Select region (trim markers)
4. Click "Translate" 
5. TEaR pipeline runs:
   - Transcribe (Whisper)
   - Translate (GPT-4)
   - Evaluate (Claude)
   - Refine if needed
   - Generate audio (ElevenLabs)
6. Apply to voice track
7. Repeat for next segment
8. Export final video
```

### Workflow 2: Story Beats

```
1. Export final video from Edit Layout
2. Switch to Story Beats Layout
3. Mark important sections as beats
4. Add descriptions and transcriptions
5. Create links between beats
6. Test in player
7. Generate embed code
8. Export player package
```

### Workflow 3: Audio Sweetening

```
1. Load video
2. Add Music track
3. Add SFX track
4. Open Sweetening panel
5. Import background music
6. Add sound effects at key moments
7. Adjust volumes with mute/solo
8. Export with full audio mix
```

---

## 🔍 Troubleshooting

### Recorder Issues

**Camera not showing:**
- Check permissions in System Preferences > Security & Privacy > Camera
- Click "Grant Camera Access" in the overlay

**Recording not saving:**
- Ensure a Space is selected in save dialog
- Check app has write permissions to userData folder

### Editor Issues

**Translation not working:**
- Verify OpenAI API key in settings.json
- Check internet connection
- Look at console for API errors

**Audio tracks not showing:**
- Make sure video is loaded first
- Click "+ Add Track" button
- Refresh if tracks are hidden

**Panels not opening:**
- Select a region on timeline first (trim markers)
- Click action bar buttons

### Player Issues

**No clips playing:**
- Check API endpoint configuration
- Verify API returns correct JSON format
- Use test-player.html to test with mock API

**Stuttering on transitions:**
- Check network speed
- Reduce API delay
- Increase prefetchThreshold in config

**Retries not working:**
- Enable error simulation in test harness
- Check console for retry logs
- Verify API returns HTTP error codes

---

## 📊 Monitoring

### Browser Console

Watch for these key logs:

**Recorder:**
```
[Recorder] Initializing...
[Recorder] Ready
[Recorder] Recording started
[Recorder] Recording stopped
[Recorder] Saved recording to: /path/to/file.webm
```

**Video Editor:**
```
[VideoEditor] Switched to layout: edit
[Translation] Iteration 1/5
[Translation] Quality threshold met at iteration 2: 9.2
[AudioSweetening] Added whoosh to SFX track
[ProjectManager] Project saved
```

**Agentic Player:**
```
[Player] Initializing...
[Player] Session started: session-abc123
[Player] Fetching clips from API...
[Player] Queued 3 clips (total: 3)
[Player] Preloaded next clip: Test Clip 1
[Player] Using preloaded video for seamless transition
[Player] Seamless transition complete
```

---

## 🎓 Best Practices

### Translation

1. **Use short segments** (10-20 seconds each)
2. **Review transcription** before translating
3. **Edit manually** if automatic translation misses nuance
4. **Test audio** before applying to timeline
5. **Save project** after approving segments

### Multi-Track Editing

1. **Original audio on A1** - keep as reference
2. **Translations on Voice tracks** - one per language
3. **Music on Music tracks** - background scores
4. **SFX on SFX tracks** - individual sound effects
5. **Use mute/solo** to isolate tracks during editing

### Story Beats

1. **Mark after final edit** - beats reference the exported video
2. **Descriptive names** - "Introduction", not "Beat 1"
3. **Complete transcriptions** - helps with search/discovery
4. **Meaningful links** - use relationships (answers, leads_to, see_also)
5. **Test before deploy** - verify playback works

### Agentic Player API

1. **Return 2-3 clips per request** - balances API calls and buffering
2. **Include reasoning** - helps debug clip selection
3. **Filter by watchedIds** - don't repeat clips
4. **Set done=true clearly** - when no more relevant clips
5. **Handle errors gracefully** - return 500 for retry, 404 for no results

---

## 📁 File Reference

### Core Files

| File | Purpose | Lines |
|------|---------|-------|
| `recorder.html` | Recorder UI | 1,100 |
| `recorder.js` | Recorder backend | 240 |
| `preload-recorder.js` | Recorder IPC bridge | 60 |
| `video-editor.html` | Editor UI + all panels | 13,000+ |
| `video-editor.js` | Editor backend + translation | 3,400+ |
| `preload-video-editor.js` | Editor IPC bridge | 130 |
| `agentic-player/player.js` | Player logic | 650 |
| `agentic-player/index.html` | Player UI | 600 |
| `agentic-player/test-player.html` | Test harness | 280 |

### Documentation

| File | Purpose |
|------|---------|
| `VIDEO_EDITOR_IMPLEMENTATION_SUMMARY.md` | Complete technical overview |
| `VIDEO_EDITOR_QUICK_START.md` | This file - user guide |
| `agentic-player/TEST-GUIDE.md` | Player testing instructions |

---

## 🎉 What's Ready to Use

### Fully Functional

✅ Standalone recorder with Space saving
✅ Multi-track audio timeline
✅ TEaR translation pipeline (needs API keys)
✅ Audio sweetening panel
✅ AI video replacement panel (BYOV workflow)
✅ Story beats marking and graph
✅ Project auto-save system
✅ Agentic player with seamless transitions
✅ Player test harness

### Needs Integration

⚠️ ElevenLabs SFX (needs API key + implementation)
⚠️ Video track splicing (needs FFmpeg integration)
⚠️ Space storage for projects (uses localStorage now)
⚠️ Cross-video beat linking (needs Space video browser)
⚠️ Player embed hosting (needs server deployment)

---

## 💡 Tips

1. **Start simple:** Record a short video, add one translation segment
2. **Use test harness:** `test-player.html` simulates perfect API behavior
3. **Watch console:** All operations log detailed debug info
4. **Save often:** Auto-save is enabled, but manual save is instant
5. **Test iteratively:** Test each feature separately before combining

---

## 🆘 Support

For issues:
1. Check browser console first
2. Verify API keys in settings.json
3. Test with mock API (test-player.html)
4. Review logs in app userData directory
5. Check this guide's troubleshooting section

---

## 🔄 Next Steps

1. Configure your translation API keys
2. Record a test video with the recorder
3. Try translating one segment
4. Add some audio sweetening
5. Mark a few story beats
6. Test in the player
7. Set up your server API for dynamic playlists
8. Deploy to production!

---

Generated: December 2024
System: Onereach Video Production System v1.0



































