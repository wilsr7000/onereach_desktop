# 21 -- GSX Create

## Overview

AI-powered code and content generation tool with multi-branch workspaces, Meta Learning Cycle, constitutional memory, task queue, episodic memory, budget tracking, branch comparison, and error analysis.

**Key files:** `aider-ui.html`, `aider-bridge-client.js`, `app-manager-agent.js`, `preload.js`

## Prerequisites

- App running with at least one AI API key configured
- At least one Space created (GSX Create uses Spaces for projects)
- Sufficient AI budget remaining

## Features

### Session Management
- Space selector to choose a project workspace
- Create new space for new projects
- Main file selector for primary project file
- Journey map and style guide selectors from Space metadata
- "Start Session" initializes the AI coding session

### Multi-Branch Tabbed Workspace
- Overview tab with global controls
- Per-branch tabs with independent workspaces
- Branch tabs show: status indicator, version badge, close button
- Hover tooltip shows phase progress and budget per branch
- Create new branch from overview
- Switch between branches

### Meta Learning Cycle
- 7-phase pipeline: Evaluate, Research, Plan, Execute, Test, Improve, Finalize
- Phase dots are clickable (manual phase navigation)
- Auto-cycle toggle for autonomous progression
- Version timeline per phase
- Progress bar per phase

### Constitutional Memory
- Style guide selector (loads from Space)
- Journey map selector (loads from Space)
- Evaluation criteria selector (loads from Space)
- Memory persists across session phases

### Reference Memory
- File upload via drag-and-drop or upload button
- Context file management (add/remove files)
- File count badge

### Task Queue
- Quick-add input for new tasks
- Task list with progress tracking
- Progress bar with completion stats
- Time estimates for remaining work
- Task status tracking (pending, in-progress, done)

### Episodic Memory
- History tab: what was done (chronological log)
- Plan tab: todo list for upcoming work
- Todo input for manual plan items

### Chat Interface
- User/assistant message bubbles
- Instructions and Config toolbar buttons
- Streaming AI responses
- Welcome message with suggestion chips

### Budget Management
- Cost display with progress bar in header
- Per-branch cost tracking
- Budget warnings: green (OK), yellow (warning), red (over budget)
- Debug mode toggle for verbose AI logging

### Branch Comparison
- Side-by-side diff viewer from Overview tab
- Files changed count, insertions, deletions
- Visual diff display

### Error Analyzer
- AI-driven error analysis modal
- Stack trace display
- Error location identification
- AI suggestions for fixes
- Auto-fix button
- Save/dismiss options

### Connection Status
- Status dot in header (connected/disconnected)
- Real-time connection monitoring

---

## Checklist

### Window Lifecycle
- [ ] [A] GSX Create window opens via menu (Cmd+Shift+A) or IPC
- [ ] [A] Window loads without console errors
- [ ] [A] Window closes cleanly

### Session Setup
- [ ] [P] Space selector populates from Spaces API
- [ ] [M] Create new space from setup panel
- [ ] [M] Select main file from space
- [ ] [P] Journey map and style guide selectors populate
- [ ] [P] "Start Session" initializes and transitions to workspace

### Tab Management
- [ ] [M] Overview tab displays on session start
- [ ] [M] Create new branch creates a new tab
- [ ] [M] Switch between branch tabs preserves state
- [ ] [M] Close branch tab removes it
- [ ] [M] Tab hover shows phase progress and budget tooltip

### Meta Learning Cycle
- [ ] [M] 7 phase dots render in pipeline
- [ ] [M] Clicking a phase dot navigates to that phase
- [ ] [P] Auto-cycle toggle enables autonomous phase progression
- [ ] [P] Phase transitions update version timeline
- [ ] [P] Progress bar reflects current phase completion

### Constitutional Memory
- [ ] [P] Style guide loads content from selected Space item
- [ ] [P] Journey map loads content from selected Space item
- [ ] [P] Evaluation criteria loads content from selected Space item
- [ ] [P] Memory content persists across phase transitions

### Reference Memory
- [ ] [M] Drag-and-drop file onto reference area adds it
- [ ] [M] Upload button opens file picker
- [ ] [M] File count badge updates
- [ ] [M] Remove file button removes from context

### Task Queue
- [ ] [M] Quick-add input creates a new task
- [ ] [P] Task list shows all pending tasks
- [ ] [P] Progress bar updates as tasks complete
- [ ] [P] Time estimates display and update
- [ ] [P] Completion stats (done/left) are accurate

### Episodic Memory
- [ ] [P] History tab logs completed actions chronologically
- [ ] [M] Plan tab shows todo items
- [ ] [M] Todo input adds new plan items

### Chat Interface
- [ ] [M] Type a message and send via button or Enter
- [ ] [P] AI responds with streaming text
- [ ] [M] Welcome message shows suggestion chips
- [ ] [M] Clicking a suggestion chip sends it as a message
- [ ] [M] Instructions button opens instructions panel
- [ ] [M] Config button opens config panel

### Budget Management
- [ ] [P] Cost display in header shows current session cost
- [ ] [P] Progress bar reflects cost vs budget ratio
- [ ] [P] Per-branch cost is tracked independently
- [ ] [P] Warning colors change at thresholds (green/yellow/red)
- [ ] [M] Debug mode toggle enables verbose logging

### Branch Comparison
- [ ] [M] Open compare view from Overview tab
- [ ] [P] Diff viewer shows files changed, insertions, deletions
- [ ] [P] Side-by-side diff renders correctly

### Error Analyzer
- [ ] [P] Error analyzer modal opens when an error occurs
- [ ] [P] Stack trace and error location are displayed
- [ ] [P] AI analysis provides suggestions
- [ ] [M] "Auto-fix" button applies the suggested fix
- [ ] [M] "Dismiss" closes the modal

### IPC Integration
- [ ] [A] `window.aider.getSpaces()` returns space list
- [ ] [A] `window.aider.getSpaceItems(spaceId)` returns items
- [ ] [A] `window.aider.runPrompt(prompt)` returns AI response
- [ ] [A] `window.aider.addFiles(files)` succeeds
- [ ] [A] `window.aider.removeFiles(files)` succeeds
- [ ] [A] `window.aider.gitCreateBranch(name)` creates a branch
- [ ] [A] `window.aider.gitListBranches()` lists branches
- [ ] [A] `window.aider.gitDiffBranches(a, b)` returns diff

---

## Automation Notes

- Window lifecycle testable via existing smoke test pattern
- IPC methods testable via `electronApp.evaluate()` calling IPC handles
- Chat streaming requires waiting for async generator completion
- Budget tracking verifiable by checking DOM elements after AI calls
- Branch operations are git-based and testable via IPC
- Meta Learning Cycle automation would need to mock AI responses for speed
- Error analyzer needs a deliberately triggered error to test
