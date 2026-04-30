/**
 * Naturalness Phase 1 Scenarios
 *
 * Runs every JSON fixture under test/fixtures/voice-scenarios/p1-confirmation
 * through the scenario runner with the Phase 1 pipeline simulator hook
 * registered. These scenarios cover the calibratedConfirmation feature:
 * ack vs confirm vs silent dispatch across stakes and confidence bands.
 *
 * Run:
 *   npx vitest run test/unit/naturalness-phase1.test.js
 *   npm run test:voice-scenarios
 *
 * Focus a single fixture:
 *   SCENARIO=p1-confirmation/03-high-stakes-always-confirms \
 *     npx vitest run test/unit/naturalness-phase1.test.js
 */

import { describe, it, expect } from 'vitest';

const {
  listScenarios,
  loadScenario,
  runScenario,
} = require('../harness/scenario-runner');
const { pipelineSim } = require('../harness/phase1-sim');

const SCENARIO_FILTER = process.env.SCENARIO;

const scenarios =
  SCENARIO_FILTER && SCENARIO_FILTER.startsWith('p1-confirmation/')
    ? [{ path: SCENARIO_FILTER, scenario: loadScenario(SCENARIO_FILTER) }]
    : SCENARIO_FILTER
      ? [] // user asked for a non-p1 fixture; skip this suite
      : listScenarios('p1-confirmation');

describe('naturalness phase 1 - calibrated confirmation', () => {
  if (scenarios.length === 0) {
    it.skip('no p1-confirmation scenarios selected', () => {});
    return;
  }

  for (const { path: relPath, scenario } of scenarios) {
    it(`${relPath} - ${scenario.description}`, async () => {
      const result = await runScenario(scenario, {
        hooks: { pipelineSim },
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
