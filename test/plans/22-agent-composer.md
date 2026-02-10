# 22 -- Agent Composer

## Overview

Chat-based interface for creating AI agents through conversation. Features agent type selection, live agent preview, version history, auto-testing with diagnose/fix cycles, plan display with confidence scoring, and iterative code generation.

**Key files:** `claude-code-ui.html`, `preload.js`

## Prerequisites

- App running with Claude API key configured
- Agent Manager accessible (for saving created agents)

## Features

### Chat Interface
- User/assistant message bubbles with avatars
- Welcome message with clickable suggestion chips (pre-built prompts)
- Typing indicator during AI response
- Rounded text input with circular send button
- Iterative refinement through multi-turn conversation

### Agent Type Selection
- Chip-style buttons for agent template types
- Auto-match: system highlights the best-matching type from user input (green pulse indicator)
- Manual type override by clicking chips

### Live Agent Preview (Right Panel)
- Agent card: name, type badge, system prompt preview
- Keywords list
- Capabilities list
- Status badge ("has-draft" when agent is being built)
- Real-time updates as AI generates/refines the agent

### Plan Display
- AI-generated plan card with confidence score badge
- Plan sections: type badge, numbered steps list, features checklist
- Plan updates as conversation progresses

### Version History
- Version badge showing current version number
- History button opens version history modal
- Undo button reverts to previous version
- Modal lists all versions with revert buttons

### Agent Testing
- Test input field + test button
- Response display with loading/success/error states
- **Auto-test mode:**
  - Toggle to enable autonomous testing
  - Progress bar during auto-test cycle
  - Log entries: attempt, diagnosing, fixing, success, error
  - Diagnose/fix cycle when test fails
  - Verification badge: verified, failed, pending

### Save & Actions
- Primary save button in preview actions footer
- Secondary action buttons

---

## Checklist

### Window Lifecycle
- [ ] [A] Agent Composer opens via menu (Cmd+Shift+G) or IPC
- [ ] [A] Window loads without console errors
- [ ] [A] Window has custom titlebar with close button
- [ ] [A] Window closes cleanly

### Chat Interface
- [ ] [M] Welcome message displays with suggestion chips
- [ ] [M] Clicking a suggestion chip sends it as input
- [ ] [M] Typing a message and pressing Enter/Send sends it
- [ ] [M] AI response streams in with typing indicator
- [ ] [M] Multiple turns of conversation work correctly

### Agent Type Selection
- [ ] [M] Agent type chips render and are clickable
- [ ] [P] Auto-match highlights the best type from user input
- [ ] [M] Manually selecting a type updates the selection
- [ ] [P] Green pulse animation appears on auto-matched type

### Live Preview
- [ ] [P] Preview panel updates as AI generates agent
- [ ] [P] Agent name appears in preview header
- [ ] [P] Type badge reflects selected/auto-detected type
- [ ] [P] System prompt preview shows generated prompt
- [ ] [P] Keywords list populates from AI generation
- [ ] [P] Capabilities list populates from AI generation
- [ ] [M] Status badge shows "has-draft" during creation

### Plan Display
- [ ] [P] Plan card appears after AI generates a plan
- [ ] [P] Confidence score badge shows percentage
- [ ] [P] Steps list shows numbered implementation steps
- [ ] [P] Features checklist shows planned capabilities

### Version History
- [ ] [P] Version badge shows current version number
- [ ] [M] History button opens version history modal
- [ ] [M] Modal lists previous versions
- [ ] [M] Undo button reverts to previous version
- [ ] [M] Revert button in modal restores a specific version

### Agent Testing
- [ ] [M] Test input accepts a test query
- [ ] [P] Test button sends query and displays response
- [ ] [P] Loading state shows during test execution
- [ ] [P] Success state shows for passing tests
- [ ] [P] Error state shows for failing tests

### Auto-Test Mode
- [ ] [M] Auto-test toggle enables the mode
- [ ] [P] Progress bar shows during auto-test cycle
- [ ] [P] Log entries document each attempt
- [ ] [P] Failed test triggers diagnose phase
- [ ] [P] Diagnose phase triggers fix phase
- [ ] [P] Fix phase re-runs the test
- [ ] [P] Verification badge shows final status (verified/failed/pending)

### Save Agent
- [ ] [M] Save button persists the agent to Agent Manager
- [ ] [A] Saved agent appears in Agent Manager window
- [ ] [A] Saved agent has correct name, type, system prompt, keywords, capabilities

---

## Automation Notes

- Window lifecycle testable via smoke test pattern
- Chat interaction requires mocking AI responses for speed and cost
- Agent preview updates can be verified via DOM element content checks
- Auto-test mode is the most complex to automate: needs a deterministic agent + test case
- Version history testable by creating multiple versions and checking modal content
- Save verification requires cross-window check (Agent Composer -> Agent Manager)
