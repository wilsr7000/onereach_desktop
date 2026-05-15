/**
 * voice-listener -- cancel_in_flight + stop_speaking realtime tools
 *
 * Phase 5 of Orb Unified UX redesign. Two new function tools are
 * registered in the session.update payload so the realtime model
 * classifies cancel/stop intent server-side (no regex/keyword
 * detection on our side) and emits a tool call:
 *
 *   - cancel_in_flight: user wants to abort the running task
 *     ("cancel", "forget it", "never mind", "scratch that", etc.)
 *   - stop_speaking: user wants TTS to stop but keep the task
 *     ("stop", "shush", "be quiet", "wait wait wait", etc.)
 *
 * On either tool call, voice-listener:
 *   - Silent-acks the function call (empty result, no response.create)
 *     so the realtime session does not hang on a pending tool reply.
 *   - For cancel: cuts TTS via voice-speaker.cancel() AND cancels any
 *     in-flight tasks on the exchange.
 *   - For stop: cuts TTS only.
 *   - Broadcasts an event for orb UI feedback (chat breadcrumb, etc.).
 *
 * Source-level invariant tests (vitest's CJS mock semantics + module
 * cache reset don't compose well across describe blocks).
 */

import { describe, it, expect } from 'vitest';

const fs = require('fs');
const path = require('path');

const LISTENER_SOURCE = fs.readFileSync(
  path.join(__dirname, '../../voice-listener.js'),
  'utf8'
);

function extractBuildSessionUpdate() {
  const start = LISTENER_SOURCE.indexOf('buildSessionUpdate()');
  expect(start, 'buildSessionUpdate must exist').toBeGreaterThan(-1);
  const sentinel = LISTENER_SOURCE.indexOf('sendEvent(event)', start);
  return LISTENER_SOURCE.slice(start, sentinel);
}

function extractFunctionCallSwitch() {
  // The function_call_arguments.done case starts with the case label.
  const start = LISTENER_SOURCE.indexOf("case 'response.function_call_arguments.done':");
  expect(start, 'function call switch case must exist').toBeGreaterThan(-1);
  // The case extends until the next `case ` at the same indent OR the end of switch.
  // Cap at 5000 chars which is more than enough for the three branches.
  return LISTENER_SOURCE.slice(start, start + 6000);
}

