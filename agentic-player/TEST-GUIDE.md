# Agentic Player - Testing Guide

## Overview

The agentic player now features:
- **Smart buffering** with video preloading for seamless transitions
- **Exponential backoff retry** for network resilience (3 attempts: 1s, 2s, 4s)
- **Buffer health monitoring** with critical/warning thresholds
- **Rich context** sent to API (prompt, sessionId, watchedIds, timeWatched, etc.)

## Test Modes

### 1. Mock API Test (Recommended for Development)

Open `test-player.html` in your browser:

```bash
open agentic-player/test-player.html
```

**Test Controls:**
- **Batch Size**: 1-5 clips per API response
- **Total Clips**: Total number of clips to deliver
- **API Delay**: Simulated network latency (ms)
- **Clip Duration**: How long each test clip plays
- **Simulate Errors**: 20% chance of API failure (tests retry logic)

**Test Scenarios:**

1. **Single Clip Batches** (Stress Test)
   - Batch Size: 1
   - Total Clips: 20
   - API Delay: 100ms
   - Expected: Smooth playback with frequent API calls

2. **Network Latency**
   - Batch Size: 3
   - Total Clips: 15
   - API Delay: 2000ms (2 seconds)
   - Expected: Preloading prevents stutters

3. **Error Recovery**
   - Enable "Simulate Errors"
   - Batch Size: 2
   - Expected: Player retries with exponential backoff, continues playing

4. **Large Batches**
   - Batch Size: 5
   - Total Clips: 25
   - API Delay: 500ms
   - Expected: Fewer API calls, smooth buffering

### 2. Real API Test

Configure the player with your API endpoint:

```javascript
// In index.html or via config
window.AGENTIC_PLAYER_CONFIG = {
  apiEndpoint: 'https://your-api.com/clips',
  apiKey: 'your-api-key',
  prefetchWhenRemaining: 2,
  prefetchThreshold: 5
};
```

**API Contract:**

**Request (POST):**
```json
{
  "prompt": "Show me product demos",
  "sessionId": "session-abc123",
  "watchedIds": ["clip-1", "clip-2"],
  "timeWatched": 45.5,
  "timeLimit": 300,
  "queueLength": 1,
  "context": {}
}
```

**Response (More Clips):**
```json
{
  "scenes": [
    {
      "id": "clip-3",
      "name": "Product Overview",
      "videoUrl": "https://cdn.example.com/video3.mp4",
      "inTime": 0,
      "outTime": 15.5,
      "description": "Overview of key features"
    }
  ],
  "done": false,
  "reasoning": "Selected this clip because it matches the user's interest in product features"
}
```

**Response (End of Playlist):**
```json
{
  "scenes": [],
  "done": true,
  "endMessage": "You've seen all available product demos"
}
```

## Buffering Behavior

### Prefetch Triggers

1. **API Fetch**: When queue drops to ≤2 clips
2. **Video Preload**: Immediately preload next clip in hidden element
3. **Critical Buffer**: When <3 seconds remain and queue is empty

### Buffer States

| Time Remaining | Queue Length | Action |
|----------------|--------------|--------|
| > 10s | Any | Healthy - hide loading |
| 5-10s | > 0 | Warning - prefetch API |
| 3-5s | 0 | Critical - show loading + emergency fetch |
| < 3s | 0 | CRITICAL - emergency fetch, visible loading |

### Retry Logic

**Exponential Backoff:**
- Attempt 1: Immediate
- Attempt 2: 1 second delay
- Attempt 3: 2 second delay
- Attempt 4: 4 second delay
- After 3 retries: Give up, show error (if no clips in queue)

**During Retries:**
- Player continues playing from queue
- Loading indicator shown
- Reasoning log shows retry attempts
- If clips are still in queue, playback continues uninterrupted

## Expected Behavior

### Seamless Transitions

✅ **Good:** Clip 1 ends → Instant switch to Clip 2 (no black frame)
❌ **Bad:** Clip 1 ends → Loading spinner → Clip 2 starts

The preloaded video element ensures the next clip is already buffered.

### Network Resilience

✅ **Good:** API fails → Player retries → Success → Playback continues
❌ **Bad:** API fails → Player stops immediately

### Dynamic Delivery

✅ **Good:** Server can keep delivering clips one-by-one based on user behavior
❌ **Bad:** All clips must be known upfront

## Monitoring

Watch the browser console for detailed logs:

```
[Player] Initializing...
[Player] Ready. API: /test-api
[Player] Session started: session-abc123
[Player] Fetching clips from API...
[Player] API response: {scenes: Array(3), done: false}
[Player] Queued 3 clips (total: 3)
[Player] Preloaded next clip: Test Clip 1
[Player] Using preloaded video for seamless transition
[Player] Seamless transition complete
[Player] Queue low (2), pre-fetching clips from API...
```

## Performance Metrics

Good performance indicators:
- **API calls**: ~every 2-3 clips (based on batch size)
- **Preload time**: Should complete before current clip ends
- **Transition delay**: 0ms (instant switch)
- **Retry success rate**: >90% after max attempts

## Troubleshooting

**Clips buffer but don't preload:**
- Check browser console for CORS errors
- Ensure video URLs are accessible
- Try adding `crossOrigin="anonymous"` to video element

**Excessive API calls:**
- Increase `prefetchWhenRemaining` (default: 2)
- Increase batch size on server

**Stuttering on transitions:**
- Reduce `prefetchThreshold` to fetch earlier (default: 5s)
- Check network speed - slow networks need more buffer time
- Verify preloaded video is actually buffering (check console logs)

**Retries not working:**
- Check that server returns proper HTTP status codes (500, 503, etc.)
- Verify error simulation is enabled
- Check console for retry logs

## Browser Compatibility

Tested on:
- Chrome/Edge 90+
- Firefox 88+
- Safari 14+

Requires:
- Fetch API
- Promises/Async-Await
- HTML5 Video
- ES6 features

## Next Steps

After testing, integrate with your real API endpoint that:
1. Receives user prompt and context
2. Uses AI/logic to select relevant clips
3. Returns clips in batches
4. Signals completion with `done: true`



































