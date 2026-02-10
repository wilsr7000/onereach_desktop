# Centralized Logging API

All event logging in the app flows through a **central event queue** (`lib/log-event-queue.js`). The queue is exposed via four access methods: in-process require, IPC bridge, REST API, and WebSocket.

## Architecture

```
Producers (all code) --> LogEventQueue --> Consumers
                                           |-- FileWriter (event-logger.js, disk persistence)
                                           |-- RingBuffer (last 10,000 events, in-memory)
                                           |-- StatsCollector (counts, rates)
                                           |-- REST Server (http://127.0.0.1:47292)
                                           |-- WebSocket Server (ws://127.0.0.1:47292/ws)
                                           |-- IPC Broadcaster (renderer windows)
```

## Event Schema

Every log event has this structure:

```json
{
  "id": "m1abc23xy",
  "timestamp": "2026-02-07T23:45:08.374Z",
  "level": "info",
  "category": "spaces",
  "message": "Space created",
  "source": "main",
  "data": { "spaceId": "abc-123", "name": "My Space" }
}
```

**Fields:**
- `id` -- Unique identifier (timestamp + random)
- `timestamp` -- ISO 8601 timestamp
- `level` -- `debug`, `info`, `warn`, or `error`
- `category` -- See category reference below
- `message` -- Human-readable description
- `source` -- `main`, `renderer`, `external`, or `websocket`
- `data` -- Arbitrary structured data object

## Categories

| Category | Used by |
|---|---|
| `app` | Main process, general application events |
| `agent` | All agent files (packages/agents/) |
| `voice` | Voice SDK, speech, transcription |
| `video` | Video editor, video processing |
| `spaces` | Spaces API, storage |
| `clipboard` | Clipboard manager, storage |
| `network` | HTTP requests, API calls |
| `api` | AI service, provider adapters |
| `ipc` | IPC handlers, HUD API |
| `window` | Browser windows, tabs |
| `performance` | Performance metrics, timers |
| `user-action` | User interactions, clicks |
| `recorder` | Screen/audio recording |
| `settings` | Settings changes |
| `menu` | Menu actions, navigation |
| `file` | File operations |
| `module` | Module management |
| `external` | Events from external tools (REST/WS) |
| `task-exchange` | Task exchange system |
| `test` | Test-related logging |

---

## Access Method 1: In-Process (Node.js `require`)

For main process code. This is the primary method used throughout the codebase.

```javascript
const { getLogQueue } = require('./lib/log-event-queue');
const log = getLogQueue();

// Convenience methods
log.info('spaces', 'Space created', { spaceId: '123', name: 'My Space' });
log.warn('network', 'Slow API response', { endpoint: '/api/chat', duration: 5200 });
log.error('agent', 'Agent failed', { agent: 'calendar', error: err.message });
log.debug('video', 'Frame processed', { frame: 42 });

// Generic enqueue
log.enqueue({ level: 'info', category: 'app', message: 'Custom event', data: {} });
```

**Require paths by location:**
- Root files: `./lib/log-event-queue`
- From lib/: `./log-event-queue`
- From src/: `../lib/log-event-queue`
- From src/video/core/: `../../../lib/log-event-queue`
- From packages/agents/: `../../lib/log-event-queue`

**Query and subscribe:**

```javascript
// Query ring buffer (returns newest first)
const errors = log.query({ level: 'error', category: 'agent', limit: 50 });

// Subscribe to real-time events
const unsub = log.subscribe({ level: 'error' }, (entry) => {
  console.log('Error:', entry.message);
});

// Unsubscribe
unsub();

// Get stats
const stats = log.getStats();
// { total, byLevel, byCategory, errorsPerMinute, ringBufferSize, ... }

// Export logs (reads from disk for full history)
const exported = await log.export({ since: '2026-02-06', format: 'json' });
```

---

## Access Method 2: IPC Bridge (`window.logging`)

For renderer processes. Available via the preload script.

```javascript
// Producer -- push events
window.logging.info('video', 'Timeline loaded', { tracks: 5 });
window.logging.error('video', 'Export failed', { error: 'Disk full' });
window.logging.warn('clipboard', 'Large item', { size: 15000000 });
window.logging.debug('app', 'Render cycle', { fps: 60 });

// Consumer -- query
const logs = await window.logging.query({ level: 'error', limit: 20 });
const stats = await window.logging.getStats();
const recent = await window.logging.getRecentLogs(50);
const files = await window.logging.getFiles();

// Real-time subscription
await window.logging.subscribe({ level: 'error' });
window.logging.onEvent((entry) => {
  console.log('Live event:', entry);
});
```

**Backward compatibility:** `window.api.log.info()`, `window.api.log.error()`, etc. still work and route through the queue.

---

## Access Method 3: REST API

HTTP server at `http://127.0.0.1:47292`. Starts automatically when the app launches.

### GET /health

Server status and queue stats.

```bash
curl http://127.0.0.1:47292/health
```

Response:
```json
{
  "status": "ok",
  "port": 47292,
  "uptime": 342.5,
  "queue": { "total": 1523, "byLevel": {...}, "byCategory": {...} },
  "connections": { "websocket": 2, "sse": 0 }
}
```

### GET /logs

Query log entries from the ring buffer.

**Parameters:**
- `level` -- Filter by level (`debug`, `info`, `warn`, `error`)
- `category` -- Filter by category
- `source` -- Filter by source (`main`, `renderer`, `external`)
- `search` -- Text search in message and data
- `since` -- ISO timestamp lower bound
- `until` -- ISO timestamp upper bound
- `limit` -- Max results (default 100, max 1000)
- `offset` -- Skip N results

