/**
 * Orb idle-state phantom-audio guard -- taskResult bypass
 *
 * v5.0.13 hotfix.
 *
 * The orb has a defensive guard that drops audio events arriving
 * while the orb is in 'idle' state with no _activeTaskId. The guard
 * stops stray TTS chunks (mostly a debug-time hazard) from playing
 * when the orb shouldn't be speaking.
 *
 * It had two allowlist tags:
 *   - e.proactive: agent-initiated speech (alarms, scheduled briefs)
 *
 * That left a third legitimate case unaccounted-for: TTS for a
 * just-completed async task (daily brief, calendar query, etc.).
 * The orb clears _activeTaskId on task:unlocked, then voice-speaker
 * generates the WAV ~1s later -- arrives at the orb in 'idle' state,
 * not proactive -- and the guard silently drops the audio. User hears
 * nothing. This was the original "no audio out" report.
 *
 * Fix: voice-speaker stamps `taskResult: true` on broadcasts when
 * exchange-bridge passes `metadata.taskResult: true`, and the orb
 * guard adds `e.taskResult` to the allowlist (treated identically to
 * e.proactive).
 *
 * Source-level invariant tests on three files: exchange-bridge,
 * voice-speaker, orb.html. We check the wiring end-to-end without
 * trying to drive the actual audio playback (would need real audio
 * stack + Electron renderer).
 */

import { describe, it, expect } from 'vitest';
const fs = require('fs');
const path = require('path');

const BRIDGE_SOURCE = fs.readFileSync(
  path.join(__dirname, '../../src/voice-task-sdk/exchange-bridge.js'),
  'utf8'
);
const SPEAKER_SOURCE = fs.readFileSync(
  path.join(__dirname, '../../voice-speaker.js'),
  'utf8'
);
const ORB_SOURCE = fs.readFileSync(
  path.join(__dirname, '../../orb.html'),
  'utf8'
);

describe('exchange-bridge -- task:settled passes taskResult: true to speaker.speak', () => {
  // Scope to the task:settled handler block (NOT the proactive
  // dispatcher, which has its own speaker.speak that doesn't need
  // taskResult since proactive already bypasses the orb idle guard).
  function extractTaskSettledBlock() {
    const start = BRIDGE_SOURCE.indexOf("exchangeInstance.on('task:settled'");
    const sentinel = BRIDGE_SOURCE.indexOf("exchangeInstance.on('task:executing'", start);
    return BRIDGE_SOURCE.slice(start, sentinel);
  }

  it('the speaker.speak metadata literal includes taskResult: true', () => {
    const block = extractTaskSettledBlock();
    const ttsCall = block.match(/speaker\.speak\(normalized\.spokenSummary,\s*\{[\s\S]{0,800}\}/);
    expect(ttsCall, 'TTS call must exist in task:settled').toBeTruthy();
    expect(ttsCall[0]).toMatch(/taskResult:\s*true/);
  });

  it('also passes agentId so the orb can identify the source on the broadcast', () => {
    const block = extractTaskSettledBlock();
    const ttsCall = block.match(/speaker\.speak\(normalized\.spokenSummary,\s*\{[\s\S]{0,800}\}/);
    expect(ttsCall[0]).toMatch(/agentId/);
  });
});

describe('voice-speaker -- speak() reads metadata.taskResult and stamps it on broadcasts', () => {
  it('reads metadata.taskResult into a local const', () => {
    expect(SPEAKER_SOURCE).toMatch(/const\s+taskResult\s*=\s*!!metadata\?\.taskResult/);
  });

  it('speak() forwards options.taskResult through the speech-queue metadata (regression: v5.0.13 hotfix forgot this line)', () => {
    // The speak() function builds an explicit allowlist of metadata
    // fields to pass to the speech queue. Without taskResult on the
    // allowlist, the bridge's `taskResult: true` is dropped at the
    // queue boundary and the audio gets phantom-blocked by the orb.
    // This pins the field on the allowlist.
    const speakFn = SPEAKER_SOURCE.match(/async speak\(text, options = \{\}\) \{[\s\S]{0,1500}^\s\s\}/m);
    expect(speakFn, 'async speak() function must exist').toBeTruthy();
    expect(speakFn[0]).toMatch(/taskResult:\s*!!options\.taskResult/);
  });

  it('audio_wav broadcast includes taskResult', () => {
    // Find the broadcast({ type: 'audio_wav', ... }) literal.
    const wavBroadcast = SPEAKER_SOURCE.match(/this\.broadcast\(\{\s*type:\s*['"]audio_wav['"][\s\S]{0,400}\}\)/);
    expect(wavBroadcast, 'audio_wav broadcast must exist').toBeTruthy();
    expect(wavBroadcast[0]).toMatch(/taskResult/);
  });

  it('audio_done broadcast includes taskResult', () => {
    // audio_done is inside a setTimeout. Find via the type literal.
    const doneIdx = SPEAKER_SOURCE.indexOf("type: 'audio_done'");
    expect(doneIdx).toBeGreaterThan(-1);
    const slice = SPEAKER_SOURCE.slice(doneIdx, doneIdx + 400);
    expect(slice).toMatch(/taskResult/);
  });

  it('speech_text broadcast includes taskResult (for transcript subscribers)', () => {
    const textBroadcast = SPEAKER_SOURCE.match(/this\.broadcast\(\{\s*type:\s*['"]speech_text['"][\s\S]{0,200}\}\)/);
    expect(textBroadcast, 'speech_text broadcast must exist').toBeTruthy();
    expect(textBroadcast[0]).toMatch(/taskResult/);
  });
});

describe('orb.html -- audio_wav + audio_done guards allow taskResult through', () => {
  function extractAudioHandler(name) {
    // Find e.g. `audio_wav: (e) => {` and slice forward ~1500 chars.
    const idx = ORB_SOURCE.indexOf(`${name}: (e) => {`);
    expect(idx, `${name} handler must exist`).toBeGreaterThan(-1);
    return ORB_SOURCE.slice(idx, idx + 1500);
  }

  it('audio_wav guard checks e.taskResult alongside e.proactive', () => {
    const body = extractAudioHandler('audio_wav');
    expect(body).toMatch(/!e\.proactive\s*&&\s*!e\.taskResult/);
  });

  it('audio_done guard checks e.taskResult alongside e.proactive', () => {
    const body = extractAudioHandler('audio_done');
    expect(body).toMatch(/!e\.proactive\s*&&\s*!e\.taskResult/);
  });

  it('audio_wav transition reason names the taskResult source for log clarity', () => {
    const body = extractAudioHandler('audio_wav');
    expect(body).toMatch(/audio_wav:taskResult/);
  });
});
