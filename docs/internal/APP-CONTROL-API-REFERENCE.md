# App Control API Reference

Internal reference for the unified action layer implemented in `action-executor.js`. Last generated from registry introspection (143 actions). Parameter tables are authoritative; execute handlers may impose additional runtime requirements.

---

## 1. Overview

`action-executor.js` defines `ACTION_REGISTRY`, the single command surface for operations that must be reachable from multiple entry points:

- **IPC (main process):** `action:execute`, `action:list`, `action:has`, `action:info` (registered by `setupActionIPC()`).
- **REST:** HTTP routes on the log server (`lib/log-server.js`), default **127.0.0.1:47292** (same process as structured logging).
- **Command palette / menus:** Dispatch into `executeAction()` with a string action id and a params object.
- **Voice and agent bridge:** HUD / exchange paths call the same executor (for example `voice-submit-task`).

Downstream code (windows, `global.*` managers, lazy `require()` helpers) is invoked only through registry entries, keeping automation and UI consistent.

---

## 2. Quick Start

Assumes the app is running and the log server is listening on port **47292**.

**List all actions (grouped by category):**

```bash
curl -s http://127.0.0.1:47292/app/actions | python3 -m json.tool
```

**Inspect one action (params schema):**

```bash
curl -s http://127.0.0.1:47292/app/actions/open-settings | python3 -m json.tool
```

**Open Settings (optional section):**

```bash
curl -s -X POST http://127.0.0.1:47292/app/actions/open-settings \
  -H 'Content-Type: application/json' \
  -d '{"section":"general"}'
```

**Create a local agent:**

```bash
curl -s -X POST http://127.0.0.1:47292/app/actions/agents-create \
  -H 'Content-Type: application/json' \
  -d '{"agentData":{"name":"Demo Agent","description":"Example"}}'
```

**Read all settings (secrets redacted in response):**

```bash
curl -s -X POST http://127.0.0.1:47292/app/actions/settings-get-all \
  -H 'Content-Type: application/json' \
  -d '{}'
```

**Submit a voice / agent pipeline task:**

```bash
curl -s -X POST http://127.0.0.1:47292/app/actions/voice-submit-task \
  -H 'Content-Type: application/json' \
  -d '{"text":"What is on my calendar today?","targetAgentId":"","spaceId":""}'
```

**Get full situational awareness snapshot** (windows, flow context, orb, agents, recent activity, settings):

```bash
curl -s -X POST http://127.0.0.1:47292/app/actions/app-situation \
  -H 'Content-Type: application/json' \
  -d '{}' | python3 -m json.tool
```

Response shape:

```json
{
  "success": true,
  "data": {
    "timestamp": "2026-03-25T08:15:00.000Z",
    "app": { "version": "4.4.1", "uptime": 3600, "pid": 12345 },
    "windows": {
      "total": 3,
      "focusedName": "settings",
      "open": [
        { "name": "main", "title": "GSX Power User", "visible": true, "focused": false },
        { "name": "settings", "title": "Settings", "visible": true, "focused": true },
        { "name": "orb", "title": "Voice Orb", "visible": true, "focused": false }
      ]
    },
    "flowContext": { "flowId": "abc", "label": "My Flow", "stepId": "s1", "stepLabel": "HTTP Request" },
    "voice": { "orbVisible": true, "listening": false, "connected": false },
    "agents": {
      "exchangeRunning": true,
      "connectedCount": 5,
      "connected": [{ "id": "cal-agent", "name": "Calendar Agent", "healthy": true }]
    },
    "recentActivity": {
      "recentBids": [{ "taskContent": "what time is it", "winnerId": "time-agent", "winnerName": "Time Agent", "timestamp": "..." }],
      "recentLogs": [{ "level": "info", "category": "app", "message": "...", "timestamp": "..." }]
    },
    "settings": { "theme": "dark", "llmProvider": "anthropic", "llmModel": "claude-sonnet", "diagnosticLogging": "info" }
  }
}
```

---

## 2b. Situation-Aware Logging

Three features merge situational awareness with the structured logging system.

### Contextual log entries

Every log entry automatically includes a `context` field with the state at the time the log was written:

```json
{
  "id": "m5abc1234",
  "timestamp": "2026-03-25T08:15:00.000Z",
  "level": "info",
  "category": "agent",
  "message": "Agent executed successfully",
  "source": "main",
  "data": { "agentId": "calendar-agent" },
  "context": {
    "focusedWindow": "settings",
    "flowId": "flow-abc-123",
    "stepId": "step-5"
  },
  "v": "4.5.0"
}
```

The `context.focusedWindow` tells you which window the user had focused. `context.flowId` and `context.stepId` tell you which Edison flow/step was active. This data is captured synchronously on every `enqueue()` call with negligible overhead.

### Periodic situation snapshots

A full `app-situation` snapshot is logged every 60 seconds as a `category: 'situation'` entry. This creates a queryable timeline of app state:

```bash
# Get the last 5 situation snapshots
curl "http://127.0.0.1:47292/logs?category=situation&limit=5" | python3 -m json.tool
```

Each snapshot contains windows, flow context, voice orb state, connected agents, recent bids, and key settings. The periodic logger is started at boot and does not prevent app exit.

### Unified status endpoint: `GET /app/status`

A single `GET` call that returns the situation snapshot, log statistics, recent logs, and recent errors together:

```bash
curl -s http://127.0.0.1:47292/app/status | python3 -m json.tool
```

Response shape:

```json
{
  "situation": { "timestamp": "...", "app": {}, "windows": {}, "flowContext": {}, "voice": {}, "agents": {}, "recentActivity": {}, "settings": {} },
  "logStats": { "total": 1234, "byLevel": {}, "byCategory": {}, "errorsPerMinute": 0.2 },
  "recentLogs": [ { "level": "info", "message": "...", "context": {}, "timestamp": "..." } ],
  "recentErrors": [ { "level": "error", "message": "...", "context": {}, "timestamp": "..." } ]
}
```

This replaces the need to call `/health` + `POST /app/actions/app-situation` + `GET /logs` separately.

---

## 3. Action Reference

Categories follow the `category` field in `ACTION_REGISTRY`:

`windows`, `idw`, `gsx`, `agents`, `settings`, `modules`, `tabs`, `credentials`, `budget`, `ai`, `ai-tabs`, `voice`, `video`, `backup`, `dev-tools`, `learning`, `search`, `system`, `tools`, `share`, `help`

For each category below:

1. A **parameter table** lists every action id with **required** (`params`) and **optional** (`optionalParams`) keys. A dash (—) means none.
2. **Example `curl` commands** follow: the shell **comment** on the first line is the full human-readable **description** for that action. Bodies use placeholders; replace paths, ids, and secrets with real values.

Table rows are kept within 120 columns; long `curl` JSON lines may exceed that where necessary.

### windows