```bash
# Recent errors
curl "http://127.0.0.1:47292/logs?level=error&limit=20"

# Agent logs from last hour
curl "http://127.0.0.1:47292/logs?category=agent&since=2026-02-07T23:00:00Z"

# Search for a term
curl "http://127.0.0.1:47292/logs?search=Space+created"
```

Response:
```json
{
  "count": 3,
  "query": { "level": "error", "limit": 20 },
  "data": [
    { "id": "...", "timestamp": "...", "level": "error", "category": "agent", "message": "...", "data": {} },
    ...
  ]
}
```

### GET /logs/stats

Aggregated statistics.

```bash
curl http://127.0.0.1:47292/logs/stats
```

Response:
```json
{
  "total": 1523,
  "byLevel": { "debug": 200, "info": 1100, "warn": 150, "error": 73 },
  "byCategory": { "app": 500, "agent": 300, "video": 200, ... },
  "errorsPerMinute": 2.4,
  "ringBufferSize": 1523,
  "ringBufferCapacity": 10000,
  "subscriberCount": 1,
  "startedAt": "2026-02-07T20:00:00Z",
  "minLevel": "debug"
}
```

### GET /logs/stream

Server-Sent Events (SSE) stream. Alternative to WebSocket for simple clients.

**Parameters:** `level`, `category`, `source`, `minLevel`

```bash
# Stream all error events
curl -N "http://127.0.0.1:47292/logs/stream?level=error"

# Stream all events at warn level and above
curl -N "http://127.0.0.1:47292/logs/stream?minLevel=warn"
```

### GET /logs/export

Export logs (reads from file-backed storage for full history).

**Parameters:** `since`, `until`, `format` (`json` or `text`), `level`, `category`, `limit`

```bash
curl "http://127.0.0.1:47292/logs/export?format=text&since=2026-02-07"
```

### POST /logs

Push a log event from an external source.

```bash
curl -X POST http://127.0.0.1:47292/logs \
  -H "Content-Type: application/json" \
  -d '{"level":"info","category":"external","message":"Build completed","data":{"duration":45}}'
```

Response:
```json
{ "success": true, "entry": { "id": "...", "timestamp": "...", ... } }
```

---

## Access Method 4: WebSocket

Connect to `ws://127.0.0.1:47292/ws` for real-time bidirectional communication.

### Client to Server Messages

**Subscribe to events:**
```json
{ "type": "subscribe", "filter": { "level": "error", "category": "agent" } }
{ "type": "subscribe" }
```

**Unsubscribe:**
```json
{ "type": "unsubscribe" }
```

**Query logs:**
```json
{ "type": "query", "id": "q1", "params": { "level": "error", "limit": 50 } }
```

**Get stats:**
```json
{ "type": "stats" }
```

**Push a log event:**
```json
{ "type": "log", "level": "info", "category": "external", "message": "Hello", "data": {} }
```

### Server to Client Messages

**Real-time event (after subscribing):**
```json
{ "type": "event", "data": { "id": "...", "timestamp": "...", "level": "error", ... } }
```

**Query result:**
```json
{ "type": "query-result", "id": "q1", "data": [...] }
```

**Stats:**
```json
{ "type": "stats", "data": { "total": 1523, ... } }
```

**Subscription confirmed:**
```json
{ "type": "subscribed", "filter": { "level": "error" } }
```

### JavaScript WebSocket Example

```javascript
const ws = new WebSocket('ws://127.0.0.1:47292/ws');

ws.onopen = () => {
  // Subscribe to all error events
  ws.send(JSON.stringify({ type: 'subscribe', filter: { level: 'error' } }));
};

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.type === 'event') {
    console.log(`[${msg.data.category}] ${msg.data.message}`);
  }
};
```

### Python WebSocket Example

```python
import asyncio, websockets, json

async def monitor():
    async with websockets.connect('ws://127.0.0.1:47292/ws') as ws:
        await ws.send(json.dumps({"type": "subscribe", "filter": {"level": "error"}}))
        async for message in ws:
            event = json.loads(message)
            if event["type"] == "event":
                print(f"[{event['data']['category']}] {event['data']['message']}")

asyncio.run(monitor())
```

---

## Configuration

### Set minimum log level

```javascript
const log = getLogQueue();
log.setMinLevel('warn'); // Only warn and error events will be processed
```

### Ring buffer size

Default is 10,000 entries. Modify in `lib/log-event-queue.js`:

```javascript
this._maxRingSize = 10000; // Change as needed
```

### Server port

Default is 47292. Change in `lib/log-server.js`:

```javascript
const PORT = 47292; // Change as needed
```

---

## Migration Guide

When writing new code, always use the centralized logging queue instead of `console.log`:

```javascript
// BAD
console.log('[MyModule] Something happened:', data);
console.error('Failed to process:', error);

// GOOD
const { getLogQueue } = require('./lib/log-event-queue');
const log = getLogQueue();
log.info('app', 'Something happened', { data });
log.error('app', 'Failed to process', { error: error.message });
```

In renderer processes:

```javascript
// BAD
console.log('Button clicked');

// GOOD
window.logging.info('user-action', 'Button clicked', { target: 'save' });
```

---

## Testing

Run the test suite:

```bash
node test-log-queue.js
```

This tests the queue (enqueue, query, subscribe, stats) and the REST server (all endpoints).
