/**
 * Naturalness Baseline Scenarios
 *
 * Runs every JSON fixture under test/fixtures/voice-scenarios/baseline
 * through the scenario runner. These scenarios encode the current
 * expected behavior -- breaking one without explicitly bumping the
 * fixture is a regression.
 *
 * Run:
 *   npx vitest run test/unit/naturalness-baseline.test.js
 *   npm run test:voice-scenarios
 *
 * Focus a single fixture:
 *   SCENARIO=baseline/01-tts-capture npx vitest run test/unit/naturalness-baseline.test.js
 */

import { describe, it, expect } from 'vitest';

const { listScenarios, loadScenario, runScenario } = require('../harness/scenario-runner');

const SCENARIO_FILTER = process.env.SCENARIO;

const scenarios = SCENARIO_FILTER
  ? [{ path: SCENARIO_FILTER, scenario: loadScenario(SCENARIO_FILTER) }]
  : listScenarios('baseline');

describe('naturalness baseline scenarios', () => {
  if (scenarios.length === 0) {
    it.skip('no scenarios found -- check SCENARIO env var or fixtures dir', () => {});
    return;
  }

  for (const { path: relPath, scenario } of scenarios) {
    it(`${relPath} - ${scenario.description}`, async () => {
      const result = await runScenario(scenario);

      if (!result.pass) {
        // Print per-step failures to make vitest output actionable.
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