| Action ID | Required params | Optional params |
| --- | --- | --- |
| `manage-environments` | — | — |
| `open-agent-manager` | — | — |
| `open-app-health` | — | — |
| `open-budget` | — | — |
| `open-claude-code-ui` | — | `mode`, `existingAgent` |
| `open-claude-terminal` | — | — |
| `open-clipboard` | — | — |
| `open-extension-setup` | — | — |
| `open-gsx-create` | — | — |
| `open-health-dashboard` | — | — |
| `open-idw-store` | — | — |
| `open-log-viewer` | — | — |
| `open-memory-editor` | — | `agentId` |
| `open-module-manager` | — | — |
| `open-recorder` | — | — |
| `open-settings` | — | `section` |
| `open-spaces` | — | — |
| `open-test-runner` | — | — |
| `open-video-editor` | — | — |

Example `curl` commands (placeholders; adjust paths and IDs):

```bash
# Open Setup Wizard to manage IDW environments
curl -s -X POST http://127.0.0.1:47292/app/actions/manage-environments \
  -H 'Content-Type: application/json' \
  -d '{}'
```

```bash
# Open Agent Manager
curl -s -X POST http://127.0.0.1:47292/app/actions/open-agent-manager \
  -H 'Content-Type: application/json' \
  -d '{}'
```

```bash
# Open App Health Dashboard
curl -s -X POST http://127.0.0.1:47292/app/actions/open-app-health \
  -H 'Content-Type: application/json' \
  -d '{}'
```

```bash
# Open Budget Dashboard
curl -s -X POST http://127.0.0.1:47292/app/actions/open-budget \
  -H 'Content-Type: application/json' \
  -d '{}'
```

```bash
# Open Agent Composer (Create Agent with AI)
curl -s -X POST http://127.0.0.1:47292/app/actions/open-claude-code-ui \
  -H 'Content-Type: application/json' \
  -d '{"mode":"create","existingAgent":{"id":"agent-id","name":"Agent"}}'
```

```bash
# Open Claude Code terminal for login
curl -s -X POST http://127.0.0.1:47292/app/actions/open-claude-terminal \
  -H 'Content-Type: application/json' \
  -d '{}'
```

```bash
# Open Clipboard (alias for Spaces)
curl -s -X POST http://127.0.0.1:47292/app/actions/open-clipboard \
  -H 'Content-Type: application/json' \
  -d '{}'
```

```bash
# Open Browser Extension Setup guide
curl -s -X POST http://127.0.0.1:47292/app/actions/open-extension-setup \
  -H 'Content-Type: application/json' \
  -d '{}'
```

```bash
# Open GSX Create (AI coding assistant)
curl -s -X POST http://127.0.0.1:47292/app/actions/open-gsx-create \
  -H 'Content-Type: application/json' \
  -d '{}'
```

```bash
# Open App Health Dashboard (alias)
curl -s -X POST http://127.0.0.1:47292/app/actions/open-health-dashboard \
  -H 'Content-Type: application/json' \
  -d '{}'
```

```bash
# Open IDW Store (browse and install IDW environments)
curl -s -X POST http://127.0.0.1:47292/app/actions/open-idw-store \
  -H 'Content-Type: application/json' \
  -d '{}'
```

```bash
# Open Event Log Viewer
curl -s -X POST http://127.0.0.1:47292/app/actions/open-log-viewer \
  -H 'Content-Type: application/json' \
  -d '{}'
```

```bash
# Open Memory Editor
curl -s -X POST http://127.0.0.1:47292/app/actions/open-memory-editor \
  -H 'Content-Type: application/json' \
  -d '{"agentId":"memory-agent-id"}'
```

```bash
# Open Module Manager UI
curl -s -X POST http://127.0.0.1:47292/app/actions/open-module-manager \
  -H 'Content-Type: application/json' \
  -d '{}'
```

```bash
# Open WISER Meeting Recorder
curl -s -X POST http://127.0.0.1:47292/app/actions/open-recorder \
  -H 'Content-Type: application/json' \
  -d '{}'
```

```bash
# Open Settings
curl -s -X POST http://127.0.0.1:47292/app/actions/open-settings \
  -H 'Content-Type: application/json' \
  -d '{"section":"general"}'
```

```bash
# Open Spaces (content organizer)
curl -s -X POST http://127.0.0.1:47292/app/actions/open-spaces \
  -H 'Content-Type: application/json' \
  -d '{}'
```

```bash
# Open Integrated Test Runner
curl -s -X POST http://127.0.0.1:47292/app/actions/open-test-runner \
  -H 'Content-Type: application/json' \
  -d '{}'
```

```bash
# Open Video Editor
curl -s -X POST http://127.0.0.1:47292/app/actions/open-video-editor \
  -H 'Content-Type: application/json' \
  -d '{}'
```

### idw

| Action ID | Required params | Optional params |
| --- | --- | --- |
| `idw-add` | `environment` | — |
| `idw-list` | — | — |
| `idw-remove` | `id` | — |
| `idw-store-directory` | — | — |
| `idw-update` | `id`, `updates` | — |
| `open-audio-generator` | `url` | `label` |
| `open-external-bot` | `url` | `label` |
| `open-idw` | `url` | `label` |
| `open-image-creator` | `url` | `label` |
| `open-ui-design-tool` | `url` | `label` |
| `open-video-creator` | `url` | `label` |

Example `curl` commands (placeholders; adjust paths and IDs):

```bash
# Add a new IDW environment
curl -s -X POST http://127.0.0.1:47292/app/actions/idw-add \
  -H 'Content-Type: application/json' \
  -d '{"environment":{"name":"My IDW","url":"https://example.com"}}'
```

```bash
# List all configured IDW environments
curl -s -X POST http://127.0.0.1:47292/app/actions/idw-list \
  -H 'Content-Type: application/json' \
  -d '{}'
```

```bash
# Remove an IDW environment
curl -s -X POST http://127.0.0.1:47292/app/actions/idw-remove \
  -H 'Content-Type: application/json' \
  -d '{"id":"record-id"}'
```

```bash
# Fetch the IDW store directory listing
curl -s -X POST http://127.0.0.1:47292/app/actions/idw-store-directory \
  -H 'Content-Type: application/json' \
  -d '{}'
```

```bash
# Update an existing IDW environment
curl -s -X POST http://127.0.0.1:47292/app/actions/idw-update \
  -H 'Content-Type: application/json' \
  -d '{"id":"record-id","updates":{"name":"Updated"}}'
```

```bash
# Open an audio generator tool
curl -s -X POST http://127.0.0.1:47292/app/actions/open-audio-generator \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com","label":"My tab"}'
```

```bash
# Open an external bot chat
curl -s -X POST http://127.0.0.1:47292/app/actions/open-external-bot \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com","label":"My tab"}'
```

```bash
# Open an IDW environment in a browser tab
curl -s -X POST http://127.0.0.1:47292/app/actions/open-idw \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com","label":"My tab"}'
```

```bash
# Open an image creator tool
curl -s -X POST http://127.0.0.1:47292/app/actions/open-image-creator \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com","label":"My tab"}'
```

```bash
# Open a UI design tool
curl -s -X POST http://127.0.0.1:47292/app/actions/open-ui-design-tool \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com","label":"My tab"}'
```

