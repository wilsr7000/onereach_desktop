# Smart Transcription Feature

## Overview

The Auto-Transcribe button in the Video Editor now **intelligently checks for existing transcriptions** before calling OpenAI. If the video was loaded from a Space and already has a transcription with timecodes, it will extract just the relevant portion for your range marker.

## How It Works

### Flow Diagram

```
Click "🎤 Auto-Transcribe"
         ↓
    Video from Space?
         ↓
    YES: Check metadata
         ↓
    Has transcription?
         ↓
    YES: Has timecoded segments?
         ↓
    YES: Extract text from segments in range
         ↓
         ✅ DONE! (No API call needed)
         
    NO (at any step):
         ↓
    Call OpenAI Whisper API
         ↓
    Transcribe audio segment
         ↓
         ✅ DONE!
```

## Benefits

### 1. **Faster** ⚡
- Instant extraction from existing data
- No need to wait for API calls
- No audio extraction/processing

### 2. **Free** 💰
- Doesn't use OpenAI API credits
- No cost for re-transcribing already-transcribed videos

### 3. **Accurate** 🎯
- Uses the original full transcription
- Preserves timecode accuracy
- Matches the exact time range

### 4. **Seamless** ✨
- Automatic fallback to OpenAI if needed
- User doesn't need to know the difference
- Works with any video from Spaces

## User Experience

### Video WITH Existing Transcription (YouTube videos, previously transcribed)

```
1. Click "Mark In" at 00:05
2. Click "Mark Out" at 00:15
3. Modal opens
4. Click "🎤 Auto-Transcribe"
   └─> Status: "📚 Fetching transcription from Space..."
   └─> Status: "✅ Extracted from 3 segments (00:05 → 00:15)"
5. Transcription appears INSTANTLY
6. Button: "🎙️ Replace Audio with ElevenLabs" appears
```

**Time: < 1 second** ⚡

### Video WITHOUT Existing Transcription

```
1. Click "Mark In" at 00:05
2. Click "Mark Out" at 00:15
3. Modal opens
4. Click "🎤 Auto-Transcribe"
   └─> Status: "Checking for existing transcription..."
   └─> Status: "🎤 Transcribing audio (00:05 → 00:15)..."
5. Wait 10-30 seconds
   └─> Status: "✅ Transcribed 00:00:10 of audio"
6. Transcription appears
7. Button: "🎙️ Replace Audio with ElevenLabs" appears
```

**Time: 10-30 seconds** (depending on audio length)

## Technical Details

### Transcription Sources

**Supported formats:**

1. **Timecoded Segments** (Best)
   - Format: `{ start: 5.2, end: 7.8, text: "Hello world" }`
   - Source: YouTube captions, Whisper API with timestamps
   - Accuracy: Exact match to timecode range

2. **Plain Text** (Fallback)
   - Format: Full text string
   - Source: Basic transcriptions
   - Accuracy: Estimated portion based on video duration

3. **No Transcription** (OpenAI fallback)
   - Calls OpenAI Whisper API
   - Creates new transcription for range

### Segment Filtering Logic

```javascript
// Filter segments that overlap with marker range
relevantSegments = segments.filter(seg => {
  const segStart = seg.start;
  const segEnd = seg.end || (seg.start + seg.duration);
  // Overlaps if: starts before range ends AND ends after range starts
  return segStart < endTime && segEnd > startTime;
});
```

### Example

**Marker Range:** 00:05 - 00:15 (10 seconds)

**Available Segments:**
```
[00:03 - 00:07] "This is the introduction"   ← Overlaps!
[00:08 - 00:12] "We will cover three topics" ← Overlaps!
[00:13 - 00:17] "First, let's start with"    ← Overlaps!
[00:18 - 00:22] "The main concept is"        ← No overlap
```

**Extracted Text:**
```
"This is the introduction We will cover three topics First, let's start with"
```

## Metadata Structure

### Transcription in Space Metadata

```json
{
  "transcript": {
    "segments": [
      {
        "start": 5.2,
        "end": 7.8,
        "text": "Hello world",
        "startFormatted": "00:00:05.200"
      },
      {
        "start": 8.1,
        "end": 10.5,
        "text": "This is a test",
        "startFormatted": "00:00:08.100"
      }
    ],
    "text": "Full transcription text...",
    "language": "en"
  }
}
```

## Console Output

### With Existing Transcription
```
[Transcription] Checking Space for existing transcription: abc123
[Transcription] Found existing transcription: 5432 chars
[Transcription] Found 127 timecoded segments
[Transcription] Extracted from 3 segments
```

### Without Transcription
```
[Transcription] Checking Space for existing transcription: abc123
[Transcription] No existing transcription found in Space, falling back to OpenAI
[Transcription] Calling OpenAI Whisper...
```

## When Videos Have Transcriptions

### YouTube Videos
✅ Always have transcriptions (captions)
✅ Include timecoded segments
✅ Auto-extract works perfectly

### Uploaded Videos
- ✅ If previously transcribed in Space
- ✅ If downloaded from YouTube
- ❌ Fresh uploads without transcription → Falls back to OpenAI

### Screen Recordings
❌ Typically no existing transcription
❌ Falls back to OpenAI

## Cost Savings Example

### Before (Always OpenAI)
```
10 range markers × $0.006 per minute = ~$0.60
(assuming 10 minutes total of transcribed segments)
```

### After (Smart Transcription)
```
Videos with existing transcription: $0.00
Videos without: Falls back to OpenAI
```

**Savings: Up to 100% on re-transcription costs!** 💰

## User Benefits

1. **YouTube Videos**: Instant transcription extraction
2. **Previously Transcribed**: Reuse existing data
3. **Story Beats**: Quick transcription for each beat
4. **ElevenLabs**: Fast workflow to AI voice replacement
5. **No Wasted Credits**: Only transcribe once

## Future Enhancements

Planned improvements:
- [ ] Cache transcriptions for local videos
- [ ] Show indicator when using cached transcription
- [ ] Option to force re-transcribe
- [ ] Better handling of overlapping segments
- [ ] Support for multiple languages
- [ ] Transcription confidence scores

## Troubleshooting

### "No transcription found" but video has captions
- Video might not be from YouTube
- Transcription wasn't saved to Space metadata
- Try: Click "Transcribe" on the video in Spaces first

### Extracted text seems wrong
- Check console for segment count
- Timecodes might be misaligned
- Fallback: Edit manually in the field

### Still using OpenAI credits
- Verify video was loaded from Space (check spaceItemId in console)
- Confirm transcription exists (check metadata.json file)
- Segments might not have proper start/end times

---

**This feature makes the Video Editor workflow much faster and more cost-effective!** 🚀


