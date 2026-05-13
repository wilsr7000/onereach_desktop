/**
 * Exchange Bridge -- panel sizing forwarding (regression)
 *
 * The daily-brief agent (and any other agent that returns a rich
 * declarative UI spec) sets `panelWidth` + `panelHeight` on its result
 * so the Command HUD can grow to fit the dayView card stack
 * (right-now, insights, timeline, AI briefing, smart actions, focus
 * window). The HUD's `addAgentUIPanel({width, height})` and
 * `recalculateHUDSize()` read those numbers; without them it falls
 * back to the 340x420 default and the dayView's tall cards get clipped
 * below the fold.
 *
 * Pre-fix, exchange-bridge's task:settled handler dropped both fields
 * when forwarding to `sendCommandHUDResult` AND `hudApi.emitResult` --
 * agent.execute()'s panelWidth/panelHeight made it as far as
 * task:settled but were filtered out of the payload sent to the HUD.
 * The user-visible symptom: panel rendered (because `result.html` was
 * forwarded) but only the first ~420px were on screen, the rest below
 * the fold.
 *
 * This test pins the forwarding contract at the source level so the
 * regression can't silently come back during a refactor.
 *
 * Run: npx vitest run test/unit/exchange-bridge-panel-forwarding.test.js
 */

import { describe, it, expect } from 'vitest';
const fs = require('fs');
const path = require('path');

const BRIDGE_SOURCE = fs.readFileSync(
  path.join(__dirname, '../../src/voice-task-sdk/exchange-bridge.js'),
  'utf8'
);

// Slice out the task:settled success-path block. Everything in this
// test asserts against that block specifically, not e.g. the error
// agent's `sendCommandHUDResult` (which never carries a panel).
function extractTaskSettledSuccessBlock() {
  const start = BRIDGE_SOURCE.indexOf("exchangeInstance.on('task:settled'");
  expect(start, 'task:settled handler must exist').toBeGreaterThan(-1);
  // Find the end of the handler -- the closing of `});` for the outer
  // exchangeInstance.on(...). We use the next `exchangeInstance.on(`
  // call as a sentinel; that's the next event handler.
  const sentinel = BRIDGE_SOURCE.indexOf(
    "exchangeInstance.on('task:executing'",
    start
  );
  expect(sentinel, 'task:executing must follow task:settled').toBeGreaterThan(start);
  return BRIDGE_SOURCE.slice(start, sentinel);
}

describe('exchange-bridge task:settled -- panel sizing forwarding', () => {
  const block = extractTaskSettledSuccessBlock();

  it('forwards panelWidth from result to sendCommandHUDResult', () => {
    // The payload literal must contain `panelWidth: result.panelWidth`
    // (or a shorthand spread). Pin the explicit form -- spreads have
    // bitten us before by accidentally including unrelated fields.
    const sendCommandHUDStart = block.indexOf('global.sendCommandHUDResult({');
    expect(sendCommandHUDStart, 'sendCommandHUDResult call must exist').toBeGreaterThan(-1);
    const sendCommandHUDPayload = block.slice(sendCommandHUDStart, sendCommandHUDStart + 800);
    expect(sendCommandHUDPayload).toMatch(/panelWidth:\s*result\.panelWidth/);
  });

  it('forwards panelHeight from result to sendCommandHUDResult', () => {
    const sendCommandHUDStart = block.indexOf('global.sendCommandHUDResult({');
    const sendCommandHUDPayload = block.slice(sendCommandHUDStart, sendCommandHUDStart + 800);
    expect(sendCommandHUDPayload).toMatch(/panelHeight:\s*result\.panelHeight/);
  });

  it('forwards panelWidth from result to hudApi.emitResult', () => {
    const emitStart = block.indexOf('hudApi.emitResult({');
    expect(emitStart, 'hudApi.emitResult call must exist').toBeGreaterThan(-1);
    const emitPayload = block.slice(emitStart, emitStart + 800);
    expect(emitPayload).toMatch(/panelWidth:\s*result\.panelWidth/);
  });

  it('forwards panelHeight from result to hudApi.emitResult', () => {
    const emitStart = block.indexOf('hudApi.emitResult({');
    const emitPayload = block.slice(emitStart, emitStart + 800);
    expect(emitPayload).toMatch(/panelHeight:\s*result\.panelHeight/);
  });

  it('still forwards html so the panel renders at all', () => {
    // Sanity: the regression fix shouldn't have dropped the existing
    // html field while adding panelWidth/Height.
    expect(block).toMatch(/html:\s*result\.html/);
  });

  it('also forwards the raw ui spec so listeners can re-render if needed', () => {
    // Optional but useful: listeners that want to re-derive the panel
    // (e.g. a future renderer that doesn't trust the inline html or
    // wants to mutate the spec) can read result.ui directly.
    const sendCommandHUDStart = block.indexOf('global.sendCommandHUDResult({');
    const sendCommandHUDPayload = block.slice(sendCommandHUDStart, sendCommandHUDStart + 800);
    expect(sendCommandHUDPayload).toMatch(/ui:\s*result\.ui/);
    const emitStart = block.indexOf('hudApi.emitResult({');
    const emitPayload = block.slice(emitStart, emitStart + 800);
    expect(emitPayload).toMatch(/ui:\s*result\.ui/);
  });
});

describe('exchange-bridge task:settled -- payload shape sanity', () => {
  const block = extractTaskSettledSuccessBlock();

  it('sendCommandHUDResult is called only once in the success path', () => {
    // If a refactor accidentally splits into two emits we want to know.
    const matches = block.match(/global\.sendCommandHUDResult\(/g) || [];
    expect(matches.length).toBe(1);
  });

  it('hudApi.emitResult is called only once in the success path', () => {
    const matches = block.match(/hudApi\.emitResult\(/g) || [];
    expect(matches.length).toBe(1);
  });
});