```bash
# Open a video creator tool
curl -s -X POST http://127.0.0.1:47292/app/actions/open-video-creator \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com","label":"My tab"}'
```

### gsx

| Action ID | Required params | Optional params |
| --- | --- | --- |
| `gsx-sync-backup` | — | — |
| `gsx-sync-clear-history` | — | — |
| `gsx-sync-settings` | — | — |
| `gsx-sync-spaces` | — | — |
| `gsx-sync-view-history` | — | — |
| `open-gsx-tool` | `url` | `title`, `environment` |

Example `curl` commands (placeholders; adjust paths and IDs):

```bash
# Run a complete GSX file sync backup
curl -s -X POST http://127.0.0.1:47292/app/actions/gsx-sync-backup \
  -H 'Content-Type: application/json' \
  -d '{}'
```

```bash
# Clear GSX file sync history
curl -s -X POST http://127.0.0.1:47292/app/actions/gsx-sync-clear-history \
  -H 'Content-Type: application/json' \
  -d '{}'
```

```bash
# Sync app settings to GSX
curl -s -X POST http://127.0.0.1:47292/app/actions/gsx-sync-settings \
  -H 'Content-Type: application/json' \
  -d '{}'
```

```bash
# Sync Spaces data to GSX
curl -s -X POST http://127.0.0.1:47292/app/actions/gsx-sync-spaces \
  -H 'Content-Type: application/json' \
  -d '{}'
```

```bash
# Get GSX file sync history
curl -s -X POST http://127.0.0.1:47292/app/actions/gsx-sync-view-history \
  -H 'Content-Type: application/json' \
  -d '{}'
```

```bash
# Open a GSX tool in a dedicated window
curl -s -X POST http://127.0.0.1:47292/app/actions/open-gsx-tool \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com","title":"Window title","environment":"default"}'
```

### agents

| Action ID | Required params | Optional params |
| --- | --- | --- |
| `agents-create` | `agentData` | — |
| `agents-delete` | `id` | — |
| `agents-enhance` | `agentId` | — |
| `agents-execute` | `agentId`, `phrase` | — |
| `agents-get-all-stats` | — | — |
| `agents-get-bid-history` | — | `limit` |
| `agents-get-stats` | `agentId` | — |
| `agents-gsx-add-connection` | `connData` | — |
| `agents-gsx-delete-connection` | `id` | — |
| `agents-gsx-list-connections` | — | — |
| `agents-gsx-test-connection` | `id` | — |
| `agents-gsx-update-connection` | `id`, `updates` | — |
| `agents-list` | — | — |
| `agents-list-builtin` | — | — |
| `agents-memory-delete` | `agentId` | — |
| `agents-memory-list` | — | — |
| `agents-memory-load` | `agentId` | — |
| `agents-memory-save` | `agentId`, `content` | — |
| `agents-revert` | `agentId`, `versionNumber` | — |
| `agents-set-builtin-enabled` | `agentId`, `enabled` | — |
| `agents-test-phrase` | `agentId`, `phrase` | — |
| `agents-test-phrase-all` | `phrase` | — |
| `agents-update` | `id`, `updates` | — |
| `agents-version-history` | `agentId` | — |

Example `curl` commands (placeholders; adjust paths and IDs):

```bash
# Create a new local agent
curl -s -X POST http://127.0.0.1:47292/app/actions/agents-create \
  -H 'Content-Type: application/json' \
  -d '{"agentData":{"name":"New Agent","description":"Does things"}}'
```

```bash
# Delete an agent
curl -s -X POST http://127.0.0.1:47292/app/actions/agents-delete \
  -H 'Content-Type: application/json' \
  -d '{"id":"record-id"}'
```

```bash
# Open Agent Composer to enhance an existing agent
curl -s -X POST http://127.0.0.1:47292/app/actions/agents-enhance \
  -H 'Content-Type: application/json' \
  -d '{"agentId":"agent-id"}'
```

```bash
# Execute an agent with a phrase
curl -s -X POST http://127.0.0.1:47292/app/actions/agents-execute \
  -H 'Content-Type: application/json' \
  -d '{"agentId":"agent-id","phrase":"example user phrase"}'
```

```bash
# Get execution statistics for all agents
curl -s -X POST http://127.0.0.1:47292/app/actions/agents-get-all-stats \
  -H 'Content-Type: application/json' \
  -d '{}'
```

```bash
# Get recent bid/auction history
curl -s -X POST http://127.0.0.1:47292/app/actions/agents-get-bid-history \
  -H 'Content-Type: application/json' \
  -d '{}'
```

```bash
# Get execution statistics for an agent
curl -s -X POST http://127.0.0.1:47292/app/actions/agents-get-stats \
  -H 'Content-Type: application/json' \
  -d '{"agentId":"agent-id"}'
```

```bash
# Add a GSX agent connection
curl -s -X POST http://127.0.0.1:47292/app/actions/agents-gsx-add-connection \
  -H 'Content-Type: application/json' \
  -d '{"connData":{"name":"GSX","baseUrl":"https://example.com"}}'
```

```bash
# Delete a GSX agent connection
curl -s -X POST http://127.0.0.1:47292/app/actions/agents-gsx-delete-connection \
  -H 'Content-Type: application/json' \
  -d '{"id":"record-id"}'
```

```bash
# List GSX agent connections
curl -s -X POST http://127.0.0.1:47292/app/actions/agents-gsx-list-connections \
  -H 'Content-Type: application/json' \
  -d '{}'
```

```bash
# Test a GSX agent connection
curl -s -X POST http://127.0.0.1:47292/app/actions/agents-gsx-test-connection \
  -H 'Content-Type: application/json' \
  -d '{"id":"record-id"}'
```

```bash
# Update a GSX agent connection
curl -s -X POST http://127.0.0.1:47292/app/actions/agents-gsx-update-connection \
  -H 'Content-Type: application/json' \
  -d '{"id":"record-id","updates":{"name":"Updated"}}'
```

```bash
# List all local (user-defined) agents
curl -s -X POST http://127.0.0.1:47292/app/actions/agents-list \
  -H 'Content-Type: application/json' \
  -d '{}'
```

```bash
# List built-in agents with enabled state
curl -s -X POST http://127.0.0.1:47292/app/actions/agents-list-builtin \
  -H 'Content-Type: application/json' \
  -d '{}'
```

```bash
# Delete memory for an agent
curl -s -X POST http://127.0.0.1:47292/app/actions/agents-memory-delete \
  -H 'Content-Type: application/json' \
  -d '{"agentId":"agent-id"}'
```

```bash
# List all agent memories
curl -s -X POST http://127.0.0.1:47292/app/actions/agents-memory-list \
  -H 'Content-Type: application/json' \
  -d '{}'
```

```bash
# Load memory content for an agent
curl -s -X POST http://127.0.0.1:47292/app/actions/agents-memory-load \
  -H 'Content-Type: application/json' \
  -d '{"agentId":"agent-id"}'
```

