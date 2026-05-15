# Realtime API 2 Capabilities Reference

> Internal reference for the orb's GA Realtime API 2 integration (May 2026
> release of `gpt-realtime-2`). Covers session schema, audio output flow,
> the three new bidder agents (screen-vision, live-translate, mcp-bridge),
> and the affect-matching tone-steering hook. Pair with the OpenAI docs at
> `https://developers.openai.com/api/docs/guides/realtime` for the spec.

## Session schema (Phase 3 -- audio output active)

The orb opens a single WebSocket to `wss://api.openai.com/v1/realtime?model=gpt-realtime-2`
with bearer-only auth (`Authorization: Bearer <key>`). Immediately after
`open`, the listener sends:

```json
{
  "type": "session.update",
  "session": {
    "type": "realtime",
    "model": "gpt-realtime-2",
    "output_modalities": ["audio"],
    "reasoning": { "effort": "low" },
    "instructions": "Every time the user speaks, call handle_user_request with their verbatim transcript. After the function returns, speak the function output verbatim and stop. Do not invent answers; a brief preamble like \"one moment\" before calling the tool is fine.",
    "audio": {
      "input": {
        "format": { "type": "audio/pcm", "rate": 24000 },
        "transcription": { "model": "gpt-realtime-whisper" },
        "turn_detection": { "type": "semantic_vad" }
      },
      "output": {
        "format": { "type": "audio/pcm", "rate": 24000 },
        "voice": "marin"
      }
    },
    "tools": [
      {
        "type": "function",
        "name": "handle_user_request",
        "description": "REQUIRED: Process every user utterance.",
        "parameters": {
          "type": "object",
          "properties": {
            "transcript": { "type": "string", "description": "The exact text of what the user said" }
          },
          "required": ["transcript"]
        }
      }
    ],
    "tool_choice": "auto"
  }
}
```

Per the GA fact-check spike:

- `output_modalities` MUST be `["audio"]` OR `["text"]`, never both. The
  combined `["audio", "text"]` value is rejected with `invalid_request_error
  / Invalid modalities` and the session never opens. Audio-only mode still
  emits the spoken transcript via `response.output_audio_transcript.delta`
  events, so nothing user-visible is lost.
- `reasoning.effort: "low"` is the recommended default for production voice
  agents. The router does no heavy reasoning; it forwards transcripts.
- `cache_control` does NOT exist as a session.update field. The realtime
  API caches the session prefix automatically -- we read
  `usage.input_token_details.cached_tokens` off `response.done` to track it.
