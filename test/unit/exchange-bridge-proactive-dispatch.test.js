/**
 * exchange-bridge -- proactive alert dispatcher (Phase 6)
 *
 * Source-level invariants for dispatchProactiveAlert in exchange-bridge.
 * Pins the unified surfaces an alert touches:
 *   - hudApi.emitResult so subscribers see alerts too
 *   - voice-task:reply broadcast tagged origin: 'proactive'
 *   - orb-chat-history append tagged source: 'agent-proactive'
 *   - agent-ui-modal-manager.showAgentUIModal when displayMode === 'modal'
 *   - voice-speaker.speak ALWAYS (override the voice-in-only TTS gate)
 */

import { describe, it, expect } from 'vitest';
const fs = require('fs');
const path = require('path');

const BRIDGE_SOURCE = fs.readFileSync(
  path.join(__dirname, '../../src/voice-task-sdk/exchange-bridge.js'),
  'utf8'
);

function extractDispatcher() {
  const start = BRIDGE_SOURCE.indexOf('function dispatchProactiveAlert');
  expect(start, 'dispatchProactiveAlert function must exist').toBeGreaterThan(-1);
  // Cap at 6000 chars -- the function is generously sized.
  return BRIDGE_SOURCE.slice(start, start + 6000);
}

describe('exchange-bridge -- imports and listener registration', () => {
  it('requires lib/voice-task-push', () => {
    expect(BRIDGE_SOURCE).toMatch(/require\(['"]\.\.\/\.\.\/lib\/voice-task-push['"]\)/);
  });

  it('registers dispatchProactiveAlert as the proactive listener at module load', () => {
    expect(BRIDGE_SOURCE).toMatch(/voiceTaskPush\.setProactiveListener\(dispatchProactiveAlert\)/);
  });
});

describe('exchange-bridge -- dispatchProactiveAlert routes alert through unified surfaces', () => {
  const body = extractDispatcher();

  it('normalizes the synthetic result via the dual-channel shim', () => {
    expect(body).toMatch(/normalizeAgentResult\(/);
  });

  it('emits to hudApi.emitResult', () => {
    expect(body).toMatch(/hudApi\.emitResult\(/);
  });

  it('broadcasts voice-task:reply with origin: "proactive"', () => {
    expect(body).toMatch(/broadcastToWindows\(['"]voice-task:reply['"]/);
    expect(body).toMatch(/origin:\s*['"]proactive['"]/);
  });

  it('appends to orb chat history with source: "agent-proactive"', () => {
    expect(body).toMatch(/require\(['"]\.\.\/\.\.\/lib\/orb-chat-history['"]\)/);
    expect(body).toMatch(/source:\s*['"]agent-proactive['"]/);
  });

  it('spawns a modal when displayMode === "modal" AND html is present', () => {
    expect(body).toMatch(/normalized\.displayMode\s*===\s*['"]modal['"]\s*&&\s*normalized\.html/);
    expect(body).toMatch(/showAgentUIModal\(/);
  });

  it('always speaks (no inputModality gate for proactive)', () => {
    // The TTS block in dispatchProactiveAlert must NOT contain the
    // "inputModality === 'voice'" gate -- alerts always speak by design.
    const ttsIdx = body.indexOf('speaker.speak(');
    expect(ttsIdx, 'speaker.speak call must exist').toBeGreaterThan(-1);
    const before = body.slice(Math.max(0, ttsIdx - 600), ttsIdx);
    // The proactive guard is just `if (normalized.spokenSummary && !== 'All done')`.
    expect(before).toMatch(/normalized\.spokenSummary[\s\S]{0,200}!==?\s*['"]All done['"]/);
    // No inputModality === 'voice' check inside the proactive dispatcher
    expect(before).not.toMatch(/inputModality\s*===\s*['"]voice['"]/);
  });

  it('logs at warn (not error) for individual surface failures (best-effort dispatch)', () => {
    // The dispatcher wraps each surface in its own try/catch and logs
    // at warn so a chat-history failure doesn't cascade to TTS.
    expect(body).toMatch(/log\.warn\(['"]voice['"],\s*['"]proactive [^'"]+failed['"]/);
  });
});
