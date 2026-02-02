# External AI Services Test System

This test system ensures that all external AI services (chat bots, image creators, video creators, and audio generators) configured in the setup wizard work properly and users can log in.

## Test Suites

### 1. Automated Test Suite (`external-ai-test-suite.js`)

Runs automated tests on all external AI services to check:
- URL loads successfully
- HTTPS security
- Login elements are present
- API documentation is accessible

**Run with:**
```bash
npm run test:external-ai
```

### 2. Interactive Test Runner (`external-ai-interactive-test.js`)

Provides a visual UI for manually testing each service:
- Test individual services or all at once
- Open services in separate windows for manual login testing
- Visual status indicators for each test
- Save test results to JSON file

**Run with:**
```bash
npm run test:external-ai-interactive
```

## Services Tested

### 🤖 Chat Bots
- **ChatGPT** - OpenAI's conversational AI
- **Claude** - Anthropic's AI assistant
- **Perplexity** - Search-focused AI
- **Google Gemini** - Google's multimodal AI
- **Grok** - xAI's advanced AI with real-time knowledge

### 🎨 Image Creators
- **Midjourney** - Artistic image generation
- **Stable Diffusion** - Open-source image AI
- **Ideogram** - Text-in-image specialist
- **DALL-E 3** - OpenAI's image generator
- **Adobe Firefly** - Commercial-safe AI images

### 🎬 Video Creators
- **Google Veo3** - Advanced video generation
- **Runway** - Professional video tools
- **Pika** - User-friendly video AI
- **Synthesia** - AI avatar videos
- **HeyGen** - AI spokesperson videos

### 🎵 Audio Generators
- **Music**: Suno AI, Udio, MusicGen, Mubert
- **Sound Effects**: ElevenLabs SFX, AudioGen
- **Voice/Narration**: ElevenLabs, Play.ht, Murf AI, Speechify

## Test Criteria

Each service is tested for:

1. **URL Loads** - Service website is accessible
2. **HTTPS Secure** - Uses secure connection
3. **Login Available** - Login/sign-in elements present
4. **Page Responsive** - Page loads with content

## Using the Interactive Test Runner

1. Launch the test runner:
   ```bash
   npm run test:external-ai-interactive
   ```

2. The UI shows all services organized by category

3. For each service you can:
   - **Test** - Run automated checks
   - **Open** - Open in new window for manual testing

4. Test indicators:
   - 🟢 Green = Test passed
   - 🔴 Red = Test failed
   - 🟡 Yellow = Optional/Warning
   - ⚪ Gray = Not tested yet

5. Click "Test All Services" to run all tests automatically

6. Click "Save Results" to export test results to JSON

## Manual Login Testing

When you click "Open" on a service:
1. A new window opens with the service
2. Try to log in using appropriate credentials
3. Verify you can access the main interface
4. Check that core features are accessible

## Test Results

Test results are saved as JSON files with:
- Timestamp of test
- Service details (name, URL, category)
- Test results for each criterion
- Any errors encountered

Example result:
```json
{
  "timestamp": "2024-06-14T10:30:00Z",
  "duration": "45.2",
  "summary": {
    "chatBots": { "total": 4, "passed": 4 },
    "imageCreators": { "total": 5, "passed": 5 }
  },
  "details": [
    {
      "category": "chatBots",
      "service": "ChatGPT",
      "url": "https://chat.openai.com/",
      "tests": {
        "urlLoads": true,
        "httpsSecure": true,
        "loginVisible": true,
        "pageResponsive": true
      }
    }
  ]
}
```

## Troubleshooting

### Service won't load
- Check internet connection
- Verify URL is correct
- Some services may have regional restrictions

### Login elements not found
- Service may have updated their UI
- Login might be on a different page
- Some services use OAuth (Google, Discord)

### Test failures
- Run individual test to see specific error
- Check browser console for errors
- Try opening service manually

## Adding New Services

To add a new service to test:

1. Edit `external-ai-test-suite.js`
2. Add service configuration to appropriate category
3. Include:
   - Name
   - URL
   - Login selectors (if known)
   - Expected elements after login

Example:
```javascript
newService: {
  name: 'New AI Service',
  url: 'https://newservice.ai/',
  loginSelectors: {
    loginButton: 'button:contains("Sign in")',
    emailInput: 'input[type="email"]'
  },
  expectedElements: [
    'textarea[placeholder*="prompt"]',
    'button:contains("Generate")'
  ]
}
``` 