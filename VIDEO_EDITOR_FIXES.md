# Video Editor Fixes & Features

## New Feature: ElevenLabs Audio Replacement ✨

Added ability to replace audio in video segments (story beats) with AI-generated speech from ElevenLabs!

**What it does:**
- Takes transcription from a video range/story beat
- Generates AI speech using ElevenLabs API
- Replaces the original audio in that specific time range
- Perfect for dubbing, re-voicing, or improving audio quality

**How to use:**
1. Create a range marker in your video
2. Transcribe the range (🎤 button)
3. Click "🎙️ Replace Audio with ElevenLabs" button
4. Wait for processing
5. Load the new video with replaced audio!

**Setup required:**
```bash
export ELEVENLABS_API_KEY="your-api-key-here"
```

See [ELEVENLABS_AUDIO_REPLACEMENT.md](./ELEVENLABS_AUDIO_REPLACEMENT.md) for full documentation.

---

## Issues Fixed

### 1. Content Security Policy (CSP) Error
**Error**: Google Fonts stylesheet was being blocked by CSP

**Fix**: Updated CSP in `video-editor.html` to allow Google Fonts:
```html
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; media-src 'self' file: blob:; img-src 'self' file: blob: data:;">
```

### 2. Missing Function Error
**Error**: `TypeError: this.updateMarkersPanel is not a function`

**Fix**: Added the missing `updateMarkersPanel()` function in `video-editor.html` (line ~4376):
```javascript
// Update markers panel (called after loading scenes from space)
updateMarkersPanel() {
  // This is handled by renderMarkers() which updates the markers panel
  // This function exists for compatibility with loadScenesFromSpace
},
```

### 3. FFmpeg Spawn Error
**Error**: `Error: spawn ENOTDIR`

**Fix**: Added comprehensive error handling and validation in `video-editor.js`:
- Validates that video file path is provided
- Checks if video file exists before processing
- Verifies it's a file (not a directory)
- Added detailed logging for debugging
- Better error messages with context

**Changes in `getVideoInfo()` function**:
```javascript
// Validate input path
if (!inputPath) {
  reject(new Error('No video path provided'));
  return;
}

// Check if file exists
if (!fs.existsSync(inputPath)) {
  reject(new Error(`Video file does not exist: ${inputPath}`));
  return;
}

// Check if it's a file (not a directory)
const stats = fs.statSync(inputPath);
if (!stats.isFile()) {
  reject(new Error(`Path is not a file: ${inputPath}`));
  return;
}
```

**Added logging in module initialization**:
- FFmpeg path and existence check
- FFprobe path and existence check
- Output directories

## Testing

To test the fixes:

1. **Restart the application**:
   ```bash
   pkill -9 -f "Electron" 2>/dev/null
   sleep 2
   cd /Users/richardwilson/Onereach_app && npm start
   ```

2. **Open a video in the editor**:
   - Open Clipboard Viewer
   - Select a video item
   - Click "Open in Video Editor"

3. **Check the console**:
   - The CSP error should be gone
   - You should see detailed logging about FFmpeg paths
   - Any errors should now have clear, helpful messages

## Expected Behavior

After these fixes:
- ✅ Google Fonts load correctly (no CSP errors)
- ✅ Videos load from Spaces without function errors
- ✅ Better error messages if video loading fails
- ✅ Detailed logging for troubleshooting

## If Issues Persist

If you still see the `spawn ENOTDIR` error, check:

1. **File permissions**: Ensure the video file is readable
2. **File path**: Check for special characters or encoding issues
3. **FFmpeg installation**: Verify FFmpeg binaries are executable
4. **Console logs**: Look for detailed error messages in the logs

Run the debug script to diagnose:
```bash
node debug-video-editor.js "/path/to/your/video.mov"
```


