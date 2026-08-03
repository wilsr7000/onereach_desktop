/**
 * orb.html -- SINGLE-PATH invariants (renderer never dispatches voice)
 *
 * History: this file used to pin the reciprocal same-turn dedup between the
 * transcript handler and the function-call handler -- machinery that only
 * existed because BOTH renderer handlers could dispatch the same utterance
 * (double-submit -> the user heard answers twice). That dual dispatch and
 * its dedup are DELETED: the main process is the one and only dispatcher for
 * voice requests (voice-listener.js on handle_user_request), and renderers
 * receive function_call_transcript for UI only.
 *
 * These invariants keep the renderer honest: if either dispatch path or the
 * dedup constants creep back into orb.html, the one-path architecture has
 * regressed.
 */

import { describe, it, expect } from 'vitest';

const fs = require('fs');
const path = require('path');

const ORB_SOURCE = fs.readFileSync(path.join(__dirname, '../../orb.html'), 'utf8');

describe('orb.html -- single-path: renderer is UI-only for voice', () => {
  function sliceFrom(marker, len) {
    const start = ORB_SOURCE.indexOf(marker);
    expect(start, `${marker} must exist in orb.html`).toBeGreaterThan(-1);
    return ORB_SOURCE.slice(start, start + len);
  }

  it('handleFunctionCallTranscript does NOT submit tasks or ack the tool call (main owns both)', () => {
    const body = sliceFrom('function handleFunctionCallTranscript', 2500);
    expect(body).not.toMatch(/agentHUD\.submitTask/);
    expect(body).not.toMatch(/respondToFunction/);
  });

  it('handleFunctionCallTranscript still drives the UI (processing state + transcript bubble)', () => {
    const body = sliceFrom('function handleFunctionCallTranscript', 2500);
    expect(body).toMatch(/S\.transition\(\s*['"]processing['"]/);
    expect(body).toMatch(/showTranscript\(/);
  });

  it('voice transcript finals are captions only — no processVoiceCommand dispatch', () => {
    const idx = ORB_SOURCE.indexOf('transcript: (e) =>');
    expect(idx).toBeGreaterThan(-1);
    const body = ORB_SOURCE.slice(idx, ORB_SOURCE.indexOf('reconnecting:', idx));
    expect(body).not.toMatch(/processVoiceCommand\(/);
    expect(body).toMatch(/showTranscript\(/);
  });

  it('the same-turn dedup machinery stays deleted', () => {
    expect(ORB_SOURCE).not.toMatch(/SAME_TURN_DEDUP_MS/);
    expect(ORB_SOURCE).not.toMatch(/FUNCTION_CALL_DEDUP_MS/);
    expect(ORB_SOURCE).not.toMatch(/lastFunctionCallTranscript/);
  });

  it('processVoiceCommand remains for text-in (the chat box owns the text path)', () => {
    expect(ORB_SOURCE).toMatch(/processVoiceCommand\(text,\s*\{\s*inputModality:\s*['"]text['"]/);
  });
});
