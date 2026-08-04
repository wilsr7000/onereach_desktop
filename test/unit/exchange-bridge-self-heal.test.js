/**
 * Exchange Bridge -- self-healing loop wiring invariants.
 *
 * The DECISIONS are tested behaviorally in self-heal.test.js,
 * agent-builder-selfheal.test.js, dynamic-agent-wrap.test.js, and
 * claude-code-agent-builder.test.js. This file pins only the bridge WIRING
 * (source-level invariants, same pattern as
 * exchange-halt-capability-offer.test.js -- vitest CJS mock semantics don't
 * compose with this module):
 *
 *   1. The self-heal notifier subscribes to error-level central log events
 *      and routes rebuild offers through handleNeedsInput with the builder
 *      as the pending agent (proactive).
 *   2. hotConnectAgent hot-wraps servable config-only agents instead of
 *      refusing them, and still refuses (loudly, with the event marker the
 *      notifier listens for) when the config has nothing to serve from.
 *   3. connectLocalAgent wraps BEFORE contract validation so a servable
 *      config never false-alarms an agent:contract-violation.
 */

import { describe, it, expect } from 'vitest';
const fs = require('fs');
const path = require('path');

const BRIDGE_SOURCE = fs.readFileSync(
  path.join(__dirname, '../../src/voice-task-sdk/exchange-bridge.js'),
  'utf8'
);

function extractBlock(startMarker, endMarker) {
  const start = BRIDGE_SOURCE.indexOf(startMarker);
  expect(start, `${startMarker} must exist`).toBeGreaterThan(-1);
  const end = BRIDGE_SOURCE.indexOf(endMarker, start);
  expect(end, `${endMarker} must follow ${startMarker}`).toBeGreaterThan(start);
  return BRIDGE_SOURCE.slice(start, end);
}

describe('exchange-bridge -- self-heal notifier wiring', () => {
  const block = extractBlock("require('../../lib/exchange/self-heal')", 'Self-heal notifier unavailable');

  it('creates the notifier from lib/exchange/self-heal', () => {
    expect(block).toMatch(/createSelfHealNotifier\(\{/);
  });

  it('subscribes to error-level entries on the central log queue', () => {
    expect(block).toMatch(/log\.subscribe\(\{\s*level:\s*'error'\s*\},\s*handler\)/);
  });

  it('resolves broken agents against the agent-store (id first, then name)', () => {
    expect(block).toMatch(/getAgentStore/);
    expect(block).toMatch(/store\.getAgent\(agentId\)/);
    expect(block).toMatch(/getLocalAgents\(\)/);
  });

  it('defers offers while another agent awaits input (transcript-service pending check)', () => {
    expect(block).toMatch(/getTranscriptService\(\)\.hasPending\(\)/);
  });

  it('routes the offer through handleNeedsInput with the builder as pending agent, proactively', () => {
    expect(block).toMatch(
      /handleNeedsInput\(offerResult,\s*'agent-builder-agent',[\s\S]*?proactive:\s*true/
    );
    expect(block).toMatch(/needsInput:\s*\{\s*prompt,\s*agentId:\s*'agent-builder-agent',\s*context:\s*\{\s*pendingBuild\s*\}/);
  });
});

describe('exchange-bridge -- hotConnectAgent hot-wrap', () => {
  const block = extractBlock('async function hotConnectAgent(agent)', '// ==================== AGENT HEALTH CHECK');

  it('attempts a hot-wrap before refusing a config-only agent', () => {
    const wrapIdx = block.indexOf('wrapLocalConfigAgent(agent)');
    const refuseIdx = block.indexOf("event: 'agent:hot-connect-refused'");
    expect(wrapIdx).toBeGreaterThan(-1);
    expect(refuseIdx).toBeGreaterThan(-1);
    expect(wrapIdx).toBeLessThan(refuseIdx);
  });

  it('keeps the loud refusal (with the event marker the self-heal notifier consumes) for unservable configs', () => {
    expect(block).toMatch(/log\.error\([\s\S]*?event:\s*'agent:hot-connect-refused'/);
  });

  it('connects the WRAPPED agent when the wrap succeeds', () => {
    expect(block).toMatch(/agent\s*=\s*wrapped/);
  });
});

describe('exchange-bridge -- wrapLocalConfigAgent + connectLocalAgent', () => {
  const wrapBlock = extractBlock('function wrapLocalConfigAgent(agentDef)', 'async function connectLocalAgent');
  const connectBlock = extractBlock('async function connectLocalAgent(agent, port)', "ws.on('open'");

  it('the wrapper serves the config through executeLocalAgent', () => {
    expect(wrapBlock).toMatch(/wrapped\.execute\s*=\s*\(task,\s*ctx\s*=\s*\{\}\)\s*=>\s*executeLocalAgent\(wrapped,\s*task,\s*ctx\)/);
  });

  it('the wrapper refuses configs with no prompt/systemPrompt/description', () => {
    expect(wrapBlock).toMatch(/prompt\s*\|\|\s*agentDef\.systemPrompt\s*\|\|\s*agentDef\.description/);
    expect(wrapBlock).toMatch(/return null/);
  });

  it('the wrapper announces itself with the agent:hot-wrapped event marker', () => {
    expect(wrapBlock).toMatch(/event:\s*'agent:hot-wrapped'/);
  });

  it('connectLocalAgent wraps BEFORE validateAgentContract (no false contract violations)', () => {
    const wrapIdx = connectBlock.indexOf('wrapLocalConfigAgent(agent)');
    const validateIdx = connectBlock.indexOf('validateAgentContract(agent)');
    expect(wrapIdx).toBeGreaterThan(-1);
    expect(validateIdx).toBeGreaterThan(-1);
    expect(wrapIdx).toBeLessThan(validateIdx);
  });
});

describe('agent-middleware -- contract-violation event marker stays stable', () => {
  // The self-heal notifier keys off this exact event name; if it drifts,
  // broken agents silently stop generating rebuild offers.
  const MIDDLEWARE_SOURCE = fs.readFileSync(
    path.join(__dirname, '../../packages/agents/agent-middleware.js'),
    'utf8'
  );

  it('emits agent:contract-violation with agentId + agentName at error level', () => {
    const idx = MIDDLEWARE_SOURCE.indexOf("event: 'agent:contract-violation'");
    expect(idx).toBeGreaterThan(-1);
    const around = MIDDLEWARE_SOURCE.slice(Math.max(0, idx - 400), idx + 400);
    expect(around).toMatch(/log\.error\(/);
    expect(around).toMatch(/agentId:/);
    expect(around).toMatch(/agentName:/);
  });
});
