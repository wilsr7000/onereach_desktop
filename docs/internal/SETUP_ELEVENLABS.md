# Quick Setup: ElevenLabs Audio Replacement

## Step 1: Get Your API Key

1. Go to [ElevenLabs.io](https://elevenlabs.io)
2. Sign up or log in
3. Click on your profile (top right)
4. Go to "Profile Settings"
5. Copy your API Key

## Step 2: Set Environment Variable

### Option A: Terminal (Temporary)
```bash
export ELEVENLABS_API_KEY="your-api-key-here"
cd /Users/richardwilson/Onereach_app
npm start
```

### Option B: Permanent Setup

**macOS/Linux:**
```bash
# Add to your shell profile
echo 'export ELEVENLABS_API_KEY="your-api-key-here"' >> ~/.zshrc

# Reload shell
source ~/.zshrc

# Start app
cd /Users/richardwilson/Onereach_app
npm start
```

**Windows:**
```bash
# PowerShell
$env:ELEVENLABS_API_KEY="your-api-key-here"

# Start app
cd C:\path\to\Onereach_app
npm start
```

### Option C: Using .env file

1. Copy the example file:
   ```bash
   cp .env.example .env
   ```

2. Edit `.env` and add your key:
   ```
   ELEVENLABS_API_KEY=your-api-key-here
   ```

3. Restart the app

## Step 3: Test It

1. Open Video Editor
2. Load a video
3. Create a range marker
4. Transcribe it (🎤 button)
5. Click "🎙️ Replace Audio with ElevenLabs"
6. Should work! ✅

## Troubleshooting

**"API key not found" error:**
- Make sure you exported the variable
- Restart the terminal/app after setting
- Check the variable: `echo $ELEVENLABS_API_KEY`

**"API error 401":**
- Your API key is invalid
- Check for typos
- Generate a new key from ElevenLabs

**"API error 429":**
- You've exceeded your rate limit
- Wait a few minutes or upgrade your plan

## Checking Your Setup

Run this in terminal:
```bash
echo $ELEVENLABS_API_KEY
```

Should show your API key (not empty).

## Free Tier Limits

ElevenLabs free tier includes:
- 10,000 characters per month
- All voices available
- High quality audio

For more, check [ElevenLabs Pricing](https://elevenlabs.io/pricing).

## Need Help?

Check the full documentation: [ELEVENLABS_AUDIO_REPLACEMENT.md](./ELEVENLABS_AUDIO_REPLACEMENT.md)


