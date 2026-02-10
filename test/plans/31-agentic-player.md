# 31 -- Agentic Player

## Overview

AI-driven video player that uses a prompt-based API to dynamically select and queue video scenes based on user goals. Features session management, AI reasoning display, scene markers, and pre-fetching strategy.

**Key files:** `agentic-player/index.html`, `agentic-player/styles.css`, `agentic-player/player.js`, `agentic-player/server.js`

## Prerequisites

- Agentic Player server running (`agentic-player/server.js`)
- Video content available for scene selection
- AI API key configured (for scene selection logic)

## Features

### Session Management
- Session goal input: textarea for prompt-based instructions (e.g., "Give me a 3-minute product overview")
- Time limit selector: no limit, 1, 2, 5, 10 minutes
- AI reasoning toggle: show/hide AI decision logs
- Start session button
- End session button
- Session status indicator in header

### Video Playback
- Video container with scene markers on progress bar
- Play/pause controls
- Time display (current / total)
- Scene counter (current scene / total scenes)
- Skip clip button
- Mute control
- Scene info badge overlay on video

### AI Scene Selection
- POST prompt + context to API, receive scene batches
- AI thinking overlay (spinner while selecting next scene)
- Automatic scene queuing based on AI decisions
- Session ends when API returns `done: true`

### Scene Queue
- Live count of queued scenes
- Scene queue list display
- Pre-fetching strategy: configurable clips remaining + threshold
- "Now Playing" card: scene name, time range, description

### AI Reasoning Panel
- Shows AI decision logs
- Why each scene was selected
- Context provided to the AI
- Toggleable via checkbox

---

## Checklist

### Window Lifecycle
- [ ] [A] Agentic Player loads at `agentic-player/index.html`
- [ ] [A] Page loads without console errors
- [ ] [A] Player.js initializes correctly

### Session Setup
- [ ] [M] Goal textarea accepts prompt input
- [ ] [M] Time limit selector offers all options (none, 1m, 2m, 5m, 10m)
- [ ] [M] AI reasoning checkbox toggles
- [ ] [M] Start button is clickable

### Session Start
- [ ] [P] Starting a session sends goal to API
- [ ] [P] First scene batch is received and queued
- [ ] [P] Video begins playing first scene
- [ ] [P] Session status updates to active

### Video Playback
- [ ] [M] Video plays in the container
- [ ] [M] Play/pause toggles playback
- [ ] [M] Time display updates during playback
- [ ] [M] Scene counter shows current/total
- [ ] [M] Skip clip advances to next scene
- [ ] [M] Mute toggles audio

### Scene Markers
- [ ] [P] Progress bar shows markers at scene boundaries
- [ ] [M] Scene info badge shows current scene details

### AI Thinking
- [ ] [P] AI thinking overlay appears between scenes
- [ ] [P] Spinner displays during scene selection
- [ ] [P] Overlay disappears when next scene is ready

### Scene Queue
- [ ] [P] Queue count badge shows queued scene count
- [ ] [P] Scene queue list displays queued scenes
- [ ] [P] Pre-fetching triggers before current scene ends
- [ ] [P] "Now Playing" card shows scene name, time range, description

### AI Reasoning
- [ ] [M] Toggle reasoning panel on
- [ ] [P] Decision logs display for each scene selection
- [ ] [P] Context and reasoning text are visible
- [ ] [M] Toggle reasoning panel off hides it

### Session End
- [ ] [P] Session ends when API returns `done: true`
- [ ] [M] "End Session" button stops playback and clears queue
- [ ] [P] Session status updates to ended

### Time Limit
- [ ] [P] Session with time limit stops at the specified duration
- [ ] [P] No-limit session continues until all scenes played or manually ended

---

## Automation Notes

- Player is a standalone HTML page, testable with Playwright directly
- API communication can be mocked for deterministic scene sequences
- Video playback verification requires checking video element state
- Scene queue and markers testable via DOM inspection
- AI reasoning panel content testable via DOM text checks
- Session lifecycle (start -> play scenes -> end) is a natural E2E flow
- Pre-fetching behavior needs timing-sensitive assertions
