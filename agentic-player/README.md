# 🤖 Agentic Video Player

A seamless video player that fetches clips in batches from your API for continuous playback.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        YOUR API                              │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐     │
│  │   Request   │───▶│  AI/Logic   │───▶│  Response   │     │
│  │  prompt,    │    │  (Claude,   │    │  1-5 clips  │     │
│  │  history,   │    │   rules,    │    │  + done?    │     │
│  │  context    │    │   hybrid)   │    │             │     │
│  └─────────────┘    └─────────────┘    └─────────────┘     │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                        PLAYER                                │
│  1. User enters prompt → POST to API                        │
│  2. API returns batch of clips                              │
│  3. Player queues clips, plays seamlessly                   │
│  4. Pre-fetches next batch when queue gets low              │
│  5. Stops when API returns done: true                       │
└─────────────────────────────────────────────────────────────┘
```

## Quick Start

### 1. Configure the API endpoint

```html
<script>
  window.AGENTIC_PLAYER_CONFIG = {
    apiEndpoint: 'https://api.yoursite.com/playlist'
  };
</script>
<script src="player.js"></script>
```

### 2. Implement your API

Your API receives POST requests and returns clip batches:

**Request:**
```json
{
  "prompt": "Show me the product highlights",
  "sessionId": "session_1234_abc",
  "watchedIds": ["clip-1", "clip-2"],
  "timeWatched": 120,
  "timeLimit": 300,
  "queueLength": 1,
  "context": {}
}
```

**Response (continue playing):**
```json
{
  "scenes": [
    {
      "id": "clip-3",
      "name": "Feature Demo",
      "videoUrl": "https://cdn.example.com/feature.mp4",
      "inTime": 0,
      "outTime": 45,
      "description": "Main product features"
    },
    {
      "id": "clip-4",
      "name": "Customer Story",
      "videoUrl": "https://cdn.example.com/testimonial.mp4",
      "inTime": 10,
      "outTime": 60
    }
  ],
  "reasoning": "Showing features followed by social proof",
  "done": false
}
```

**Response (end playback):**
```json
{
  "scenes": [],
  "done": true,
  "endMessage": "You've seen all the highlights!"
}
```

## Configuration Options

```javascript
window.AGENTIC_PLAYER_CONFIG = {
  // REQUIRED: Your API endpoint
  apiEndpoint: 'https://api.yoursite.com/playlist',
  
  // Optional: API authentication
  apiKey: 'your-api-key',
  
  // Optional: Additional headers
  apiHeaders: {
    'X-Custom-Header': 'value'
  },
  
  // Optional: Custom context sent with each request
  context: {
    userId: '123',
    videoId: 'product-demo'
  },
  
  // Optional: Pre-fetch when this many clips remain (default: 2)
  prefetchWhenRemaining: 2,
  
  // Optional: Seconds before clip ends to check queue (default: 5)
  prefetchThreshold: 5
};
```

## Clip Properties

| Property | Required | Description |
|----------|----------|-------------|
| `id` | Yes | Unique identifier (used to track watched clips) |
| `name` | Yes | Display name |
| `videoUrl` | Yes | Full URL to the video file |
| `inTime` | Yes | Start time in seconds |
| `outTime` | Yes | End time in seconds |
| `description` | No | Optional description shown in UI |

## How Pre-fetching Works

1. Player starts with empty queue
2. Fetches first batch from API
3. Queues clips, starts playing first one
4. When `prefetchWhenRemaining` clips left (default: 2), fetches more
5. Also checks `prefetchThreshold` seconds before clip ends (default: 5)
6. Result: Seamless playback with no gaps

## API Design Tips

### Return 3-5 clips per request
- Enough for seamless playback
- Not too many (allows adaptation based on user behavior)

### Use `queueLength` to optimize
```javascript
// In your API
if (request.queueLength >= 3) {
  // Player has enough clips, return fewer or none
  return { scenes: [], done: false };
}
```

### Track watch patterns
The request includes:
- `watchedIds` - clips the user has seen
- `timeWatched` - total seconds watched
- `sessionId` - for session tracking

### Signal completion with context
```json
{
  "scenes": [],
  "done": true,
  "endMessage": "Great! You've seen the key features. Ready to try it?"
}
```

## Deployment

### Files
```
agentic-player/
├── index.html     # Player UI
├── player.js      # Player logic
├── styles.css     # Styling
└── README.md      # This file
```

### Deploy to any static host
```bash
# S3
aws s3 sync . s3://your-bucket/player/ --acl public-read

# Netlify/Vercel
# Just push to repo

# Any web server
# Copy files to public directory
```

### CORS
Make sure your API and video CDN have appropriate CORS headers:
```
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: POST, OPTIONS
Access-Control-Allow-Headers: Content-Type, Authorization
```

## Browser Support

- Chrome (recommended)
- Firefox
- Safari
- Edge

Requires ES6+ JavaScript and HTML5 Video.

## License

MIT License
