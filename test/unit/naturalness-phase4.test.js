/**
 * Naturalness Phase 4 Scenarios
 *
 * Runs every JSON fixture under test/fixtures/voice-scenarios/p4-barge
 * with a fresh phase4 pipeline simulator (clean detector, clean clock)
 * per scenario. Covers stop / command / ack / echo / cooldown /
 * grace-window cases.
 *
 * Run:
 *   npx vitest run test/unit/naturalness-phase4.test.js
 *   npm run test:voice-scenarios
 */

import { describe, it, expect } from 'vitest';

const {
  listScenarios,
  loadScenario,
  runScenario,
} = require('../harness/scenario-runner');
const { makePhase4Sim } = require('../harness/phase4-sim');

const SCENARIO_FILTER = process.env.SCENARIO;

const scenarios =
  SCENARIO_FILTER && SCENARIO_FILTER.startsWith('p4-barge/')
    ? [{ path: SCENARIO_FILTER, scenario: loadScenario(SCENARIO_FILTER) }]
    : SCENARIO_FILTER
      ? []
      : listScenarios('p4-barge');

describe('naturalness phase 4 - barge-in', () => {
  if (scenarios.length === 0) {
    it.skip('no p4-barge scenarios selected', () => {});
    return;
  }

  for (const { path: relPath, scenario } of scenarios) {
    it(`${relPath} - ${scenario.description}`, async () => {
      const sim = makePhase4Sim();
      const result = await runScenario(scenario, { hooks: sim.hooks });

      if (!result.pass) {
        const failed = result.results
          .filter((r) => !r.pass)
          .map((r) => `  step #${r.index} (${r.step.type}): ${r.reason}`)
          .join('\n');
        expect
          .soft(result.pass, `scenario "${scenario.name}" failed:\n${failed}`)
          .toBe(true);
      }

      expect(result.pass).toBe(true);
    });
  }
});
