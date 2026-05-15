/**
 * Exchange Bridge -- task:settled forwarding contract
 *
 * Pins what gets forwarded from the agent result to:
 *   - sendCommandHUDResult (legacy Command HUD window)
 *   - hudApi.emitResult    (any HUD-API subscriber)
 *   - voice-task:reply     (new orb chat panel broadcast, Phase 1)
 *
 * History:
 *   - v4.9.1 added `panelWidth` + `panelHeight` to the forwarding
 *     payload so the daily-brief dayView could grow past the default
 *     340x420 HUD size. Without those, the dayView's tall card stack
 *     (right-now, insights, timeline, AI briefing, smart actions, focus
 *     window) was clipped below the fold.
 *   - v5.0.11 (this rev): added the dual-channel agent contract --
 *     spokenSummary + visualText + displayMode -- so reading bandwidth
 *     and listening bandwidth can carry different content. Backward
 *     compatible: the legacy `message` field is still forwarded for
 *     subscribers that haven't migrated.
 *
 * The test asserts SOURCE-LEVEL invariants on the task:settled success
 * block (vitest's CJS mock semantics + module-cache reset don't compose
 * well across describe blocks, see orb-same-turn-dedup.test.js for the
 * same pattern).
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
  expect(start, 'task:settled handler must exist').toBeGreaterThan(-1);
  const sentinel = BRIDGE_SOURCE.indexOf(
    "exchangeInstance.on('task:executing'",
    start
  );
  expect(sentinel, 'task:executing must follow task:settled').toBeGreaterThan(start);
  return BRIDGE_SOURCE.slice(start, sentinel);
}

describe('exchange-bridge task:settled -- legacy panel sizing forwarding (v4.9.1 regression guard)', () => {
  const block = extractTaskSettledSuccessBlock();

  it('forwards panelWidth from result to sendCommandHUDResult', () => {
    const sendCommandHUDStart = block.indexOf('global.sendCommandHUDResult({');
    expect(sendCommandHUDStart, 'sendCommandHUDResult call must exist').toBeGreaterThan(-1);
    const sendCommandHUDPayload = block.slice(sendCommandHUDStart, sendCommandHUDStart + 1200);
    expect(sendCommandHUDPayload).toMatch(/panelWidth:\s*result\.panelWidth/);
  });

  it('forwards panelHeight from result to sendCommandHUDResult', () => {
    const sendCommandHUDStart = block.indexOf('global.sendCommandHUDResult({');
    const sendCommandHUDPayload = block.slice(sendCommandHUDStart, sendCommandHUDStart + 1200);
    expect(sendCommandHUDPayload).toMatch(/panelHeight:\s*result\.panelHeight/);
  });

  it('forwards panelWidth from result to hudApi.emitResult', () => {
    const emitStart = block.indexOf('hudApi.emitResult({');
    expect(emitStart, 'hudApi.emitResult call must exist').toBeGreaterThan(-1);
    const emitPayload = block.slice(emitStart, emitStart + 1200);
    expect(emitPayload).toMatch(/panelWidth:\s*result\.panelWidth/);
  });

  it('forwards panelHeight from result to hudApi.emitResult', () => {
    const emitStart = block.indexOf('hudApi.emitResult({');
    const emitPayload = block.slice(emitStart, emitStart + 1200);
    expect(emitPayload).toMatch(/panelHeight:\s*result\.panelHeight/);
  });

  it('still forwards html so the panel renders at all', () => {
    expect(block).toMatch(/html:\s*result\.html/);
  });

  it('also forwards the raw ui spec so listeners can re-render if needed', () => {
    const sendCommandHUDStart = block.indexOf('global.sendCommandHUDResult({');
    const sendCommandHUDPayload = block.slice(sendCommandHUDStart, sendCommandHUDStart + 1200);
    expect(sendCommandHUDPayload).toMatch(/ui:\s*result\.ui/);
    const emitStart = block.indexOf('hudApi.emitResult({');
    const emitPayload = block.slice(emitStart, emitStart + 1200);
    expect(emitPayload).toMatch(/ui:\s*result\.ui/);
  });

  it('still forwards the legacy `message` field (backward compat for unmigrated subscribers)', () => {
    // The dual-channel migration is additive -- subscribers that still
    // read `message` keep working. Drop this assertion only when every
    // subscriber has migrated and we're ready to remove the field.
    const sendCommandHUDStart = block.indexOf('global.sendCommandHUDResult({');
    const sendCommandHUDPayload = block.slice(sendCommandHUDStart, sendCommandHUDStart + 1200);
    expect(sendCommandHUDPayload).toMatch(/message:\s*message\s*\|\|/);
    const emitStart = block.indexOf('hudApi.emitResult({');
    const emitPayload = block.slice(emitStart, emitStart + 1200);
    expect(emitPayload).toMatch(/message:\s*message\s*\|\|/);
  });
});

describe('exchange-bridge task:settled -- dual-channel forwarding (Foundation, v5.0.11)', () => {
  const block = extractTaskSettledSuccessBlock();

  it('imports normalizeAgentResult', () => {
    expect(BRIDGE_SOURCE).toMatch(/require\(['"]\.\.\/\.\.\/lib\/agent-result-normalize['"]\)/);
  });

  it('calls normalizeAgentResult to compute the dual-channel shape', () => {
    expect(block).toMatch(/normalizeAgentResult\(/);
  });

  it('forwards spokenSummary to sendCommandHUDResult', () => {
    const sendCommandHUDStart = block.indexOf('global.sendCommandHUDResult({');
    const sendCommandHUDPayload = block.slice(sendCommandHUDStart, sendCommandHUDStart + 1200);
    expect(sendCommandHUDPayload).toMatch(/spokenSummary:\s*normalized\.spokenSummary/);
  });

  it('forwards visualText to sendCommandHUDResult', () => {
    const sendCommandHUDStart = block.indexOf('global.sendCommandHUDResult({');
    const sendCommandHUDPayload = block.slice(sendCommandHUDStart, sendCommandHUDStart + 1200);
    expect(sendCommandHUDPayload).toMatch(/visualText:\s*normalized\.visualText/);
  });

  it('forwards displayMode to sendCommandHUDResult', () => {
    const sendCommandHUDStart = block.indexOf('global.sendCommandHUDResult({');
    const sendCommandHUDPayload = block.slice(sendCommandHUDStart, sendCommandHUDStart + 1200);
    expect(sendCommandHUDPayload).toMatch(/displayMode:\s*normalized\.displayMode/);
  });

  it('forwards spokenSummary + visualText + displayMode to hudApi.emitResult', () => {
    const emitStart = block.indexOf('hudApi.emitResult({');
    const emitPayload = block.slice(emitStart, emitStart + 1200);
    expect(emitPayload).toMatch(/spokenSummary:\s*normalized\.spokenSummary/);
    expect(emitPayload).toMatch(/visualText:\s*normalized\.visualText/);
    expect(emitPayload).toMatch(/displayMode:\s*normalized\.displayMode/);
  });

  it('addToHistory uses normalized.visualText (not the raw `message`)', () => {
    // visualText falls back to message for legacy agents, so behavior is
    // unchanged for them; new agents log their richer text.
    expect(block).toMatch(/addToHistory\(['"]assistant['"],\s*normalized\.visualText/);
  });
});

describe('exchange-bridge task:settled -- voice-task:reply broadcast (Phase 1)', () => {
  const block = extractTaskSettledSuccessBlock();

  it('broadcasts voice-task:reply with the dual-channel payload', () => {
    expect(block).toMatch(/broadcastToWindows\(['"]voice-task:reply['"]/);
    const replyStart = block.indexOf("broadcastToWindows('voice-task:reply'");
    expect(replyStart).toBeGreaterThan(-1);
    const replyPayload = block.slice(replyStart, replyStart + 1500);
    expect(replyPayload).toMatch(/visualText:\s*normalized\.visualText/);
    expect(replyPayload).toMatch(/spokenSummary:\s*normalized\.spokenSummary/);
    expect(replyPayload).toMatch(/displayMode:\s*normalized\.displayMode/);
    expect(replyPayload).toMatch(/inputModality/);
    expect(replyPayload).toMatch(/origin/);
  });

  it('inlineCardHtml is the html ONLY when displayMode === inline (so chat doesnt double-render modal panels)', () => {
    // The const declaration (used by both the broadcast AND the
    // chat-history persistence) must encode the displayMode === inline
    // ? html : null logic. Pinning the declaration form rather than the
    // literal-in-payload form keeps the two consumers DRY.
    expect(block).toMatch(/const\s+inlineCardHtml\s*=\s*normalized\.displayMode\s*===\s*['"]inline['"]\s*\?\s*normalized\.html\s*:\s*null/);
    // And the broadcast payload must reference it (shorthand or full).
    const replyStart = block.indexOf("broadcastToWindows('voice-task:reply'");
    const replyPayload = block.slice(replyStart, replyStart + 1500);
    expect(replyPayload).toMatch(/inlineCardHtml,?/);
  });

  it('modalRef set ONLY when displayMode === modal, with sizing hints', () => {
    // Same DRY pattern: const carries the conditional, broadcast
    // references it. modalRef payload must include both panelWidth and
    // panelHeight so the modal manager can size the window.
    const modalConstMatch = block.match(/const\s+modalRef\s*=\s*normalized\.displayMode\s*===\s*['"]modal['"][\s\S]{0,300}/);
    expect(modalConstMatch, 'modalRef const must be derived from displayMode === "modal"').toBeTruthy();
    expect(modalConstMatch[0]).toMatch(/panelWidth:\s*normalized\.panelWidth/);
    expect(modalConstMatch[0]).toMatch(/panelHeight:\s*normalized\.panelHeight/);
    const replyStart = block.indexOf("broadcastToWindows('voice-task:reply'");
    const replyPayload = block.slice(replyStart, replyStart + 1500);
    expect(replyPayload).toMatch(/modalRef,?/);
  });
});

describe('exchange-bridge task:settled -- TTS modality gate (Phase 3)', () => {
  const block = extractTaskSettledSuccessBlock();

  it('reads inputModality from the task with sensible fallback chain', () => {
    // Where the task came from (voice vs text) determines whether we
    // speak the response. Default to voice for backward compat with
    // pre-Phase-1 callers that never set the field.
    expect(block).toMatch(/task\.inputModality\s*\|\|/);
    expect(block).toMatch(/['"]voice['"]/);
  });

  it('detects proactive origin (alerts always speak, regardless of inputModality)', () => {
    expect(block).toMatch(/task\.metadata\?\.origin\s*===\s*['"]proactive['"]/);
  });

  it('shouldSpeak gate combines voice-in OR proactive AND a non-empty spokenSummary', () => {
    expect(block).toMatch(/const\s+shouldSpeak\s*=/);
    // Same expression must reference both inputModality and isProactive
    const shouldSpeakLine = block.split('\n').find((l) => l.includes('const shouldSpeak'));
    expect(shouldSpeakLine, 'shouldSpeak declaration must exist').toBeTruthy();
    expect(shouldSpeakLine).toMatch(/inputModality\s*===\s*['"]voice['"]/);
    expect(shouldSpeakLine).toMatch(/isProactive/);
    expect(shouldSpeakLine).toMatch(/normalized\.spokenSummary/);
  });

  it('TTS speaks normalized.spokenSummary (NOT the legacy message)', () => {
    // The actual speaker.speak(...) call must use the normalized field,
    // so dual-channel agents speak their summary not their visualText.
    expect(block).toMatch(/speaker\.speak\(normalized\.spokenSummary/);
  });

  it('logs an info breadcrumb when TTS is skipped for text-in (debug aid)', () => {
    // Helps explain "why no audio" in the logs without being noisy.
    expect(block).toMatch(/['"]TTS skipped \(text-in\)['"]/);
  });
});

describe('exchange-bridge task:settled -- payload shape sanity', () => {
  const block = extractTaskSettledSuccessBlock();

  it('sendCommandHUDResult is called only once in the success path', () => {
    const matches = block.match(/global\.sendCommandHUDResult\(/g) || [];
    expect(matches.length).toBe(1);
  });

  it('hudApi.emitResult is called only once in the success path', () => {
    const matches = block.match(/hudApi\.emitResult\(/g) || [];
    expect(matches.length).toBe(1);
  });

  it('voice-task:reply is broadcast exactly once', () => {
    const matches = block.match(/broadcastToWindows\(['"]voice-task:reply['"]/g) || [];
    expect(matches.length).toBe(1);
  });
});