- `audio.output.voice` cannot change mid-session ("voice can be updated
  only if there have been no other audio outputs yet"). `marin` is the
  session-wide voice; per-agent voices require custom voice uploads.
- `tool_choice: "auto"` (not `"required"`) so the model can speak the
  function output rather than try to call the tool again after the
  function_call_output arrives. The instructions reliably route every
  utterance through `handle_user_request` regardless.

## Audio output flow

```
User speech
   |
   v
semantic_vad commits the turn
   |
   v
response.created (silent tool-call response)
   |
   v
response.function_call_arguments.done
   |
   v
We run the agent via exchange-bridge -> unified-bidder -> winning agent
   |
   v
voice-listener.respondToFunctionCall(callId, result)
   - sends conversation.item.create with function_call_output
   - sends response.create (with affect-tuned instructions if non-neutral)
   |
   v
response.created (audio reply response)
   |
   v
response.output_audio.delta * N    --> broadcast as audio_delta IPC
                                       --> orb's OrbAudio.addChunk
response.output_audio_transcript.delta * N --> broadcast as speech_text_delta
                                       --> barge-detector.onTtsUpdate
   |
   v
response.output_audio.done        --> broadcast as audio_done
                                       --> orb plays buffered PCM
                                       --> hudApi.speechEnded
                                       --> barge.onTtsEnd
```

First `response.output_audio.delta` flips `hudApi.speechStarted` and
`barge.onTtsStart` exactly once per `response_id` -- not on
`response.created`, because silent function-call responses also emit
`response.created`.

## Affect tone steering

`voice-listener.respondToFunctionCall` reads the AffectTracker via its
`getAffect` dep. If the user state is non-neutral, the explicit
`response.create` includes a tone-tuned instructions override. The map:

| Affect label          | Instruction tone               |
| --------------------- | ------------------------------ |
| frustrated / angry    | `calm and empathetic`          |
| sad                   | `gentle and warm`              |
| worried / anxious     | `reassuring and steady`        |
| excited / happy       | `upbeat and friendly`          |
| calm                  | `measured and friendly`        |

This replaces the pre-Phase-3 layer in `voice-speaker.js` that
post-edited the text. With realtime audio generated on the fly, we steer
the model's vocal tone via prompt instructions instead.

## Bidder agents added in Phase 2

### screen-vision-agent

- Wins on visual-referent intents ("what is this error", "read this",
  "what's on my screen", "summarize this article").
- `execute()` captures the screen via `desktopCapturer.getSources({ types: ['screen'] })`,
  picks the source matching the orb's display via
  `lib/screen-service.getDisplayForWindow`, base64-encodes the thumbnail
  (strips the `data:` prefix), calls `ai.vision(base64, prompt)`.
- No UI surface. Purely voice-activated via the unified-bidder.
- Test seam: `__setDeps({ captureScreenSource, visionAnswer })`.

### live-translate-agent

- Wins on session-control intents ("translate to Spanish", "stop translating",
  "switch translation to German").
- Classifies start vs stop vs switch via `ai.json` (fast profile).
- Calls `lib/live-translate-service.start({ sourceLang, targetLang })` to
  open a WebSocket to `wss://api.openai.com/v1/realtime/translations`.
- Test seam: `__setDeps({ aiJson, service })`.

### mcp-bridge-agent

- Wins on requests that match registered MCP server tools.
- Builds its bidder prompt dynamically at `initialize()` time by listing
  every tool from `settings.get('mcp.servers')` via `lib/mcp-client.js`.
- `execute()` asks the fast model to pick a tool, then calls it via the
  MCP client; abstains below 0.6 confidence.
- Settings key: `mcp.servers` -- array of
  `{ id, label, transport, url?, headers?, command?, args?, env?, cwd?, enabled }`.
  Managed via Settings -> MCP Servers. The agent reloads its tool list
  every time the list changes via the `mcp:save-servers` IPC handler in
  main.js. Reload calls `close()` on the prior client set so stdio
  subprocesses are killed before the new ones spawn.
- Test seam: `__setDeps({ loadServers, createClient, aiJson })`.

### MCP transport: HTTP and stdio

`lib/mcp-client.js` supports both transports per the MCP spec:

**HTTP** -- POST JSON-RPC requests to a URL, single-response JSON bodies.
Use for hosted MCP servers (OpenAI, Edison, etc.).

```javascript
const client = createClient({
  transport: 'http', // default
  url: 'https://example.com/mcp',
  label: 'GitHub',
  headers: { Authorization: 'Bearer ghp_...' },
});
```

**stdio** -- spawn a subprocess and exchange newline-delimited JSON-RPC
messages on its stdin/stdout. Stderr is captured at debug-log level.
Most community MCP servers ship as stdio subprocesses (filesystem, git,
sqlite, Linear, etc.).

```javascript
const client = createClient({
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-filesystem', '/Users/me/Documents'],
  env: { /* optional extra env, merged with process.env */ },
  cwd: '/optional/working/dir',
  label: 'Filesystem',
});
```

The client spawns the subprocess lazily on first request, multiplexes
concurrent JSON-RPC calls by id, dispatches responses regardless of
chunk boundaries, rejects pending requests on subprocess exit, and
kills the subprocess on `client.close()`.

### MCP Servers settings UI

Located in `settings.html` under the "MCP Servers" sidebar tab. CRUD UI
that supports both transports:

- Lists registered servers with a transport badge (HTTP / stdio), label,
  and an enabled indicator. stdio rows show the command line; HTTP rows
  show the URL.
- "Add MCP Server" opens a form with label, transport selector, and
  transport-specific fields:
  - HTTP: URL + optional headers JSON.
  - stdio: command + args (one per line) + optional env JSON + optional cwd.
- "Test Connection" probes the server via `mcp:test-connection` IPC.
  For stdio it spawns the subprocess, runs `initialize` + `tools/list`,
  then kills the process (the IPC handler wraps the test in a try/finally
  with `client.close()`).
- "Save" persists via `mcp:save-servers` IPC, which writes
  `settings.mcp.servers` and hot-reloads the bridge agent.
- "Remove" / "Disable" buttons on each row for quick edits.

Both IPC handlers live in `main.js`. Channels are gated by the preload
allowlist (`preload.js`). The handlers call `getAgent('mcp-bridge-agent')`
from the agent registry and invoke `agent.reload()` after saving.

## Live translate service event schema

The translation endpoint uses session-prefixed event types (different
from the conversation API):

| Direction | Event                                  | Notes                                |
| --------- | -------------------------------------- | ------------------------------------ |
| Client    | `session.update`                       | `{ audio: { output: { language } } }`|
| Client    | `session.input_audio_buffer.append`    | base64 PCM16, 24kHz                  |
| Server    | `session.output_audio.delta`           | translated audio (base64 PCM)        |
| Server    | `session.input_transcript.delta/done`  | source-language captions             |
| Server    | `session.output_transcript.delta/done` | target-language captions             |

The service broadcasts normalised events to subscribers:
`session_started`, `session_stopped`, `caption_delta`, `caption_final`,
`audio_delta`, `error`.

### IPC bridge to renderer windows

A bridge inline in `main.js` forwards service events to any renderer
that subscribes via `live-translate:subscribe`. The bridge attaches a
single service subscriber on first use and fans out per-webContents,
pruning destroyed senders automatically.

```
lib/live-translate-service.subscribe(cb)
        |
        v
main.js bridge fan-out
        |
        +--> wc.send('live-translate:event', payload) for each subscribed window
```

Recorder integration: `preload-recorder.js` exposes
`window.recorder.liveTranslate.{subscribe,unsubscribe,getStatus}`. The
recorder app subscribes during `init()`, and `handleLiveTranslateEvent`
routes the events into the existing `caption-overlay` UI:

- `session_started` -> auto-enable captions, show "Translating X -> Y..."
- `caption_delta` -> show translated text as interim caption
- `caption_final` -> commit final caption
- `session_stopped` -> clear caption overlay
- `error` -> surface error in the caption overlay

Other windows can subscribe identically -- the bridge channels are
`live-translate:subscribe`, `live-translate:unsubscribe`,
`live-translate:status`, and the broadcast event is `live-translate:event`.

## Pricing (per 1M tokens)

| Bucket               | gpt-realtime-2 | gpt-realtime-whisper | gpt-realtime-translate |
| -------------------- | -------------- | -------------------- | ---------------------- |
| Text input           | $4             | $4                   | $4                     |
| Text output          | $24            | $24                  | $24                    |
| Audio input          | $32            | $32                  | $32                    |
| Audio output         | $64            | (n/a)                | $64                    |
| Cached input         | $0.40          | $0.40                | $0.40                  |

`calculateCost(model, inputTokens, outputTokens, options)` accepts
`inputAudioTokens`, `outputAudioTokens`, and `cachedInputTokens` in the
options object. Cached tokens are subtracted from billed input before
pricing; the cached portion is priced at `inputCached`.

## Follow-ups (next iteration)

1. **Per-agent voices**. Today every orb response is voiced by `marin`.
   Pre-Phase-3 each agent had its own voice (`getCapChewVoice`). GA blocks
   mid-session voice changes after the first audio response; the path
   forward is custom voice uploads to OpenAI's voice library, indexed by
   agent ID, then passed as `audio.output.voice: { id: 'voice_xxx' }`.
2. ~~**Recorder live-captions UI**~~ -- shipped: main.js bridges the
   service to recorder windows via `live-translate:subscribe`,
   `preload-recorder.js` exposes the API as `window.recorder.liveTranslate`,
   and `recorder.html` auto-enables captions and renders source / target
   text into the existing overlay. See the "IPC bridge to renderer
   windows" section above.
3. ~~**MCP server settings UI**~~ -- shipped in the v4.9.0 follow-up.
   Settings -> MCP Servers tab supports add / edit / remove / enable /
   test, with hot-reload of the bridge agent. See the "MCP Servers
   settings UI" section above.
4. ~~**MCP stdio transport**~~ -- shipped: `lib/mcp-client.js` now supports
   both HTTP and stdio. stdio spawns the subprocess lazily, exchanges
   newline-delimited JSON-RPC, multiplexes concurrent calls by id, and
   kills the subprocess on `close()`. Settings UI exposes a transport
   selector + command/args/env/cwd fields. Test seam takes a fake
   `spawnFn`; new `test/fixtures/mcp-stdio-echo.js` exercises the real
   subprocess path. See "MCP transport: HTTP and stdio" above.
5. **Async function calling preambles**. The prompt now allows preambles
   ("one moment") but the model has to decide when to use them; we don't
   trigger them explicitly. Tune via the prompting guide once we have
   live data on real users.
