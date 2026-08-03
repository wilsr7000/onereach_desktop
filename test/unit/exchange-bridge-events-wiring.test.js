/**
 * Exchange Bridge -- manage-events wiring invariants.
 *
 * Behavior is tested in ensure-event-agent.test.js / events-store.test.js /
 * events-tools-and-app.test.js; this pins only the bridge wiring (source
 * invariants, same pattern as exchange-bridge-self-heal.test.js).
 */

import { describe, it, expect } from 'vitest';
const fs = require('fs');
const path = require('path');

const BRIDGE_SOURCE = fs.readFileSync(
  path.join(__dirname, '../../src/voice-task-sdk/exchange-bridge.js'),
  'utf8'
);

describe('exchange-bridge -- Event Manager seeding', () => {
  it('seeds the playbook-backed Event Manager agent at init', () => {
    expect(BRIDGE_SOURCE).toMatch(/require\('\.\.\/\.\.\/lib\/events\/ensure-event-agent'\)/);
    expect(BRIDGE_SOURCE).toMatch(/await ensureEventManagerAgent\(\)/);
  });

  it('seeds AFTER connectCustomAgents so hot-connect connects the fresh agent exactly once', () => {
    const initIdx = BRIDGE_SOURCE.indexOf('CONNECT ALL AGENTS TO EXCHANGE');
    expect(initIdx).toBeGreaterThan(-1);
    const connectIdx = BRIDGE_SOURCE.indexOf('await connectCustomAgents(', initIdx);
    const seedIdx = BRIDGE_SOURCE.indexOf('ensureEventManagerAgent', initIdx);
    expect(connectIdx).toBeGreaterThan(-1);
    expect(seedIdx).toBeGreaterThan(connectIdx);
  });

  it('seeding is wrapped so a failure cannot abort exchange init', () => {
    const seedIdx = BRIDGE_SOURCE.indexOf('ensureEventManagerAgent');
    const around = BRIDGE_SOURCE.slice(seedIdx - 600, seedIdx + 600);
    expect(around).toMatch(/try\s*\{/);
    expect(around).toMatch(/non-fatal/i);
  });
});