```bash
# Save memory content for an agent
curl -s -X POST http://127.0.0.1:47292/app/actions/agents-memory-save \
  -H 'Content-Type: application/json' \
  -d '{"agentId":"agent-id","content":"Agent memory text"}'
```

```bash
# Revert an agent to a previous version
curl -s -X POST http://127.0.0.1:47292/app/actions/agents-revert \
  -H 'Content-Type: application/json' \
  -d '{"agentId":"agent-id","versionNumber":1}'
```

```bash
# Enable or disable a built-in agent
curl -s -X POST http://127.0.0.1:47292/app/actions/agents-set-builtin-enabled \
  -H 'Content-Type: application/json' \
  -d '{"agentId":"agent-id","enabled":true}'
```

```bash
# Test how well a phrase matches a specific agent
curl -s -X POST http://127.0.0.1:47292/app/actions/agents-test-phrase \
  -H 'Content-Type: application/json' \
  -d '{"agentId":"agent-id","phrase":"example user phrase"}'
```

```bash
# Test a phrase against all agents and rank matches
curl -s -X POST http://127.0.0.1:47292/app/actions/agents-test-phrase-all \
  -H 'Content-Type: application/json' \
  -d '{"phrase":"example user phrase"}'
```

```bash
# Update an existing agent
curl -s -X POST http://127.0.0.1:47292/app/actions/agents-update \
  -H 'Content-Type: application/json' \
  -d '{"id":"record-id","updates":{"name":"Updated"}}'
```

```bash
# Get version history for an agent
curl -s -X POST http://127.0.0.1:47292/app/actions/agents-version-history \
  -H 'Content-Type: application/json' \
  -d '{"agentId":"agent-id"}'
```

### settings

| Action ID | Required params | Optional params |
| --- | --- | --- |
| `settings-get` | `key` | — |
| `settings-get-all` | — | — |
| `settings-save` | `settings` | — |
| `settings-set` | `key`, `value` | — |
| `settings-test-llm` | — | `provider` |

Example `curl` commands (placeholders; adjust paths and IDs):

```bash
# Get a single setting value
curl -s -X POST http://127.0.0.1:47292/app/actions/settings-get \
  -H 'Content-Type: application/json' \
  -d '{"key":"theme"}'
```

```bash
# Get all application settings
curl -s -X POST http://127.0.0.1:47292/app/actions/settings-get-all \
  -H 'Content-Type: application/json' \
  -d '{}'
```

```bash
# Save multiple settings at once
curl -s -X POST http://127.0.0.1:47292/app/actions/settings-save \
  -H 'Content-Type: application/json' \
  -d '{"settings":{"exampleKey":"value"}}'
```

```bash
# Set a single setting value
curl -s -X POST http://127.0.0.1:47292/app/actions/settings-set \
  -H 'Content-Type: application/json' \
  -d '{"key":"theme","value":"dark"}'
```

```bash
# Test LLM API connection
curl -s -X POST http://127.0.0.1:47292/app/actions/settings-test-llm \
  -H 'Content-Type: application/json' \
  -d '{"provider":"anthropic"}'
```

### modules

| Action ID | Required params | Optional params |
| --- | --- | --- |
| `modules-install-file` | `filePath` | — |
| `modules-install-url` | `url` | — |
| `modules-list` | — | — |
| `modules-open` | `moduleId` | — |
| `modules-remove` | `moduleId` | — |
| `web-tools-add` | `tool` | — |
| `web-tools-delete` | `toolId` | — |
| `web-tools-list` | — | — |
| `web-tools-open` | `toolId` | — |

Example `curl` commands (placeholders; adjust paths and IDs):

```bash
# Install a module from a local zip file
curl -s -X POST http://127.0.0.1:47292/app/actions/modules-install-file \
  -H 'Content-Type: application/json' \
  -d '{"filePath":"/path/to/module.zip"}'
```

```bash
# Install a module from a URL
curl -s -X POST http://127.0.0.1:47292/app/actions/modules-install-url \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com"}'
```

```bash
# List installed modules
curl -s -X POST http://127.0.0.1:47292/app/actions/modules-list \
  -H 'Content-Type: application/json' \
  -d '{}'
```

```bash
# Open an installed module
curl -s -X POST http://127.0.0.1:47292/app/actions/modules-open \
  -H 'Content-Type: application/json' \
  -d '{"moduleId":"installed-module-id"}'
```

```bash
# Remove an installed module
curl -s -X POST http://127.0.0.1:47292/app/actions/modules-remove \
  -H 'Content-Type: application/json' \
  -d '{"moduleId":"installed-module-id"}'
```

```bash
# Add a web tool
curl -s -X POST http://127.0.0.1:47292/app/actions/web-tools-add \
  -H 'Content-Type: application/json' \
  -d '{"tool":{"name":"My Tool","url":"https://example.com"}}'
```

```bash
# Delete a web tool
curl -s -X POST http://127.0.0.1:47292/app/actions/web-tools-delete \
  -H 'Content-Type: application/json' \
  -d '{"toolId":"web-tool-id"}'
```

```bash
# List installed web tools
curl -s -X POST http://127.0.0.1:47292/app/actions/web-tools-list \
  -H 'Content-Type: application/json' \
  -d '{}'
```

```bash
# Open a web tool
curl -s -X POST http://127.0.0.1:47292/app/actions/web-tools-open \
  -H 'Content-Type: application/json' \
  -d '{"toolId":"web-tool-id"}'
```

### tabs

| Action ID | Required params | Optional params |
| --- | --- | --- |
| `tab-list` | — | — |
| `tab-open` | `url` | — |

Example `curl` commands (placeholders; adjust paths and IDs):

```bash
# List open browser tabs
curl -s -X POST http://127.0.0.1:47292/app/actions/tab-list \
  -H 'Content-Type: application/json' \
  -d '{}'
```

```bash
# Open a URL in a new browser tab
curl -s -X POST http://127.0.0.1:47292/app/actions/tab-open \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com"}'
```

### credentials

| Action ID | Required params | Optional params |
| --- | --- | --- |
| `credentials-check` | `url` | — |
| `credentials-delete` | `accountKey` | — |
| `credentials-list` | — | — |
| `credentials-save` | `url`, `username`, `password` | `idwName` |
| `onereach-credentials-status` | — | — |

Example `curl` commands (placeholders; adjust paths and IDs):

```bash
# Check if a credential exists for a URL
curl -s -X POST http://127.0.0.1:47292/app/actions/credentials-check \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com"}'
```

```bash
# Delete a saved credential
curl -s -X POST http://127.0.0.1:47292/app/actions/credentials-delete \
  -H 'Content-Type: application/json' \
  -d '{"accountKey":"example.com:user@example.com"}'
```

```bash
# List saved credentials (domain and username only, no passwords)
curl -s -X POST http://127.0.0.1:47292/app/actions/credentials-list \
  -H 'Content-Type: application/json' \
  -d '{}'
```

```bash
# Save a credential for an IDW domain
curl -s -X POST http://127.0.0.1:47292/app/actions/credentials-save \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com","username":"user@example.com","password":"use-strong-secret","idwName":"My IDW"}'
```

