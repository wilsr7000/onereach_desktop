/**
 * exchange-bridge task:settled -- quality gates (source invariants)
 *
 * Pins the settle-path wiring for the alarm-request fix set. The bridge is a
 * 6000-line module with heavy side effects, so these are source invariants on
 * the exact gates; the decision logic itself is behaviorally tested in
 * result-quality.test.js / gap-recheck.test.js / delivery-eval.test.js.
 *
 * Bugs pinned:
 *  1. needsInput settle cached as a successful route (cache poisoning)
 *  2. needsInput settle minted reputation success 1.0 + stats success
 *  3. needsInput settles produced ZERO delivery-eval verdicts
 *  4. cascade-revealed capability gaps never re-offered the agent builder
 *  5. the needs-input prompt was spoken without taskResult:true (idle-audio
 *     guard could drop it) and its playback outcome was discarded
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SRC = readFileSync(
  resolve(__dirname, '..', '..', 'src', 'voice-task-sdk', 'exchange-bridge.js'),
  'utf8'
);

function settleHandler() {
  const start = SRC.indexOf("exchangeInstance.on('task:settled'");
  expect(start, 'task:settled handler must exist').toBeGreaterThan(-1);
  return SRC.slice(start, start + 30000);
}

describe('routing cache gate', () => {
  it('caches only RESOLVED successes (isResolvedSuccess), not success!==false', () => {
    const handler = settleHandler();
    const cacheIdx = handler.indexOf('recordSuccessfulRoute(task.content');
    expect(cacheIdx).toBeGreaterThan(-1);
    const before = handler.slice(Math.max(0, cacheIdx - 700), cacheIdx);
    expect(before).toMatch(/isResolvedSuccess\(result\)/);
    expect(before).not.toMatch(/result\?\.success\s*!==\s*false\s*\)\s*\{/);
  });
});

describe('stats + reputation gates', () => {
  it('records stats success only for resolved successes, failures only for explicit failure', () => {
    const handler = settleHandler();
    expect(handler).toMatch(/if\s*\(isResolvedSuccess\(result\)\)\s*\{\s*\n?\s*stats\.recordSuccess/);
    expect(handler).toMatch(/else if\s*\(result\?\.success === false\)\s*\{\s*\n?\s*stats\.recordFailure/);
  });

  it('skips orchestrator positive feedback for needsInput settles (neutral)', () => {
    const handler = settleHandler();
    expect(handler).toMatch(
      /if\s*\(isResolvedSuccess\(result\)\s*\|\|\s*result\?\.success === false\)\s*\{[\s\S]{0,400}provideFeedback/
    );
    expect(handler).toMatch(/Feedback skipped \(needsInput settle is neutral\)/);
  });

  it('still processes rejected-bid penalties regardless of settle quality', () => {
    const handler = settleHandler();
    const skipIdx = handler.indexOf('Feedback skipped (needsInput settle is neutral)');
    const rejectedIdx = handler.indexOf('processRejectedBids', skipIdx);
    expect(rejectedIdx).toBeGreaterThan(skipIdx);
  });
});

describe('needsInput settle branch', () => {
  it('grades delivery (evaluateDelivery) for every needsInput settle', () => {
    const handler = settleHandler();
    const niIdx = handler.indexOf('Check for multi-turn conversation (needsInput)');
    expect(niIdx).toBeGreaterThan(-1);
    const branch = handler.slice(niIdx, niIdx + 7000);
    expect(branch).toMatch(/deliveryEval\.evaluateDelivery\(\{/);
    expect(branch).toMatch(/spokenSummary:\s*result\.needsInput\.prompt/);
    expect(branch).toMatch(/speakResult:\s*niOutcome\?\.spoke === true/);
  });

  it('runs the capability-gap re-check and offers the builder on a revealed gap', () => {
    const handler = settleHandler();
    const niIdx = handler.indexOf('Check for multi-turn conversation (needsInput)');
    const branch = handler.slice(niIdx, niIdx + 7000);
    expect(branch).toMatch(/shouldOfferGapAfterSettle\(\{/);
    expect(branch).toMatch(/capability-gap:post-settle/);
    expect(branch).toMatch(/learning:capability-gap/);
    // Consent must be REGISTERED (pending -> builder), not just spoken: a
    // bare spoken instruction gets hijacked by the dead-end's own pending
    // state (verified live 2026-08-03).
    expect(branch).toMatch(/EVALUATE_BUILDABILITY/);
    expect(branch).toMatch(/clearPending\(agentId\)/);
    expect(branch).toMatch(/handleNeedsInput\(builderResult,\s*'agent-builder-agent'/);
  });
});

describe('handleNeedsInput speak contract', () => {
  it('speaks the prompt with taskResult: true and returns { spoke, prompt }', () => {
    const fnIdx = SRC.indexOf('async function handleNeedsInput');
    expect(fnIdx).toBeGreaterThan(-1);
    const body = SRC.slice(fnIdx, fnIdx + 5000);
    expect(body).toMatch(/speaker\.speak\(prompt,\s*\{\s*voice:\s*agentVoice,\s*taskResult:\s*true\s*\}\)/);
    expect(body).toMatch(/return\s*\{\s*spoke,\s*prompt\s*\}/);
  });
});
