# App Agent Guide

> Your personal guide to the GSX Power User app. Ask questions, get tours, run playbooks, and control the app with your voice.

## Overview

The **App Agent** is a voice-activated assistant that knows everything about the GSX Power User app. It can:

- Answer questions about any feature
- Give guided tours of products
- Run step-by-step playbooks
- **Actually open windows and control the app**
- Search your Spaces
- Track which features you've explored

## Voice Commands

### Opening Features

Say these to immediately open windows:

| Command | What happens |
|---------|--------------|
| "Open Spaces" | Opens the Spaces/Clipboard viewer |
| "Open the video editor" | Opens Video Editor |
| "Open GSX Create" | Opens the AI coding assistant |
| "Open settings" | Opens Settings window |
| "Open budget dashboard" | Opens Budget Manager |
| "Open app health" | Opens App Health Dashboard |
| "Show me the clipboard" | Opens Clipboard Manager |

### Searching

| Command | What happens |
|---------|--------------|
| "Search for photos" | Opens Spaces and searches for "photos" |
| "Search Spaces for meeting notes" | Searches your content |
| "Find my project files" | Opens search |

### Getting Help

| Command | What happens |
|---------|--------------|
| "What can this app do?" | Overview of all features |
| "Tell me about Spaces" | Explains Spaces features |
| "How do I use the video editor?" | Explains Video Editor |
| "What can I do with GSX Create?" | Lists actions available |

### Tours & Playbooks

| Command | What happens |
|---------|--------------|
| "Give me a tour of Spaces" | 4-step guided tour |
| "Walk me through the video editor" | Step-by-step tour |
| "List playbooks" | Shows all available playbooks |
| "Run first time setup" | Starts the setup playbook |
| "Help me track my spending" | Budget tracking playbook |

## Products Covered

The App Agent knows about all these products:

| Product | Key Features |
|---------|--------------|
| **GSX Create** | AI coding, task queue, budget tracking |
| **Video Editor** | Timeline editing, AI voices, transcription |
| **Spaces** | Content organization, search, sync |
| **Clipboard Manager** | History, source detection, quick paste |
| **Smart Export** | Format conversion, style guides, templates |
| **IDW Hub** | Digital worker management, GSX links |
| **AI Agents** | ChatGPT, Claude, Gemini, image/video AI |
| **Budget Manager** | Cost tracking, limits, reports |
| **App Health** | Performance, logs, troubleshooting |
| **Voice Assistant** | Voice control, custom agents |
| **Settings** | Preferences, API keys, shortcuts |

## Available Playbooks

Step-by-step guides you can run by voice:

### 1. First Time Setup
**Command:** "Run first time setup" or "Help me get started"

Steps through: API keys, creating spaces, clipboard basics, AI agents, voice commands.

### 2. Edit Video with AI Voice
**Command:** "Help me replace video audio" or "AI voice playbook"

Steps through: Loading video, transcription, setting range, applying AI voice, export.

### 3. Organize with Spaces
**Command:** "Help me organize my content"

Steps through: Planning structure, creating spaces, adding content, browser extension, search, sync.

### 4. Build with GSX Create
**Command:** "Help me build an app" or "Coding playbook"

Steps through: Opening GSX Create, describing tasks, workflow, review, iteration, budget, export.

### 5. Create Custom Agent
**Command:** "Help me create an agent"

Steps through: Naming, keywords, prompt, voice selection, testing, saving.

### 6. Save AI Conversations
**Command:** "How do I save my ChatGPT conversations?"

Explains: Auto-save, finding conversations, browsing, searching, organizing, exporting.

### 7. Track AI Spending
**Command:** "Help me track my AI costs"

Steps through: Budget dashboard, viewing spending, by model, setting limits, alerts, optimization.

### 8. Troubleshoot Issues
**Command:** "Help me fix a problem"

Steps through: Health check, viewing errors, restart, connectivity, API keys, logs, getting help.

### 9. Keyboard Shortcuts
**Command:** "Teach me the shortcuts"

Covers: Essential shortcuts, navigation, GSX Create, Video Editor, search, quick launcher.

### 10. Export Content
**Command:** "Help me export my content"

Steps through: Selection, Smart Export, format choice, style guide, templates, preview, export.

## Actions Per Product

Each product has specific actions you can ask about:

### GSX Create (7 actions)
- Start a new coding task
- View task queue
- Check budget
- Pause/Resume work
- View activity log
- Cancel a task
- Export work

### Video Editor (9 actions)
- Load a video
- Download from YouTube
- Create a marker
- Set in/out points
- Replace audio with AI voice
- Get transcription
- Detect scenes
- Export video
- Adjust playback speed

### Spaces (10 actions)
- Create a new space
- Add content
- Search everything
- Move items
- Bulk select
- Delete items
- Sync to cloud
- Upload to AI
- Export content
- View item details

### Clipboard Manager (7 actions)
- Open clipboard history
- Paste an old item
- Save to Space
- Search history
- Clear history
- Pin an item
- View source

### And more for each product...

## Memory & Learning

The App Agent remembers:
- **Features Explored** - Which products you've asked about
- **Tours Completed** - Playbooks and tours you've finished
- **Preferences** - Detail level, tips preference

This helps it give you relevant suggestions and avoid repeating information.

## Technical Details

- **Agent ID:** `app-agent`
- **Voice:** `nova` (warm, helpful guide)
- **Categories:** system, app, help, tutorial
- **Location:** `packages/agents/app-agent.js`

### IPC Actions

The agent can execute these app actions:

```javascript
// Window operations
{ type: 'open-spaces' }
{ type: 'open-video-editor' }
{ type: 'open-gsx-create' }
{ type: 'open-settings' }
{ type: 'open-budget' }
{ type: 'open-app-health' }
{ type: 'open-agent-manager' }
{ type: 'open-log-viewer' }

// Search
{ type: 'search-spaces', query: 'search term' }

// AI services
{ type: 'open-chatgpt' }
{ type: 'open-claude' }
{ type: 'open-gemini' }
```

## Extending the Agent

### Adding a New Product

1. Add to `APP_PRODUCTS` in `app-agent.js`:
```javascript
'my-product': {
  name: 'My Product',
  description: 'What it does',
  access: 'How to open it',
  features: ['Feature 1', 'Feature 2'],
  actions: [
    { name: 'Do something', command: 'How to do it' }
  ],
  tips: ['Helpful tip'],
  keywords: ['search', 'keywords']
}
```

2. Add to `_productActions` if it can be opened directly:
```javascript
'my-product': { type: 'open-my-product' }
```

3. Add the IPC handler in `main.js` `setupAppActionsIPC()`.

### Adding a New Playbook

Add to `PLAYBOOKS` in `app-agent.js`:
```javascript
'my-playbook': {
  name: 'My Playbook Name',
  description: 'What this teaches',
  keywords: ['trigger', 'words'],
  steps: [
    { title: 'Step 1', instruction: 'What to do' },
    { title: 'Step 2', instruction: 'Next step' },
    // ... more steps
  ]
}
```

## Related Files

- `packages/agents/app-agent.js` - Main agent code
- `packages/agents/agent-registry.js` - Agent registration
- `main.js` - `setupAppActionsIPC()` for window control
- `src/voice-task-sdk/exchange-bridge.js` - Action execution
- `packages/agents/VOICE-GUIDE.md` - Voice configuration guide

---

*The App Agent is always learning. Ask it anything about the app!*
