/**
 * orb.html -- same-turn dedup between transcript and function_call_transcript
 *
 * The realtime API GA fires TWO events for each user utterance:
 *   1. `transcript` event with the Whisper transcription
 *   2. `function_call_transcript` event with the model's
 *      handle_user_request argument
 *
 * With gpt-realtime-2 the model often paraphrases the Whisper transcript
 * (observed in production: "Can you give me the brief?" -> "Can you
 * give me the debrief? \ud83d\ude0a"). The original orb dedup only
 * checked text-equality with punctuation stripped, so it missed any
 * paraphrase -- BOTH events submitted tasks for the SAME user turn,
 * which then both routed to the same agent, both queued their result
 * to voice-speaker, and the user heard the answer twice (with a "got
 * it" deferred-ack sandwiched between).
 *
 * The fix adds time-only same-turn dedup in BOTH directions:
 *   - If transcript fires AFTER a function call within
 *     SAME_TURN_DEDUP_MS, the transcript handler skips (function call
 *     wins).
 *   - If function call fires AFTER a transcript within
 *     SAME_TURN_DEDUP_MS, the function call handler skips submission
 *     but STILL ack's the call to OpenAI (silent ack with empty string)
 *     so the realtime session does not hang on a pending tool call.
 *
 * These are source-level invariant tests on orb.html; we don't try to
 * execute the renderer code (it depends on DOM + many singletons).
 */

import { describe, it, expect } from 'vitest';

const fs = require('fs');
const path = require('path');

const ORB_SOURCE = fs.readFileSync(
  path.join(__dirname, '../../orb.html'),
  'utf8'
);

describe('orb.html -- same-turn dedup constants', () => {
  it('declares SAME_TURN_DEDUP_MS at a sane value (1000..3000ms)', () => {
    const match = ORB_SOURCE.match(/const\s+SAME_TURN_DEDUP_MS\s*=\s*(\d+)\s*;/);
    expect(match, 'SAME_TURN_DEDUP_MS constant must be declared').not.toBeNull();
    const ms = parseInt(match[1], 10);
    // Too low -> misses delayed events. Too high -> blocks legitimate
    // back-to-back utterances. 1000..3000ms is the sweet spot.
    expect(ms).toBeGreaterThanOrEqual(1000);
    expect(ms).toBeLessThanOrEqual(3000);
  });

  it('keeps the legacy FUNCTION_CALL_DEDUP_MS for the text-equality fallback', () => {
    expect(ORB_SOURCE).toMatch(/const\s+FUNCTION_CALL_DEDUP_MS\s*=\s*\d+\s*;/);
  });
});

