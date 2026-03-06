# Where to Find the ElevenLabs Button

## Visual Guide

The button is now in the **Range Marker Modal** (popup dialog)!

```
┌──────────────────────────────────────────────────────┐
│ Video Editor                                          │
├──────────────────────────────────────────────────────┤
│                                                        │
│  [Video Player]            ┌──────────────────────┐  │
│                            │ ADD/EDIT MARKER      │  │
│  ═══════════════════════  │ MODAL                │  │
│  Timeline with markers     ├──────────────────────┤  │
│  ─────▓▓▓▓▓▓▓─────────    │                      │  │
│       ↑ Mark In/Out        │ Type: [Spot][Range✓]│  │
│                            │                      │  │
│                            │ Name: Scene 1        │  │
│                            │                      │  │
│                            │ IN: 00:05            │  │
│                            │ OUT: 00:15           │  │
│                            │ Duration: 10s        │  │
│                            │                      │  │
│                            │ 📝 Extended Metadata │  │
│                            │                      │  │
│                            │ Transcription:       │  │
│                            │ ┌──────────────────┐ │  │
│                            │ │ "Hello world..."││ │  │
│                            │ └──────────────────┘ │  │
│                            │ [🎤 Auto-Transcribe] │  │
│                            │                      │  │
│                            │ ╔══════════════════╗ │  │
│                            │ ║ 🎙️ Replace Audio║ │  │
│                            │ ║ with ElevenLabs  ║ │  │
│                            │ ╚══════════════════╝ │  │
│                            │      ↑ HERE!         │  │
│                            │                      │  │
│                            │ Tags: [____________] │  │
│                            │ Notes: [___________] │  │
│                            │                      │  │
│                            │ [Cancel] [Save]      │  │
│                            └──────────────────────┘  │
└──────────────────────────────────────────────────────┘
```

## Step-by-Step Instructions

### Step 1: Create a Range Marker
1. Play the video to where you want to start
2. Click **"Mark In"** button (or press `I`)
3. Play to where you want to end
4. Click **"Mark Out"** button (or press `O`)
5. A modal dialog pops up!

**Result:** The Add/Edit Marker modal is now open

### Step 2: Fill in the Marker Info
1. In the modal, select **"Range"** type (should be pre-selected)
2. Give your marker a name (e.g., "Scene 1")
3. Verify the IN and OUT times look correct

### Step 3: Expand Extended Metadata
1. Click on **"📝 Extended Metadata"** to expand the section
2. You'll see fields for:
   - Description
   - Transcription/Dialogue
   - Tags
   - Notes
   - Screen Grabs

### Step 4: Add Transcription
**Option A: Auto-Transcribe**
1. Click the **"🎤 Auto-Transcribe"** button next to the Transcription field
2. Wait 10-30 seconds for transcription to complete
3. Transcription automatically fills the textarea

**Option B: Manual Entry**
1. Type or paste your transcription into the **Transcription/Dialogue** field

**Result:** As soon as you add transcription, the ElevenLabs button appears!

### Step 5: Replace Audio Button Appears!
1. The button appears **immediately below the transcription field**
2. You'll see a blue highlighted section with:
   **"🎙️ Replace Audio with ElevenLabs"**
3. Plus a helper text explaining what it does

**Why it appears now:**
- ✅ You selected "Range" type
- ✅ You added transcription
- Button dynamically shows/hides as you type!

## Troubleshooting

### "I don't see the button!"

**Check #1: Is it a Range Marker?**
- Spot markers (📍) don't get the button
- Only Range markers (colored bars) work
- Solution: Create a range instead of a spot

**Check #2: Did you add transcription?**
- The button ONLY appears when transcription field has text
- Click "🎤 Auto-Transcribe" OR type it manually
- Button appears instantly as you type
- Solution: Add transcription first

**Check #3: Is the modal open?**
- You need to open the Add/Edit Marker modal
- Either create new range OR edit existing marker
- Solution: Click "Mark In" then "Mark Out", or click Edit on existing marker

**Check #4: Is there a transcription error?**
- Check console for errors
- Video must have audio to transcribe
- Solution: Ensure video has audio track

### "Button is there but greyed out"
- This shouldn't happen, but if it does:
- Check that ELEVENLABS_API_KEY is set
- Restart the app
- Try clicking a different marker

### "I clicked it but nothing happens"
- Check browser console for errors
- Verify ELEVENLABS_API_KEY environment variable
- Check internet connection
- See [SETUP_ELEVENLABS.md](./SETUP_ELEVENLABS.md)

## Quick Reference

**Button Location:**
- **Inside the Add/Edit Marker Modal** (popup dialog)
- In the "📝 Extended Metadata" section
- Right below the **Transcription/Dialogue** textarea
- In a blue highlighted box
- Full-width blue button

**Button Text:**
```
🎙️ Replace Audio with ElevenLabs
```

**Prerequisites:**
1. ✅ Select **Range** type (not spot)
2. ✅ Add transcription (type or auto-transcribe)
3. ✅ ELEVENLABS_API_KEY environment variable is set

**Dynamic Behavior:**
- Button appears/disappears as you type in transcription
- Only shows for Range markers
- Only shows when transcription textarea has text

## Visual Markers Guide

### Range Marker (✅ Works)
```
Timeline:  ───────▓▓▓▓▓▓▓───────
                  └─ Has start/end points
                     Shows as colored bar
                     Button appears here!
```

### Spot Marker (❌ Won't work)
```
Timeline:  ──────────📍──────────
                     └─ Single point only
                        No button for this type
```

## Still Can't Find It?

1. **Make sure the modal is open:**
   - Click Mark In + Mark Out to create range
   - OR click Edit (✏️) on existing marker
   - Modal dialog should pop up

2. **Expand Extended Metadata:**
   - Look for "📝 Extended Metadata" section
   - Click to expand if collapsed
   - Transcription field should be visible

3. **Add transcription:**
   - Type anything in the Transcription field
   - Button appears INSTANTLY as you type
   - No need to save first!

4. **Check marker type:**
   - At top of modal: [Spot] [Range]
   - **Range** must be selected
   - Switch to Range if needed

5. **Try a fresh marker:**
   - Click Mark In at 5 seconds
   - Click Mark Out at 15 seconds
   - Modal opens automatically
   - Type "test" in Transcription field
   - Button appears!

## Success! What Next?

When you click the button:
1. ✅ Confirmation dialog appears
2. ✅ Shows the transcription preview
3. ✅ Click "OK" to proceed
4. ✅ Wait 20-30 seconds
5. ✅ New video created with AI voice
6. ✅ Load the new video to preview

**That's it!** 🎉

---

**Need more help?** See:
- [ELEVENLABS_AUDIO_REPLACEMENT.md](./ELEVENLABS_AUDIO_REPLACEMENT.md) - Full documentation
- [SETUP_ELEVENLABS.md](./SETUP_ELEVENLABS.md) - API setup guide


