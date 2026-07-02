/**
 * hud-api emitNeedsInput — forwards the `proactive` bit so the voice relay can
 * surface a background agent's needsInput even from a self-prompting tool.
 * Completes the ADR-EX-004 proactive contract end-to-end (relay-core already
 * consumes request.proactive in shouldSurfaceNeedsInput).
 *
 * Run: npx vitest run test/unit/hud-api-needs-input-proactive.test.js
 */

import { describe, it, expect } from 'vitest';

const hudApi = require('../../lib/hud-api');
const { shouldSurfaceNeedsInput } = require('../../lib/exchange/relay-core');

describe('emitNeedsInput proactive forwarding', () => {
  it('includes proactive:true when requested', () => {
    const r = hudApi.emitNeedsInput({ taskId: 'p1', prompt: 'Approve?', agentId: 'meeting-monitor', proactive: true });
    expect(r.proactive).toBe(true);
  });

  it('defaults proactive to false', () => {
    const r = hudApi.emitNeedsInput({ taskId: 'p2', prompt: 'Which?', agentId: 'a1' });
    expect(r.proactive).toBe(false);
  });

  it('coerces a truthy value to a boolean', () => {
    const r = hudApi.emitNeedsInput({ taskId: 'p3', prompt: 'x', agentId: 'a1', proactive: 1 });
    expect(r.proactive).toBe(true);
  });

  it('the forwarded flag drives the relay decision even from a self-prompting tool', () => {
    // A proactive request whose owning tool would normally be deferred to
    // (command-hud) must still be surfaced by the voice relay.
    const req = hudApi.emitNeedsInput({
      taskId: 'p4',
      prompt: 'Decision needed',
      agentId: 'critical-meeting-alarm-agent',
      proactive: true,
    });
    expect(shouldSurfaceNeedsInput({ toolId: 'command-hud', proactive: req.proactive })).toBe(true);
  });
});