describe('orb.html -- transcript handler dedup', () => {
  // Slice out the transcript handler so we don't accidentally match
  // similar dedup logic in unrelated handlers.
  function extractTranscriptHandler() {
    // The transcript handler is registered as `transcript: (e) => { ... }`
    // inside OrbEventRouter.start(). We extract from that arrow opener
    // to the next handler key (`reconnecting:`).
    const start = ORB_SOURCE.indexOf('transcript: (e) => {');
    expect(start, 'transcript handler must exist').toBeGreaterThan(-1);
    const end = ORB_SOURCE.indexOf('reconnecting:', start);
    expect(end, 'reconnecting handler must follow').toBeGreaterThan(start);
    return ORB_SOURCE.slice(start, end);
  }

  const body = extractTranscriptHandler();

  it('reads lastFunctionCallTime and compares against SAME_TURN_DEDUP_MS', () => {
    expect(body).toMatch(/S\.get\(['"]lastFunctionCallTime['"]\)/);
    expect(body).toMatch(/SAME_TURN_DEDUP_MS/);
  });

  it('skips processing (returns) when function call fired within the window', () => {
    // We expect a guard block that detects the recent function call and
    // bails before calling processVoiceCommand.
    expect(body).toMatch(/lastFCTime\s*>\s*0[\s\S]*?Date\.now\(\)\s*-\s*lastFCTime\s*<\s*SAME_TURN_DEDUP_MS[\s\S]*?return;/);
  });

  it('still emits the transcript UI on dedup (so the user sees what they said)', () => {
    // Dedup must not be a "silent drop" from the user's POV -- the
    // transcript bubble should still flash so the user knows they were
    // heard.
    expect(body).toMatch(/showTranscript\(text, false\);[\s\S]*?return;/);
  });

  it('records lastTranscriptText / lastTranscriptTime so the function-call handler can dedup against it', () => {
    expect(body).toMatch(/S\.set\(['"]lastTranscriptText['"],\s*text\)/);
    expect(body).toMatch(/S\.set\(['"]lastTranscriptTime['"],\s*Date\.now\(\)\)/);
  });
});

describe('orb.html -- handleFunctionCallTranscript reciprocal dedup', () => {
  function extractFunctionCallHandler() {
    const start = ORB_SOURCE.indexOf('async function handleFunctionCallTranscript');
    expect(start, 'handleFunctionCallTranscript must exist').toBeGreaterThan(-1);
    // Find the matching close-brace. Bounded slice is fine; we just
    // need a generous window. The handler is < 200 lines.
    return ORB_SOURCE.slice(start, start + 12000);
  }

  const body = extractFunctionCallHandler();

  it('stamps lastFunctionCallTranscript and lastFunctionCallTime BEFORE the dedup check', () => {
    // Order matters: we want a late-arriving transcript event to still
    // see the function call's stamp even if we dedup-skip this call.
    const stampIdx = body.search(/S\.set\(['"]lastFunctionCallTime['"],\s*Date\.now\(\)\)/);
    const dedupIdx = body.search(/lastTranscriptTime/);
    expect(stampIdx, 'must stamp lastFunctionCallTime').toBeGreaterThan(-1);
    expect(dedupIdx, 'must read lastTranscriptTime').toBeGreaterThan(-1);
    expect(stampIdx).toBeLessThan(dedupIdx);
  });

  it('reads lastTranscriptTime and skips when within SAME_TURN_DEDUP_MS', () => {
    expect(body).toMatch(/S\.get\(['"]lastTranscriptTime['"]\)/);
    expect(body).toMatch(/lastTTime\s*>\s*0[\s\S]*?Date\.now\(\)\s*-\s*lastTTime\s*<\s*SAME_TURN_DEDUP_MS/);
  });

  it('silently acks OpenAI on dedup-skip via respondToFunction(callId, "")', () => {
    // CRITICAL: skipping submit but NOT ack'ing OpenAI would leave the
    // realtime session hung on a pending tool call. We must call
    // respondToFunction with an empty string -- voice-listener already
    // treats empty as a silent ack and skips response.create.
    expect(body).toMatch(/respondToFunction\(callId,\s*['"]['"]\)/);
  });

  it('does NOT call agentHUD.submitTask in the dedup-skip path', () => {
    // Locate the dedup-skip block and confirm the return happens before
    // any submitTask call.
    const skipBlockStart = body.indexOf('lastTTime');
    const submitTaskIdx = body.indexOf('agentHUD.submitTask', skipBlockStart);
    // The return inside the skip block must come before submitTask.
    const returnIdx = body.indexOf('return;', skipBlockStart);
    expect(returnIdx).toBeGreaterThan(-1);
    expect(returnIdx).toBeLessThan(submitTaskIdx);
  });

  it('clears pendingFunctionCallId in the dedup-skip path', () => {
    // Without this, the orb state machine can stay stuck in "processing"
    // believing a function call is still in flight.
    expect(body).toMatch(/S\.set\(['"]pendingFunctionCallId['"],\s*null\)/);
  });
});

describe('orb.html -- regression scenario: brief vs debrief paraphrase', () => {
  // This is the exact production case the user reported:
  //   transcript:               "Can you give me the brief?"
  //   function_call_transcript: "Can you give me the debrief? \ud83d\ude0a"
  // The original text-equality dedup missed (different words + emoji),
  // both submitted, brief was spoken twice.

  it('does not depend on text equality for the same-turn dedup path', () => {
    // The transcript handler's PRIMARY dedup must be time-only, not
    // text-comparison-based. The legacy text-equality check should be
    // a secondary fallback only.
    const start = ORB_SOURCE.indexOf('transcript: (e) => {');
    const end = ORB_SOURCE.indexOf('reconnecting:', start);
    const body = ORB_SOURCE.slice(start, end);

    // The first dedup check must reference time-window only, BEFORE
    // any text-equality comparison.
    const timeIdx = body.search(/SAME_TURN_DEDUP_MS/);
    const equalityIdx = body.search(/normalizedText\s*===\s*normalizedFuncCall/);
    expect(timeIdx).toBeGreaterThan(-1);
    expect(equalityIdx).toBeGreaterThan(-1);
    // Time-based check comes first.
    expect(timeIdx).toBeLessThan(equalityIdx);
  });
});
