# Test: ElevenLabs Button in Modal

## Quick Test Steps

### 1. Rebuild and Launch App
```bash
cd /Users/richardwilson/Onereach_app
npm run package:mac
open dist/mac-arm64/Onereach.ai.app
```

### 2. Open Video Editor
- Load a video file
- Wait for it to load completely

### 3. Create a Range Marker
- Click **"Mark In"** button (at 5 seconds)
- Click **"Mark Out"** button (at 15 seconds)
- **Modal should pop up automatically**

### 4. Look for the Button
The button should be **HIDDEN** at first because there's no transcription yet.

### 5. Make the Button Appear
**Option A: Type Manually**
1. Look for the **"Transcription / Dialogue"** field
2. Type anything: `"Hello world"`
3. **Button should appear INSTANTLY** below the field

**Option B: Auto-Transcribe**
1. Click the **"🎤 Auto-Transcribe"** button
2. Wait for transcription to complete
3. **Button appears** when transcription fills in

## What You Should See

### Before Transcription:
```
┌─────────────────────────────┐
│ Transcription / Dialogue    │
│ [🎤 Auto-Transcribe]        │
│ ┌─────────────────────────┐ │
│ │                         │ │  ← Empty field
│ └─────────────────────────┘ │
│                             │
│ (No button visible)         │
│                             │
│ Tags: ___________           │
```

### After Typing Transcription:
```
┌─────────────────────────────┐
│ Transcription / Dialogue    │
│ [🎤 Auto-Transcribe]        │
│ ┌─────────────────────────┐ │
│ │ "Hello world, this..."  │ │  ← Has text
│ └─────────────────────────┘ │
│                             │
│ ╔═══════════════════════╗   │
│ ║ 🎙️ Replace Audio with║   │  ← BUTTON APPEARS!
│ ║    ElevenLabs         ║   │
│ ╚═══════════════════════╝   │
│ Generate AI voice from      │
│ transcription...            │
│                             │
│ Tags: ___________           │
```

## Debug Console

Open Developer Console (Cmd+Option+I or View > Developer > Toggle Developer Tools)

Look for these messages:
```
[ElevenLabs] Button update: {
  hasSection: true,
  hasTranscription: true,
  isRange: true,
  transcriptionLength: 12,
  markerType: 'range'
}
[ElevenLabs] Showing button!
```

## Troubleshooting

### "I don't see the modal at all"
- Make sure you clicked Mark In, then Mark Out
- Or edit an existing marker

### "Modal opens but I don't see Extended Metadata section"
- Click on **"📝 Extended Metadata"** to expand it
- Scroll down in the modal

### "I typed transcription but button doesn't appear"
Check console for:
```
[ElevenLabs] Button update: {hasTranscription: false ...}
```

If `hasTranscription: false` but you typed text:
- Try clicking outside the textarea first
- Or press Tab to trigger the input event

### "Button still doesn't appear"
Check marker type:
```
[ElevenLabs] Button update: {..., markerType: 'spot'}
```

If `markerType: 'spot'`:
- Click the **"Range"** button at top of modal (not Spot)
- Range button should be highlighted/active

### "Console says 'Section element not found!'"
The HTML wasn't updated. Rebuild the app:
```bash
npm run package:mac
```

## Expected Behavior

✅ **CORRECT:**
1. Open modal → No button (no transcription yet)
2. Type "test" → Button appears instantly
3. Delete text → Button disappears
4. Type again → Button reappears
5. Switch to Spot → Button disappears
6. Switch to Range → Button reappears (if has text)

❌ **INCORRECT:**
- Button never appears even with transcription
- Button visible on Spot markers
- Button doesn't respond to typing

## Still Not Working?

### Check File Was Updated
```bash
grep "elevenLabsSection" /Users/richardwilson/Onereach_app/video-editor.html
```

Should output:
```
<div class="elevenlabs-section hidden" id="elevenLabsSection"...
```

### Verify Event Listener
In console, type:
```javascript
app.updateElevenLabsButton()
```

Should see the debug log output.

### Force Rebuild
```bash
cd /Users/richardwilson/Onereach_app
rm -rf dist
npm run package:mac
open dist/mac-arm64/Onereach.ai.app
```

---

**If still not working, share the console output and I'll help debug!**


