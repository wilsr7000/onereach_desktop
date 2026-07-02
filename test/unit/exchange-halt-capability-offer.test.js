/**
 * Exchange Bridge -- exchange:halt capability-gap offer contract
 *
 * Pins the halt handler's structure so the "no agent can do this ->
 * offer to build one" flow stays sound:
 *
 *   1. The handler receives the near-miss `bids` that ride along on
 *      'no_confident_bids' halts (confidence floor) and feeds them to
 *      the rephrase-vs-capability-gap classification.
 *   2. The agent-builder's consent question is registered via
 *      handleNeedsInput (ts.setPending) so the user's "yes" routes back
 *      to the builder instead of re-entering the auction. This was the
 *      original bug: needsInput was forwarded through emitResult only,
 *      which never registers pending input -- the offer led nowhere.
 *   3. The 12s safety timer is defused by a `responded` flag. The full
 *      halt flow (filter + classification + builder + TTS) can exceed
 *      12s, and the timer firing after a successful offer would speak a
 *      contradictory failure message over it.
 *   4. The bridge opts into the Exchange's confidence floor
 *      (auction.minWinnerConfidence) so all-low-confidence auctions
 *      halt instead of executing the least-bad guess.
 *
 * Source-level invariants (same pattern as
 * exchange-bridge-panel-forwarding.test.js -- vitest CJS mock semantics
 * don't compose with this module).
 */

import { describe, it, expect } from 'vitest';
const fs = require('fs');
const path = require('path');

const BRIDGE_SOURCE = fs.readFileSync(
  path.join(__dirname, '../../src/voice-task-sdk/exchange-bridge.js'),
  'utf8'
);

function extractHaltHandler() {
  const start = BRIDGE_SOURCE.indexOf("exchangeInstance.on('exchange:halt'");
  expect(start, 'exchange:halt handler must exist').toBeGreaterThan(-1);
  const sentinel = BRIDGE_SOURCE.indexOf("exchangeInstance.on('task:assigned'", start);
  expect(sentinel, 'task:assigned must follow exchange:halt').toBeGreaterThan(start);
  return BRIDGE_SOURCE.slice(start, sentinel);
}

describe('exchange-bridge exchange:halt -- capability-gap offer wiring', () => {
  const block = extractHaltHandler();

  it('destructures near-miss bids from the halt event', () => {
    expect(block).toMatch(/on\('exchange:halt',\s*async\s*\(\{\s*task,\s*reason,\s*bids\s*\}\)/);
  });

  it('classifies the halted request via the classify-intent meta-task, passing near-miss bids', () => {
    // The rephrase-vs-capability-gap classification now runs as a recorded,
    // direct-assigned meta-task (ADR-EX-007). The near-miss note itself is built
    // and asserted behaviourally in meta-handlers.test.js ("includes near-miss
    // bids in the prompt when present") -- this pins only that the halt handler
    // delegates classification to the meta-task and forwards the near-miss bids.
    expect(block).toMatch(
      /runMetaTask\(\s*META_TASK_KINDS\.CLASSIFY_INTENT,\s*\{\s*content,\s*agentDescriptions,\s*nearMisses\s*\}/
    );
  });

  it('registers the builder consent question via handleNeedsInput', () => {
    const builderBranch = block.slice(block.indexOf("a.id === 'agent-builder-agent'"));
    expect(builderBranch).toMatch(
      /if\s*\(result\.needsInput\)\s*\{[\s\S]*?handleNeedsInput\(result,\s*'agent-builder-agent',\s*task\.id/
    );
  });

  it('no longer forwards builder needsInput through emitResult (dead-end path)', () => {
    expect(block).not.toMatch(/needsInput:\s*result\.needsInput\s*\|\|\s*null/);
  });

  it('safety timer is defused by the responded flag', () => {
    expect(block).toMatch(/let\s+responded\s*=\s*false/);
    expect(block).toMatch(/if\s*\(responded\)\s*return/);
    // Every user-visible delivery defuses the timer before emitting. The
    // one emitResult that must NOT set the flag is the safety timer's own
    // fallback emit, hence emitCount - 1.
    const emitCount = (block.match(/hudApi\.emitResult\(/g) || []).length;
    const respondedSets = (block.match(/responded\s*=\s*true/g) || []).length;
    expect(respondedSets, 'each delivery path must set responded').toBeGreaterThanOrEqual(emitCount - 1);
  });
});

describe('exchange-bridge auction config -- confidence floor opt-in', () => {
  it('sets auction.minWinnerConfidence to 0.5', () => {
    const cfgStart = BRIDGE_SOURCE.indexOf('const DEFAULT_EXCHANGE_CONFIG');
    expect(cfgStart).toBeGreaterThan(-1);
    const cfgBlock = BRIDGE_SOURCE.slice(cfgStart, cfgStart + 2500);
    expect(cfgBlock).toMatch(/minWinnerConfidence:\s*0\.5/);
  });
});
