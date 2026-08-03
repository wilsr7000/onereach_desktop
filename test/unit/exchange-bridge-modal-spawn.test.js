/**
 * exchange-bridge -- modal spawn on displayMode === 'modal'
 *
 * Source-level invariant test pinning that task:settled calls
 * showAgentUIModal when the normalized result has displayMode === 'modal'
 * AND has html. Catches a refactor that drops the modal spawn while
 * keeping the chat broadcast (which would mean rich UIs would silently
 * appear only as a "Panel shown in window" link in chat with no actual
 * window).
 */

import { describe, it, expect } from 'vitest';
const fs = require('fs');
const path = require('path');

const BRIDGE_SOURCE = fs.readFileSync(
  path.join(__dirname, '../../src/voice-task-sdk/exchange-bridge.js'),
  'utf8'
);

function extractTaskSettledSuccessBlock() {
  const start = BRIDGE_SOURCE.indexOf("exchangeInstance.on('task:settled'");
  expect(start).toBeGreaterThan(-1);
  const sentinel = BRIDGE_SOURCE.indexOf("exchangeInstance.on('task:executing'", start);
  expect(sentinel).toBeGreaterThan(start);
  return BRIDGE_SOURCE.slice(start, sentinel);
}

describe('exchange-bridge task:settled -- modal spawn (Phase 2)', () => {
  const block = extractTaskSettledSuccessBlock();

  it('requires the modal manager (lib/agent-ui-modal-manager)', () => {
    expect(block).toMatch(/require\(['"]\.\.\/\.\.\/lib\/agent-ui-modal-manager['"]\)/);
  });

  it('only spawns a modal when displayMode === modal AND html is present', () => {
    expect(block).toMatch(/normalized\.displayMode\s*===\s*['"]modal['"]\s*&&\s*normalized\.html/);
  });

  it('passes agentId, agentName, html, and panel sizing to showAgentUIModal', () => {
    const callMatch = block.match(/showAgentUIModal\(\{[\s\S]{0,500}\}\)/);
    expect(callMatch, 'showAgentUIModal call must exist').toBeTruthy();
    const callPayload = callMatch[0];
    expect(callPayload).toMatch(/agentId/);
    expect(callPayload).toMatch(/agentName:\s*replyAgentName/);
    expect(callPayload).toMatch(/html:\s*normalized\.html/);
    expect(callPayload).toMatch(/panelWidth:\s*normalized\.panelWidth/);
    expect(callPayload).toMatch(/panelHeight:\s*normalized\.panelHeight/);
  });

  it('wraps the spawn in try/catch (modal spawn failure must NOT block the task pipeline)', () => {
    const spawnIdx = block.indexOf('showAgentUIModal');
    const before = block.slice(Math.max(0, spawnIdx - 200), spawnIdx);
    const after = block.slice(spawnIdx, spawnIdx + 500);
    expect(before).toMatch(/try\s*\{/);
    expect(after).toMatch(/\}\s*catch\s*\(/);
  });

  it('logs at ERROR when spawn fails (graded delivery failure, not benign)', () => {
    // Contract strengthened after the 2026-08 "no visual window opened"
    // failure: a modal that fails to spawn means the user was promised a
    // window and got nothing. It is captured as panelShown=false, graded by
    // the delivery eval (partial-no-panel), and logged at error level so it
    // is alarm-visible — the old warn treated exactly this as "benign".
    const spawnIdx = block.indexOf('showAgentUIModal');
    const after = block.slice(spawnIdx, spawnIdx + 900);
    expect(after).toMatch(/log\.error\(['"]voice['"],\s*['"]agent-ui modal spawn failed['"]/);
    expect(after).toMatch(/panelShown/);
  });
});

describe('exchange-bridge -- agent-ui:close-self IPC (modal X button)', () => {
  it('registers ipcMain.on(agent-ui:close-self) handler', () => {
    expect(BRIDGE_SOURCE).toMatch(/ipcMain\.on\(['"]agent-ui:close-self['"]/);
  });

  it('handler closes the BrowserWindow that sent the message', () => {
    const handlerMatch = BRIDGE_SOURCE.match(
      /ipcMain\.on\(['"]agent-ui:close-self['"][\s\S]{0,500}/
    );
    expect(handlerMatch).toBeTruthy();
    const body = handlerMatch[0];
    expect(body).toMatch(/BrowserWindow\.fromWebContents\(event\.sender\)/);
    expect(body).toMatch(/\.close\(\)/);
  });
});