```bash
# Check if unified OneReach credentials are configured
curl -s -X POST http://127.0.0.1:47292/app/actions/onereach-credentials-status \
  -H 'Content-Type: application/json' \
  -d '{}'
```

### budget

| Action ID | Required params | Optional params |
| --- | --- | --- |
| `budget-get-limits` | — | — |
| `budget-set-limit` | `category`, `limit` | — |
| `budget-stats-by-feature` | — | — |
| `budget-stats-by-model` | — | — |
| `budget-stats-by-provider` | — | — |
| `budget-summary` | — | `period` |
| `budget-usage-history` | — | `period` |

Example `curl` commands (placeholders; adjust paths and IDs):

```bash
# Get all budget limits
curl -s -X POST http://127.0.0.1:47292/app/actions/budget-get-limits \
  -H 'Content-Type: application/json' \
  -d '{}'
```

```bash
# Set a budget limit for a category
curl -s -X POST http://127.0.0.1:47292/app/actions/budget-set-limit \
  -H 'Content-Type: application/json' \
  -d '{"category":"general","limit":25}'
```

```bash
# Get cost breakdown by feature
curl -s -X POST http://127.0.0.1:47292/app/actions/budget-stats-by-feature \
  -H 'Content-Type: application/json' \
  -d '{}'
```

```bash
# Get cost breakdown by AI model
curl -s -X POST http://127.0.0.1:47292/app/actions/budget-stats-by-model \
  -H 'Content-Type: application/json' \
  -d '{}'
```

```bash
# Get cost breakdown by AI provider
curl -s -X POST http://127.0.0.1:47292/app/actions/budget-stats-by-provider \
  -H 'Content-Type: application/json' \
  -d '{}'
```

```bash
# Get AI cost summary
curl -s -X POST http://127.0.0.1:47292/app/actions/budget-summary \
  -H 'Content-Type: application/json' \
  -d '{"period":"daily"}'
```

```bash
# Get AI usage history
curl -s -X POST http://127.0.0.1:47292/app/actions/budget-usage-history \
  -H 'Content-Type: application/json' \
  -d '{"period":"daily"}'
```

### ai

| Action ID | Required params | Optional params |
| --- | --- | --- |
| `ai-chat` | `messages` | `profile`, `system`, `maxTokens`, `temperature`, `jsonMode`, `feature` |
| `ai-complete` | `prompt` | `profile` |
| `ai-embed` | `text` | — |
| `ai-image-generate` | `prompt` | `model`, `size`, `quality` |
| `ai-json` | `prompt` | `profile` |
| `ai-profiles` | — | — |
| `ai-status` | — | — |
| `ai-transcribe` | `audioPath` | — |
| `ai-vision` | `imageData`, `prompt` | `profile` |

Example `curl` commands (placeholders; adjust paths and IDs):

```bash
# Run an AI chat completion
curl -s -X POST http://127.0.0.1:47292/app/actions/ai-chat \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"Hello"}],"profile":"fast","system":"You are concise.","maxTokens":256,"temperature":0.7,"jsonMode":false,"feature":"rest-example"}'
```

```bash
# Run a text completion (convenience wrapper)
curl -s -X POST http://127.0.0.1:47292/app/actions/ai-complete \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"Say hello in one word.","profile":"fast"}'
```

```bash
# Generate text embeddings
curl -s -X POST http://127.0.0.1:47292/app/actions/ai-embed \
  -H 'Content-Type: application/json' \
  -d '{"text":"text to embed"}'
```

```bash
# Generate an image with DALL-E
curl -s -X POST http://127.0.0.1:47292/app/actions/ai-image-generate \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"Say hello in one word.","model":"dall-e-3","size":"1024x1024","quality":"standard"}'
```

```bash
# Run an AI completion that returns parsed JSON
curl -s -X POST http://127.0.0.1:47292/app/actions/ai-json \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"Say hello in one word.","profile":"fast"}'
```

```bash
# Get current AI model profile configuration
curl -s -X POST http://127.0.0.1:47292/app/actions/ai-profiles \
  -H 'Content-Type: application/json' \
  -d '{}'
```

```bash
# Get AI service status and circuit breaker state
curl -s -X POST http://127.0.0.1:47292/app/actions/ai-status \
  -H 'Content-Type: application/json' \
  -d '{}'
```

```bash
# Transcribe audio to text
curl -s -X POST http://127.0.0.1:47292/app/actions/ai-transcribe \
  -H 'Content-Type: application/json' \
  -d '{"audioPath":"/path/to/audio.m4a"}'
```

```bash
# Analyze an image with AI vision
curl -s -X POST http://127.0.0.1:47292/app/actions/ai-vision \
  -H 'Content-Type: application/json' \
  -d '{"imageData":"(base64-or-image-data-per-ai-service)","prompt":"Say hello in one word.","profile":"fast"}'
```

### ai-tabs

| Action ID | Required params | Optional params |
| --- | --- | --- |
| `open-chatgpt` | — | — |
| `open-claude` | — | — |
| `open-gemini` | — | — |
| `open-grok` | — | — |
| `open-perplexity` | — | — |

Example `curl` commands (placeholders; adjust paths and IDs):

```bash
# Open ChatGPT
curl -s -X POST http://127.0.0.1:47292/app/actions/open-chatgpt \
  -H 'Content-Type: application/json' \
  -d '{}'
```

```bash
# Open Claude
curl -s -X POST http://127.0.0.1:47292/app/actions/open-claude \
  -H 'Content-Type: application/json' \
  -d '{}'
```

```bash
# Open Gemini
curl -s -X POST http://127.0.0.1:47292/app/actions/open-gemini \
  -H 'Content-Type: application/json' \
  -d '{}'
```

```bash
# Open Grok
curl -s -X POST http://127.0.0.1:47292/app/actions/open-grok \
  -H 'Content-Type: application/json' \
  -d '{}'
```

```bash
# Open Perplexity
curl -s -X POST http://127.0.0.1:47292/app/actions/open-perplexity \
  -H 'Content-Type: application/json' \
  -d '{}'
```

### voice

| Action ID | Required params | Optional params |
| --- | --- | --- |
| `voice-exchange-status` | — | — |
| `voice-orb-hide` | — | — |
| `voice-orb-show` | — | — |
| `voice-orb-toggle` | — | — |
| `voice-submit-task` | `text` | `targetAgentId`, `spaceId` |

Example `curl` commands (placeholders; adjust paths and IDs):

```bash
# Get the agent exchange bridge status
curl -s -X POST http://127.0.0.1:47292/app/actions/voice-exchange-status \
  -H 'Content-Type: application/json' \
  -d '{}'
```

```bash
# Hide the Voice Orb
curl -s -X POST http://127.0.0.1:47292/app/actions/voice-orb-hide \
  -H 'Content-Type: application/json' \
  -d '{}'
```

```bash
# Show the Voice Orb
curl -s -X POST http://127.0.0.1:47292/app/actions/voice-orb-show \
  -H 'Content-Type: application/json' \
  -d '{}'
```

