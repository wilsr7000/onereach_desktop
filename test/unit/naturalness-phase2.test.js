/**
 * Naturalness Phase 2 Scenarios
 *
 * Runs every JSON fixture under test/fixtures/voice-scenarios/p2-personality
 * through the scenario runner with a fresh Phase 2 pipeline simulator
 * per scenario. Covers both personality modes (multi-voice + single-
 * voice Cap Chew) and the multi-voice handoff bridge.
 *
 * Run:
 *   npx vitest run test/unit/naturalness-phase2.test.js
 *   npm run test:voice-scenarios
 */

import { describe, it, expect } from 'vitest';

const {
  listScenarios,
  loadScenario,
  runScenario,
} = require('../harness/scenario-runner');
const { makePhase2Sim } = require('../harness/phase2-sim');

const SCENARIO_FILTER = process.env.SCENARIO;

const scenarios =
  SCENARIO_FILTER && SCENARIO_FILTER.startsWith('p2-personality/')
    ? [{ path: SCENARIO_FILTER, scenario: loadScenario(SCENARIO_FILTER) }]
    : SCENARIO_FILTER
      ? []
      : listScenarios('p2-personality');

describe('naturalness phase 2 - personality and handoffs', () => {
  if (scenarios.length === 0) {
    it.skip('no p2-personality scenarios selected', () => {});
    return;
  }

  for (const { path: relPath, scenario } of scenarios) {
    it(`${relPath} - ${scenario.description}`, async () => {
      // Each scenario gets its own sim instance so the tracker state
      // never leaks between fixtures.
      const sim = makePhase2Sim();
      const result = await runScenario(scenario, {
        hooks: { agentTurn: sim.agentTurn },
      });

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
