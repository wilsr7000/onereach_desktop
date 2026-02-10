# Agent Manager Test Plan

## Prerequisites

- App running (`npm start`)
- Agent Manager accessible via `global.createAgentManagerWindow()`
- At least one builtin agent available

## Features Documentation

The Agent Manager (`agent-manager.html`) provides a UI for creating, editing, testing, and deleting agents. Each agent has a name, description, system prompt, and configuration. The system supports version history with undo/revert, agent testing (single agent bid evaluation, all-agents test, direct execution), statistics tracking, and builtin agent enable/disable toggles. Agents communicate via the Task Exchange auction system.

**Key files:** `agent-manager.html`, `packages/agents/agent-registry.js`, `packages/agents/agent-store.js`
**IPC namespace:** `agents:*`, `gsx:*` (for GSX connections)
**Window:** Opened via `global.createAgentManagerWindow()`

## Checklist

### Window Lifecycle
- [ ] `[A]` Agent Manager window opens without errors
- [ ] `[A]` Window renders agent list (may be empty for new install)

### Agent CRUD
- [ ] `[A]` `agents:create({ name, description, systemPrompt })` creates agent, returns ID
- [ ] `[A]` `agents:list()` includes newly created agent
- [ ] `[A]` `agents:update(id, { description: 'updated' })` modifies agent
- [ ] `[A]` `agents:delete(id)` removes agent from list
- [ ] `[A]` After delete, `agents:list()` no longer includes the agent

### Version History
- [ ] `[A]` After update, `agents:get-versions(id)` returns version entries
- [ ] `[A]` `agents:undo(id)` reverts to previous version
- [ ] `[A]` `agents:revert(id, versionNumber)` restores specific version
- [ ] `[P]` `agents:compare-versions(id, v1, v2)` returns meaningful diff

### Agent Testing
- [ ] `[P]` `agents:test-phrase(id, "what is the weather")` returns bid score
- [ ] `[P]` `agents:test-phrase-all("what is the weather")` returns bids from multiple agents
- [ ] `[M]` Direct execution: `agents:execute-direct(id, phrase)` returns agent result

### Builtin Agents
- [ ] `[A]` `agents:get-builtin-states()` returns map of builtin agent enabled states
- [ ] `[A]` `agents:set-builtin-enabled(agentId, false)` disables agent
- [ ] `[A]` Disabled agent does not appear in bid results for `test-phrase-all`

## Automation Notes

- **Existing coverage:** `test/e2e/window-smoke.spec.js` (1 test: window opens without errors)
- **Gaps:** CRUD, version history, testing, builtin toggles
- **Spec file:** Create `test/e2e/agent-manager.spec.js`
- **Strategy:** IPC-level tests via `electronApp.evaluate` for all CRUD and version operations