```bash
# Toggle the Voice Orb visibility
curl -s -X POST http://127.0.0.1:47292/app/actions/voice-orb-toggle \
  -H 'Content-Type: application/json' \
  -d '{}'
```

```bash
# Submit a task to the voice/agent pipeline
curl -s -X POST http://127.0.0.1:47292/app/actions/voice-submit-task \
  -H 'Content-Type: application/json' \
  -d '{"text":"text to embed","targetAgentId":"optional-agent","spaceId":"optional-space"}'
```

### video

| Action ID | Required params | Optional params |
| --- | --- | --- |
| `video-get-info` | `inputPath` | — |
| `video-transcribe` | `inputPath` | — |
| `video-trim` | `inputPath`, `startTime`, `endTime` | `outputPath` |

Example `curl` commands (placeholders; adjust paths and IDs):

```bash
# Get media file information
curl -s -X POST http://127.0.0.1:47292/app/actions/video-get-info \
  -H 'Content-Type: application/json' \
  -d '{"inputPath":"/path/to/media.mp4"}'
```

```bash
# Transcribe audio from a video/audio file
curl -s -X POST http://127.0.0.1:47292/app/actions/video-transcribe \
  -H 'Content-Type: application/json' \
  -d '{"inputPath":"/path/to/media.mp4"}'
```

```bash
# Trim a video/audio file
curl -s -X POST http://127.0.0.1:47292/app/actions/video-trim \
  -H 'Content-Type: application/json' \
  -d '{"inputPath":"/path/to/media.mp4","startTime":0,"endTime":60,"outputPath":"/path/out.mp4"}'
```

### backup

| Action ID | Required params | Optional params |
| --- | --- | --- |
| `backup-list` | — | — |
| `backup-open-folder` | — | — |

Example `curl` commands (placeholders; adjust paths and IDs):

```bash
# List available app backups
curl -s -X POST http://127.0.0.1:47292/app/actions/backup-list \
  -H 'Content-Type: application/json' \
  -d '{}'
```

```bash
# Open the backups folder in Finder
curl -s -X POST http://127.0.0.1:47292/app/actions/backup-open-folder \
  -H 'Content-Type: application/json' \
  -d '{}'
```

### dev-tools

| Action ID | Required params | Optional params |
| --- | --- | --- |
| `dev-tools-copy-flow-context` | — | — |
| `dev-tools-copy-flow-id` | — | — |
| `dev-tools-toggle-logging` | — | `enabled` |
| `open-build-step-template` | — | — |
| `open-configure-step` | — | — |
| `open-flow-logs` | — | `logs` |
| `open-library-browser` | — | — |
| `open-sdk-dashboard` | — | — |
| `open-validator-results` | — | `results` |

Example `curl` commands (placeholders; adjust paths and IDs):

```bash
# Copy the full flow context JSON to clipboard
curl -s -X POST http://127.0.0.1:47292/app/actions/dev-tools-copy-flow-context \
  -H 'Content-Type: application/json' \
  -d '{}'
```

```bash
# Copy the current Edison flow ID to clipboard
curl -s -X POST http://127.0.0.1:47292/app/actions/dev-tools-copy-flow-id \
  -H 'Content-Type: application/json' \
  -d '{}'
```

```bash
# Toggle Edison event logging
curl -s -X POST http://127.0.0.1:47292/app/actions/dev-tools-toggle-logging \
  -H 'Content-Type: application/json' \
  -d '{"enabled":true}'
```

```bash
# Open the build step template wizard
curl -s -X POST http://127.0.0.1:47292/app/actions/open-build-step-template \
  -H 'Content-Type: application/json' \
  -d '{}'
```

```bash
# Open the configure step wizard
curl -s -X POST http://127.0.0.1:47292/app/actions/open-configure-step \
  -H 'Content-Type: application/json' \
  -d '{}'
```

```bash
# Open the flow logs results window
curl -s -X POST http://127.0.0.1:47292/app/actions/open-flow-logs \
  -H 'Content-Type: application/json' \
  -d '{"logs":[]}'
```

```bash
# Open the Edison step template library browser
curl -s -X POST http://127.0.0.1:47292/app/actions/open-library-browser \
  -H 'Content-Type: application/json' \
  -d '{}'
```

```bash
# Open the Edison SDK dashboard in settings
curl -s -X POST http://127.0.0.1:47292/app/actions/open-sdk-dashboard \
  -H 'Content-Type: application/json' \
  -d '{}'
```

```bash
# Open the flow validator results window
curl -s -X POST http://127.0.0.1:47292/app/actions/open-validator-results \
  -H 'Content-Type: application/json' \
  -d '{"results":[]}'
```

### learning

| Action ID | Required params | Optional params |
| --- | --- | --- |
| `open-ai-runtimes` | — | — |
| `open-docs-ai-insights` | — | — |
| `open-docs-readme` | — | — |
| `open-docs-spaces-api` | — | — |
| `open-learning` | `url` | `title` |
| `open-online-docs` | — | — |
| `open-tutorials` | — | — |

Example `curl` commands (placeholders; adjust paths and IDs):

```bash
# Open AI Run Times reader
curl -s -X POST http://127.0.0.1:47292/app/actions/open-ai-runtimes \
  -H 'Content-Type: application/json' \
  -d '{}'
```

```bash
# Open AI Run Times Guide documentation
curl -s -X POST http://127.0.0.1:47292/app/actions/open-docs-ai-insights \
  -H 'Content-Type: application/json' \
  -d '{}'
```

```bash
# Open local README documentation
curl -s -X POST http://127.0.0.1:47292/app/actions/open-docs-readme \
  -H 'Content-Type: application/json' \
  -d '{}'
```

```bash
# Open Spaces API documentation
curl -s -X POST http://127.0.0.1:47292/app/actions/open-docs-spaces-api \
  -H 'Content-Type: application/json' \
  -d '{}'
```

```bash
# Open a learning module by URL
curl -s -X POST http://127.0.0.1:47292/app/actions/open-learning \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com","title":"Window title"}'
```

```bash
# Open online documentation in browser
curl -s -X POST http://127.0.0.1:47292/app/actions/open-online-docs \
  -H 'Content-Type: application/json' \
  -d '{}'
```

```bash
# Open Tutorials browser
curl -s -X POST http://127.0.0.1:47292/app/actions/open-tutorials \
  -H 'Content-Type: application/json' \
  -d '{}'
```

### search

| Action ID | Required params | Optional params |
| --- | --- | --- |
| `search-spaces` | — | `query` |

Example `curl` commands (placeholders; adjust paths and IDs):

```bash
# Search in Spaces
curl -s -X POST http://127.0.0.1:47292/app/actions/search-spaces \
  -H 'Content-Type: application/json' \
  -d '{"query":"search text"}'
```

### system

| Action ID | Required params | Optional params |
| --- | --- | --- |
| `app-health` | — | — |
| `app-situation` | — | — |
| `app-version` | — | — |
| `check-for-updates` | — | — |
| `focus-main-window` | — | — |
| `relaunch-app` | — | — |
| `toggle-voice-orb` | — | — |