describe('voice-listener -- session.update registers cancel + stop tools (Phase 5)', () => {
  const session = extractBuildSessionUpdate();

  it('registers cancel_in_flight as a function tool', () => {
    expect(session).toMatch(/name:\s*['"]cancel_in_flight['"]/);
  });

  it('cancel_in_flight description names the trigger phrases the model should match', () => {
    // Pinning the description protects against accidental loosening
    // (e.g. someone trims the description and the model stops firing
    // on "scratch that" or "no you misunderstood").
    expect(session).toMatch(/cancel_in_flight[\s\S]{0,800}description:[\s\S]{0,800}cancel/i);
    expect(session).toMatch(/cancel_in_flight[\s\S]{0,800}forget it/);
    expect(session).toMatch(/cancel_in_flight[\s\S]{0,800}never mind/);
    expect(session).toMatch(/cancel_in_flight[\s\S]{0,800}scratch that/);
  });

  it('cancel_in_flight has an optional `reason` parameter (for logging) and required: []', () => {
    const slice = session.slice(session.indexOf("name: 'cancel_in_flight'"));
    expect(slice).toMatch(/reason:\s*\{[\s\S]{0,200}type:\s*['"]string['"]/);
    expect(slice).toMatch(/required:\s*\[\]/);
  });

  it('registers stop_speaking as a function tool', () => {
    expect(session).toMatch(/name:\s*['"]stop_speaking['"]/);
  });

  it('stop_speaking description names the trigger phrases the model should match', () => {
    expect(session).toMatch(/stop_speaking[\s\S]{0,800}stop talking/);
    expect(session).toMatch(/stop_speaking[\s\S]{0,800}shush/);
    expect(session).toMatch(/stop_speaking[\s\S]{0,800}wait wait wait/);
  });

  it('descriptions disambiguate cancel_in_flight vs stop_speaking', () => {
    // Both tools include explicit "Do NOT call this for X" guidance
    // so the model picks the right one.
    expect(session).toMatch(/cancel_in_flight[\s\S]{0,1200}Do NOT call this for[\s\S]{0,200}stop_speaking/i);
    expect(session).toMatch(/stop_speaking[\s\S]{0,1200}Do NOT call this for[\s\S]{0,200}cancel_in_flight/i);
  });

  it('handle_user_request is still the first tool (regression guard)', () => {
    // Don't accidentally break the routing tool when adding cancel/stop.
    const handleIdx = session.indexOf("name: 'handle_user_request'");
    const cancelIdx = session.indexOf("name: 'cancel_in_flight'");
    expect(handleIdx).toBeGreaterThan(-1);
    expect(cancelIdx).toBeGreaterThan(-1);
    expect(handleIdx).toBeLessThan(cancelIdx);
  });
});

describe('voice-listener -- function_call_arguments.done dispatches cancel + stop (Phase 5)', () => {
  const switchBlock = extractFunctionCallSwitch();

  it('handles event.name === "cancel_in_flight"', () => {
    expect(switchBlock).toMatch(/event\.name\s*===\s*['"]cancel_in_flight['"]/);
  });

  it('cancel branch silent-acks the function call (empty string)', () => {
    const cancelIdx = switchBlock.indexOf("'cancel_in_flight'");
    const branch = switchBlock.slice(cancelIdx, cancelIdx + 3000);
    expect(branch).toMatch(/respondToFunctionCall\(event\.call_id,\s*['"]['"]\)/);
  });

  it('cancel branch calls voice-speaker.cancel()', () => {
    const cancelIdx = switchBlock.indexOf("'cancel_in_flight'");
    const branch = switchBlock.slice(cancelIdx, cancelIdx + 3000);
    expect(branch).toMatch(/getVoiceSpeaker/);
    expect(branch).toMatch(/speaker\.cancel\(\)/);
  });

  it('cancel branch attempts to cancel in-flight exchange tasks', () => {
    const cancelIdx = switchBlock.indexOf("'cancel_in_flight'");
    const branch = switchBlock.slice(cancelIdx, cancelIdx + 3000);
    expect(branch).toMatch(/getExchange/);
    // Either tasks.cancel(...) or exchange.cancelTask(...) is acceptable
    expect(branch).toMatch(/tasks\.cancel\(|cancelTask\(/);
  });

  it('cancel branch broadcasts type "voice_intent_cancel" with reason', () => {
    const cancelIdx = switchBlock.indexOf("'cancel_in_flight'");
    const branch = switchBlock.slice(cancelIdx, cancelIdx + 3000);
    expect(branch).toMatch(/this\.broadcast\(\{[\s\S]{0,400}type:\s*['"]voice_intent_cancel['"][\s\S]{0,400}reason/);
  });

  it('handles event.name === "stop_speaking"', () => {
    expect(switchBlock).toMatch(/event\.name\s*===\s*['"]stop_speaking['"]/);
  });

  it('stop branch silent-acks the function call', () => {
    const stopIdx = switchBlock.indexOf("'stop_speaking'");
    const branch = switchBlock.slice(stopIdx, stopIdx + 2000);
    expect(branch).toMatch(/respondToFunctionCall\(event\.call_id,\s*['"]['"]\)/);
  });

  it('stop branch calls voice-speaker.cancel()', () => {
    const stopIdx = switchBlock.indexOf("'stop_speaking'");
    const branch = switchBlock.slice(stopIdx, stopIdx + 2000);
    expect(branch).toMatch(/getVoiceSpeaker/);
    expect(branch).toMatch(/speaker\.cancel\(\)/);
  });

  it('stop branch broadcasts type "voice_intent_stop"', () => {
    const stopIdx = switchBlock.indexOf("'stop_speaking'");
    const branch = switchBlock.slice(stopIdx, stopIdx + 2000);
    expect(branch).toMatch(/this\.broadcast\(\{[\s\S]{0,400}type:\s*['"]voice_intent_stop['"]/);
  });

  it('stop branch does NOT call exchange.cancelTask (TTS-only, task continues)', () => {
    const stopIdx = switchBlock.indexOf("'stop_speaking'");
    // Look only inside the stop branch body (until the next else-if or })
    const branchEnd = switchBlock.indexOf('else if', stopIdx);
    const sliceEnd = branchEnd > stopIdx ? branchEnd : stopIdx + 2000;
    const branch = switchBlock.slice(stopIdx, sliceEnd);
    expect(branch).not.toMatch(/cancelTask|tasks\.cancel/);
  });
});
