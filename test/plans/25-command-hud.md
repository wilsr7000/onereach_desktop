# 25 -- Command HUD

## Overview

Spotlight-style overlay for displaying voice command status, agent task lifecycle, disambiguation options, subtask tracking, and text input mode. Acts as the primary visual feedback surface for the voice agent system.

**Key files:** `command-hud.html`, `preload-command-hud.js`, `preload-hud-api.js`, `lib/hud-api.js`

## Prerequisites

- App running with voice orb enabled
- At least one agent registered (for task routing)
- Task Exchange running (for lifecycle events)

## Features

### Voice Command Display
- Shows recognized voice command text
- Action name and transcript
- Parameters displayed as key-value pill tags
- Status badge: pending (yellow), running (blue), completed (green), failed (red)

### Task Lifecycle Tracking
- Real-time status updates from Task Exchange
- Events: queued, started, completed, failed, retry, cancelled, deadletter
- Progress events with percentage
- Lock state indicator with countdown timer
- Task decomposition banner (complex request split into subtasks)
- Error routing banner (failed task sent to error agent)
- Queue indicator showing pending task count

### Agent Info Section
- Which agent handled the task
- Confidence score with color coding (high/medium/low)
- Agent reasoning text
- Collapsible bids summary showing all competing agents

### Subtask Tracking
- Displays child subtasks with individual status
- Progress counter (completed/total)
- Per-subtask status badges

### Result Display
- Success result: green border, message text
- Error result: red border, error message
- Auto-hide: success after 8s, errors after 15s

### Disambiguation Mode
- Triggered when voice command is ambiguous
- Numbered option cards with label and action description
- Click or say a number to select
- Listening indicator (pulsing dot) for voice response
- Escape to cancel
- Voice response resolution

### Text Input Mode
- Toggle via context menu
- Text input field + Send + Close buttons
- Submit command as text instead of voice

### Controls
- Dismiss button to hide current display
- Retry button (danger style) to re-execute failed task
- Backdrop blur effect
- Show/hide animations

---

## Checklist

### Window Lifecycle
- [ ] [A] Command HUD opens via `createCommandHUDWindow()` IPC
- [ ] [A] Window loads without console errors
- [ ] [A] Window is transparent and always-on-top
- [ ] [A] Window closes cleanly

### Show / Hide
- [ ] [A] `hudAPI.onShow()` event makes HUD visible
- [ ] [A] `hudAPI.onHide()` event hides HUD
- [ ] [A] `hudAPI.onReset()` clears all displayed content

### Voice Command Display
- [ ] [P] Recognized command text displays correctly
- [ ] [P] Action name and transcript show
- [ ] [P] Parameters render as pill tags
- [ ] [P] Status badge color matches state (pending/running/completed/failed)

### Task Lifecycle
- [ ] [A] `hudAPI.onTaskLifecycle()` receives lifecycle events
- [ ] [P] "queued" event shows pending state
- [ ] [P] "started" event transitions to running state with progress bar
- [ ] [P] "completed" event shows success result
- [ ] [P] "failed" event shows error result
- [ ] [P] "retry" event resets and re-shows running state
- [ ] [P] Lock state shows countdown timer
- [ ] [P] Decomposition banner appears for complex tasks
- [ ] [P] Error routing banner appears for error-routed tasks

### Agent Info
- [ ] [P] Agent name displays
- [ ] [P] Confidence score shows with correct color coding
- [ ] [P] Reasoning text is visible
- [ ] [M] Expanding bids summary shows all competing agents

### Subtask Tracking
- [ ] [P] Subtask list appears for decomposed tasks
- [ ] [P] Progress counter updates (completed/total)
- [ ] [P] Individual subtask status badges update

### Result Display
- [ ] [P] Success result has green border and message
- [ ] [P] Error result has red border and message
- [ ] [A] Success auto-hides after ~8 seconds
- [ ] [A] Error auto-hides after ~15 seconds

### Disambiguation
- [ ] [P] Disambiguation options appear as numbered cards
- [ ] [M] Clicking an option selects it
- [ ] [A] `hudAPI.selectDisambiguationOption(id, index)` sends selection
- [ ] [A] `hudAPI.cancelDisambiguation(id)` cancels
- [ ] [M] Escape key cancels disambiguation
- [ ] [P] Listening indicator appears for voice response
- [ ] [A] `hudAPI.resolveDisambiguationWithVoice(id, response)` resolves

### Text Input Mode
- [ ] [A] `hudAPI.onShowTextInput()` shows input field
- [ ] [M] Typing and pressing Send submits command
- [ ] [A] `hudAPI.submitTextCommand(command)` sends the command
- [ ] [M] Close button hides input field

### Controls
- [ ] [M] Dismiss button hides current display
- [ ] [A] `hudAPI.dismiss()` programmatically dismisses
- [ ] [M] Retry button re-executes the task
- [ ] [A] `hudAPI.retry(task)` programmatically retries

### Queue Indicator
- [ ] [A] `hudAPI.getQueueStats(queueName)` returns queue size
- [ ] [P] Queue count badge updates when tasks are queued

---

## Automation Notes

- HUD is an overlay window; testable by sending IPC events and checking DOM state
- Task lifecycle events can be simulated via `hudAPI.onTaskLifecycle()` with mock data
- Disambiguation can be tested by triggering `hudAPI.onDisambiguation()` with options
- Auto-hide timing can be verified with `setTimeout` + DOM visibility checks
- Text input mode is automatable via Playwright page interactions
- Agent bids summary requires a real multi-agent bid scenario or mock data
- Context menu testing requires `hudAPI.showContextMenu()`
