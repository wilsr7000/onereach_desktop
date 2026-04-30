/**
 * Naturalness Phase 3 Scenarios
 *
 * Runs every JSON fixture under test/fixtures/voice-scenarios/p3-pause
 * with a fresh phase3 pipeline simulator. Scenarios that touch the
 * LLM classifier declare their expected responses via a top-level
 * `llm` array in the fixture JSON; the sim consumes them in order.
 *
 * Run:
 *   npx vitest run test/unit/naturalness-phase3.test.js
 *   npm run test:voice-scenarios
 */

import { describe, it, expect } from 'vitest';

const {
  listScenarios,
  loadScenario,
  runScenario,
} = require('../harness/scenario-runner');
const { makePhase3Sim } = require('../harness/phase3-sim');

const SCENARIO_FILTER = process.env.SCENARIO;

const scenarios =
  SCENARIO_FILTER && SCENARIO_FILTER.startsWith('p3-pause/')
    ? [{ path: SCENARIO_FILTER, scenario: loadScenario(SCENARIO_FILTER) }]
    : SCENARIO_FILTER
      ? []
      : listScenarios('p3-pause');

describe('naturalness phase 3 - pause detection', () => {
  if (scenarios.length === 0) {
    it.skip('no p3-pause scenarios selected', () => {});
    return;
  }

  for (const { path: relPath, scenario } of scenarios) {
    it(`${relPath} - ${scenario.description}`, async () => {
      const sim = makePhase3Sim({
        llmResponses: Array.isArray(scenario.llm) ? scenario.llm : [],
      });

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