Example `curl` commands (placeholders; adjust paths and IDs):

```bash
# Get app health summary
curl -s -X POST http://127.0.0.1:47292/app/actions/app-health \
  -H 'Content-Type: application/json' \
  -d '{}'
```

```bash
# Situational awareness: full app state snapshot (windows, flow, orb, agents, recent activity, settings)
curl -s -X POST http://127.0.0.1:47292/app/actions/app-situation \
  -H 'Content-Type: application/json' \
  -d '{}' | python3 -m json.tool
```

```bash
# Get the current app version
curl -s -X POST http://127.0.0.1:47292/app/actions/app-version \
  -H 'Content-Type: application/json' \
  -d '{}'
```

```bash
# Check for application updates
curl -s -X POST http://127.0.0.1:47292/app/actions/check-for-updates \
  -H 'Content-Type: application/json' \
  -d '{}'
```

```bash
# Focus the main window
curl -s -X POST http://127.0.0.1:47292/app/actions/focus-main-window \
  -H 'Content-Type: application/json' \
  -d '{}'
```

```bash
# Relaunch the application
curl -s -X POST http://127.0.0.1:47292/app/actions/relaunch-app \
  -H 'Content-Type: application/json' \
  -d '{}'
```

```bash
# Toggle the Voice Orb (alias)
curl -s -X POST http://127.0.0.1:47292/app/actions/toggle-voice-orb \
  -H 'Content-Type: application/json' \
  -d '{}'
```

### tools

| Action ID | Required params | Optional params |
| --- | --- | --- |
| `open-black-hole` | — | — |
| `open-clipboard-viewer` | — | — |
| `open-module` | `moduleId` | — |
| `open-web-tool` | `url` | `name` |

Example `curl` commands (placeholders; adjust paths and IDs):

```bash
# Open Black Hole (quick paste to Spaces)
curl -s -X POST http://127.0.0.1:47292/app/actions/open-black-hole \
  -H 'Content-Type: application/json' \
  -d '{}'
```

```bash
# Open Clipboard Viewer
curl -s -X POST http://127.0.0.1:47292/app/actions/open-clipboard-viewer \
  -H 'Content-Type: application/json' \
  -d '{}'
```

```bash
# Open a module/tool by ID
curl -s -X POST http://127.0.0.1:47292/app/actions/open-module \
  -H 'Content-Type: application/json' \
  -d '{"moduleId":"installed-module-id"}'
```

```bash
# Open a web tool by URL
curl -s -X POST http://127.0.0.1:47292/app/actions/open-web-tool \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com","name":"Display name"}'
```

### share

| Action ID | Required params | Optional params |
| --- | --- | --- |
| `copy-download-link` | — | — |
| `open-github-page` | — | — |
| `share-via-email` | — | — |

Example `curl` commands (placeholders; adjust paths and IDs):

```bash
# Copy the app download link to clipboard
curl -s -X POST http://127.0.0.1:47292/app/actions/copy-download-link \
  -H 'Content-Type: application/json' \
  -d '{}'
```

```bash
# Open the GitHub repository page
curl -s -X POST http://127.0.0.1:47292/app/actions/open-github-page \
  -H 'Content-Type: application/json' \
  -d '{}'
```

```bash
# Open email client with app share link
curl -s -X POST http://127.0.0.1:47292/app/actions/share-via-email \
  -H 'Content-Type: application/json' \
  -d '{}'
```

### help

_No actions registered in `ACTION_REGISTRY` for this category._

---

## 4. IPC usage

Renderers call the main process through Electron `ipcMain.handle` channels registered in `setupActionIPC()` inside `action-executor.js`.

**Execute an action**

```javascript
const result = await window.api.invoke('action:execute', 'open-settings', { section: 'general' });
// result: { success: true/false, message?, data?, error? }
```

**List all actions (grouped by category, includes param metadata)**

```javascript
const byCategory = await window.api.invoke('action:list');
```

**Check whether an action id exists**

```javascript
const exists = await window.api.invoke('action:has', 'tab-open');
```

**Schema for one action**

```javascript
const info = await window.api.invoke('action:info', 'credentials-save');
// { type, category, description, params: string[], optionalParams: string[] }
```

`window.api.invoke` is exposed from `preload.js` (and only for channels on its allowlist). Other preloads must whitelist the same channel names if they need the action API. Arguments mirror REST: second argument is the string action id, third is the JSON-serializable params object (default `{}`).

---

## 5. REST usage

Implemented in `lib/log-server.js`. The HTTP server binds to **127.0.0.1** only (not all interfaces). Default port is **47292**; if that port is in use, the server may listen on **47293** (see log server startup logs).

All JSON responses use `Content-Type: application/json`.

### GET `/app/actions`

Returns `{ actions: { [category: string]: ActionSummary[] } }` where each summary matches `listActions()` in `action-executor.js` (`type`, `description`, `params`, `optionalParams`).

### GET `/app/actions/:id`

Returns a single action descriptor: `type`, `category`, `description`, `params`, `optionalParams`. The `:id` segment is URL-decoded and must match a registry key. **404** if unknown.

### POST `/app/actions/:id`

Body: optional JSON object; omitted or empty body is treated as `{}`. Executes `executeAction(id, params)`.

Response body is the executor result object (typically `{ success, ... }`). Status codes:

- **200** — `success: true`
- **404** — unknown action id
- **400** — validation or business failure (`success: false`, often with `error` message)
- **413** — body larger than server limit
- **500** — uncaught exception in the handler

---

## 6. Existing domain APIs

Many registry entries call `global.*` singletons or lazy-loaded modules directly. Finer-grained IPC still exists for renderer code that predates or bypasses the action layer:

| Area | Role | Examples (main process) |
| --- | --- | --- |
| **`agents:*`** | Agent store, bidding, stats, GSX connections | `agents:list`, `agents:create`, `agents:execute-direct`, `agents:test-phrase`, `agents:get-stats`, … (`main.js`) |
| **`settings:*`** | Bulk settings read/write from legacy UI | `settings:get-all`, `settings:save`, `settings:test-llm` (`main.js`). Per-key `settings-get` / `settings-set` are action IDs, not these channels. |
| **`browsing:*`** | Headless / automation browser sessions | `browsing:createSession`, `browsing:navigate`, `browsing:extract`, `browsing:research`, … (`main.js`) |
| **`module:*`** | Module manager and web tools | `module:get-installed`, `module:install-from-url`, `module:open`, `module:add-web-tool`, … (`main.js`; also whitelisted in `preload.js`) |

**Spaces REST API** (separate from the log server): **`http://127.0.0.1:47291`** — content storage CRUD (`GET/POST /api/spaces`, items under `/api/spaces/:id/items`, etc.). See internal testing docs and `docs-spaces-api` in-app help for endpoint detail.

---

## 7. Adding new actions

