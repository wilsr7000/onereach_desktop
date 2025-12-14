# ElevenLabs Audio Replacement Feature

## Overview

This feature allows you to replace audio in specific video segments (story beats/ranges) with AI-generated speech from ElevenLabs. Perfect for:
- Dubbing/re-voicing video segments
- Creating multilingual versions
- Improving audio quality
- Experimenting with different voice styles

## How to Use

### 1. **Prerequisite: ElevenLabs API Key**

You need an ElevenLabs API key to use this feature.

**Get Your API Key:**
1. Sign up at [ElevenLabs.io](https://elevenlabs.io)
2. Navigate to your Profile Settings
3. Copy your API Key

**Set the API Key:**

Add to your environment:
```bash
export ELEVENLABS_API_KEY="your-api-key-here"
```

Or add to your `~/.zshrc` or `~/.bash_profile`:
```bash
echo 'export ELEVENLABS_API_KEY="your-api-key-here"' >> ~/.zshrc
source ~/.zshrc
```

### 2. **Using the Feature in Video Editor**

1. **Open a video** in the Video Editor
2. **Create a range marker** (story beat):
   - Click "Mark In" at the start point
   - Click "Mark Out" at the end point
   - Name your range marker
3. **Transcribe the range**:
   - Click the range marker in the timeline
   - In the details panel, click **"🎤 Transcribe"**
   - Wait for transcription to complete
4. **Replace audio with ElevenLabs**:
   - Click the range marker again
   - You'll now see a button: **"🎙️ Replace Audio with ElevenLabs"**
   - Click it
   - Confirm the operation
   - Wait for processing (may take 30-60 seconds depending on length)
5. **Load the new video**:
   - After completion, you'll be asked if you want to load the new video
   - Click "OK" to preview the result

## Available Voices

The feature includes 9 pre-configured voices:

| Voice Name | Voice ID | Description |
|------------|----------|-------------|
| **Rachel** (default) | 21m00Tcm4TlvDq8ikWAM | Calm, clear female voice |
| **Domi** | AZnzlk1XvdvUeBnXmlld | Strong female voice |
| **Bella** | EXAVITQu4vr4xnSDxMaL | Soft female voice |
| **Antoni** | ErXwobaYiN019PkySvjV | Well-rounded male voice |
| **Elli** | MF3mGyEYCl7XYWbV9V6O | Emotional female voice |
| **Josh** | TxGEqnHWrfWFTfGW9XjX | Deep male voice |
| **Arnold** | VR6AewLTigWG4xSOukaG | Crisp male voice |
| **Adam** | pNInz6obpgDQGcFmaJgB | Deep male voice |
| **Sam** | yoZ06aMxZJJ28mfd3POQ | Young male voice |

*Default voice: Rachel*

To use a different voice, you'll need to modify the code (future enhancement: voice selector UI).

## How It Works

### Behind the Scenes

1. **Text-to-Speech Generation**:
   - Sends the transcription text to ElevenLabs API
   - Receives MP3 audio file with AI-generated speech

2. **Audio Replacement Process**:
   - Extracts video track (without audio)
   - Splits original audio into 3 parts:
     - Audio before the range (if any)
     - [NEW ElevenLabs audio for the range]
     - Audio after the range (if any)
   - Concatenates all audio segments
   - Merges with video track
   - Outputs final video with replaced audio

3. **Files Created**:
   - Output saved to: `~/Library/Application Support/onereach-ai/video-exports/`
   - Filename format: `[original]_elevenlabs_[timestamp].mp4`

## Technical Details

### API Call
```javascript
POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}
Headers:
  - xi-api-key: YOUR_API_KEY
  - Content-Type: application/json
Body:
  {
    "text": "transcription text",
    "model_id": "eleven_monolingual_v1",
    "voice_settings": {
      "stability": 0.5,
      "similarity_boost": 0.75
    }
  }
```

### FFmpeg Process
```bash
# 1. Extract video only
ffmpeg -i input.mp4 -an video_only.mp4

# 2. Extract audio segments
ffmpeg -i input.mp4 -ss 0 -t [startTime] audio_before.mp3
# [ElevenLabs audio in the middle]
ffmpeg -i input.mp4 -ss [endTime] audio_after.mp3

# 3. Concatenate audio
ffmpeg -f concat -i concat.txt audio_final.mp3

# 4. Merge video and audio
ffmpeg -i video_only.mp4 -i audio_final.mp3 -c:v copy -c:a aac output.mp4
```

## Limitations & Notes

- **Transcription required**: The range must have a transcription before audio can be replaced
- **Range markers only**: Feature only works with range markers (not spot markers)
- **Processing time**: Depends on segment length and API response time
- **Audio timing**: Generated audio is time-stretched to match the original segment duration
- **API costs**: ElevenLabs charges per character (check their pricing)
- **Quality**: ElevenLabs provides high-quality AI voices but may not perfectly match human speech patterns

## Troubleshooting

### "ElevenLabs API key not found"
- Ensure `ELEVENLABS_API_KEY` environment variable is set
- Restart the application after setting the variable

### "No transcription found"
- Click "🎤 Transcribe" first to generate transcription
- Wait for transcription to complete before trying audio replacement

### "Failed to replace audio"
- Check console logs for detailed error messages
- Verify your ElevenLabs API key is valid
- Ensure you have enough API credits
- Check your internet connection

### Processing takes too long
- Large segments may take 30-60 seconds
- Check the progress indicator in the UI
- ElevenLabs API response time varies

## Future Enhancements

Planned improvements:
- [ ] Voice selector UI (choose from available voices)
- [ ] Preview generated audio before applying
- [ ] Batch processing (replace audio in multiple ranges)
- [ ] Custom voice cloning support
- [ ] Settings panel for ElevenLabs preferences
- [ ] Cost estimation before processing
- [ ] Undo/revert to original audio
- [ ] Save voice preferences per project

## Support

For issues or feature requests:
1. Check the console logs for error details
2. Verify your ElevenLabs API setup
3. Ensure FFmpeg is working correctly
4. Contact support with error logs

## Credits

- **ElevenLabs**: AI voice generation ([elevenlabs.io](https://elevenlabs.io))
- **FFmpeg**: Video/audio processing
- **Onereach.ai**: Video editor integration