1. Add an entry to **`ACTION_REGISTRY`** in `action-executor.js` with:
   - `category` — one of the documented category strings.
   - `description` — short user-facing summary.
   - `params` — optional array of required parameter names (strings). `executeAction` returns `Missing required parameter: …` if any are absent or null.
   - `optionalParams` — optional array documented for callers; not enforced by `executeAction`.
   - `execute` — sync or async function `(params) => result`. Prefer returning `{ success: true, data?, message? }` or `{ success: false, error }`.

2. If the action opens a window, reuse `createStandardWindow` or existing `global.*` helpers for consistency.

3. Register nothing else for IPC or REST: new keys are picked up automatically by `listActions`, `getActionInfo`, `action:list`, and `GET /app/actions`.

4. Expose the action from the command palette, voice grammar, or menus by wiring the chosen id and default params in the relevant UI module.

5. Add or update automated tests if the action affects security, billing, or data loss.

---

## 8. Security notes

- **Network exposure:** Log server (including `/app/actions`) listens on **127.0.0.1** only, reducing exposure to local processes and users on the same machine. It is not authenticated; anything on the host that can open TCP connections to the port can invoke actions.
- **Privileged operations:** Actions can open windows, run sync, change settings, spend AI budget, save credentials, and relaunch the app. Treat localhost access as equivalent to local code execution.
- **Settings redaction:** `settings-get-all` and `settings-get` actions redact values whose keys match `/apiKey|secret|Token|password/i`. `settings-save` / `settings-set` still accept real secrets (they persist to disk through `settingsManager`).
- **Credentials:** `credentials-list` is documented in-registry to expose domain and username only; passwords are not returned. Saving credentials via `credentials-save` accepts a password in the JSON body over REST (localhost only).
- **API keys:** Never logged by the redaction above when reading settings through the action layer; direct `settings:*` IPC may return full objects — use the action API for safer read paths in automation.

When extending the registry, consider whether a new action should be restricted from REST (today everything registered is reachable via POST) or require additional auth for non-local callers.

---

## 9. Desktop Autopilot

The Desktop Autopilot unifies browser automation (browser-use), app control (action-executor), and macOS system control (AppleScript, mouse, keyboard) under a single settings-gated API.

**Master toggle:** `desktopAutopilotEnabled` (default `false`). Must be enabled in Settings > Automation before any autopilot action will execute.

### Action Registry (via `/app/actions/:id`)

| Action ID | Required params | Optional params |
| --- | --- | --- |
| `desktop-status` | --- | --- |
| `desktop-browse-task` | `task` | `useVision`, `maxSteps`, `profile` |
| `desktop-browse` | `action` | `url`, `script`, `selector`, `fullPage` |
| `desktop-applescript` | `script` | --- |
| `desktop-mouse` | `action` | `x`, `y`, `button` |
| `desktop-keyboard` | `action` | `text`, `key`, `shift`, `control`, `alt`, `meta` |

### Dedicated REST Endpoints

In addition to the `/app/actions/:id` surface, the Desktop Autopilot has dedicated REST endpoints:

```bash
# Get autopilot status and capabilities
curl -s http://127.0.0.1:47292/app/desktop/status | python3 -m json.tool

# Run a natural-language browser task (browser-use handles the full loop)
curl -s -X POST http://127.0.0.1:47292/app/desktop/browser/task \
  -H 'Content-Type: application/json' \
  -d '{"task":"Go to example.com and extract all headings"}'

# Navigate to a URL
curl -s -X POST http://127.0.0.1:47292/app/desktop/browser/navigate \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com"}'

# Take a screenshot
curl -s -X POST http://127.0.0.1:47292/app/desktop/browser/screenshot \
  -H 'Content-Type: application/json' \
  -d '{}'

# Get browser state (URL, title, tabs)
curl -s -X POST http://127.0.0.1:47292/app/desktop/browser/state \
  -H 'Content-Type: application/json' \
  -d '{}'

# Extract text content from the page
curl -s -X POST http://127.0.0.1:47292/app/desktop/browser/extract \
  -H 'Content-Type: application/json' \
  -d '{"selector":"h1"}'

# Evaluate JavaScript on the page
curl -s -X POST http://127.0.0.1:47292/app/desktop/browser/evaluate \
  -H 'Content-Type: application/json' \
  -d '{"script":"document.title"}'

# Close the browser session
curl -s -X POST http://127.0.0.1:47292/app/desktop/browser/close \
  -H 'Content-Type: application/json' \
  -d '{}'

# Run AppleScript (requires System Control enabled)
curl -s -X POST http://127.0.0.1:47292/app/desktop/system/applescript \
  -H 'Content-Type: application/json' \
  -d '{"script":"tell application \"Finder\" to get name of every disk"}'

# Move the mouse
curl -s -X POST http://127.0.0.1:47292/app/desktop/system/mouse-move \
  -H 'Content-Type: application/json' \
  -d '{"x":500,"y":300}'

# Click the mouse
curl -s -X POST http://127.0.0.1:47292/app/desktop/system/mouse-click \
  -H 'Content-Type: application/json' \
  -d '{"button":"left"}'

# Type text
curl -s -X POST http://127.0.0.1:47292/app/desktop/system/key-type \
  -H 'Content-Type: application/json' \
  -d '{"text":"Hello, world!"}'

# Press a key combo
curl -s -X POST http://127.0.0.1:47292/app/desktop/system/key-press \
  -H 'Content-Type: application/json' \
  -d '{"key":"c","modifiers":{"meta":true}}'

# Execute an app action through the autopilot gate
curl -s -X POST http://127.0.0.1:47292/app/desktop/app/open-settings \
  -H 'Content-Type: application/json' \
  -d '{"section":"general"}'
```

### Agent Tool Registry

Six tools are registered in `lib/agent-tools.js` for agents that declare `tools: [...]`:

| Tool | Description |
| --- | --- |
| `desktop_browse` | Browser automation (run_task, navigate, screenshot, extract, evaluate) |
| `desktop_app_action` | Execute any of the 143+ app actions by ID |
| `desktop_app_situation` | Full app state snapshot |
| `desktop_applescript` | macOS AppleScript execution |
| `desktop_mouse` | Mouse move/click/scroll/position |
| `desktop_keyboard` | Type text or press key combos |

### Settings

| Key | Default | Description |
| --- | --- | --- |
| `desktopAutopilotEnabled` | `false` | Master toggle |
| `desktopAutopilotBrowser` | `true` | Browser automation sub-toggle |
| `desktopAutopilotAppControl` | `true` | App control sub-toggle |
| `desktopAutopilotSystem` | `false` | System control (AppleScript/mouse/keyboard) |

### Security

- **Off by default.** Users must explicitly enable in Settings > Automation.
- **Double gate for system control.** Even with autopilot enabled, AppleScript/mouse/keyboard require the System Control sub-toggle.
- **Localhost only.** REST API is bound to 127.0.0.1.
- **AppleScript safety filter.** Blocks `do shell script` calls containing destructive patterns (`rm -rf`, `sudo`, `mkfs`, `dd if=`).
- **browser-use security.** Domain restrictions, sensitive data masking, Chromium sandbox.
- **Cost tracking.** All LLM calls route through `ai-service.js` with `feature: 'desktop-autopilot'`.

