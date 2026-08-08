/**
 * GsxApi tests (ADR-052).
 *
 * Standard conformance contract per Rule 12 + the error-class contract
 * per ADR-024, plus shape checks on the seed registry. Behavior of the
 * run/repair/eval loop is covered in `gsx-store.test.ts`; step
 * compilation in `gsx-runner.test.ts`; the LLM contract in
 * `gsx-repair.test.ts`.
 */

import { describe, it, expect } from 'vitest';

// Import directly from the conformance files (not the harness barrel)
// to avoid the @playwright/test dependency.
import { runApiConformanceContract } from '../harness/api-conformance.js';
import { runErrorConformanceContract } from '../harness/error-conformance.js';
import {
  getGsxApi,
  _resetGsxApiForTesting,
  _setGsxApiForTesting,
  GsxError,
  GSX_ERROR_CODES,
  GSX_SEED_SCRIPTS,
  type GsxApi,
  type GsxErrorCode,
} from '../../gsx/api.js';

// 1. API conformance contract.
runApiConformanceContract<GsxApi>({
  name: 'GsxApi',
  getInstance: getGsxApi,
  resetForTesting: _resetGsxApiForTesting,
  setForTesting: _setGsxApiForTesting,
  expectedMethods: [
    'openWindow',
    'closeWindow',
    'listWindows',
    'navigate',
    'snapshot',
    'listScripts',
    'getScript',
    'saveScript',
    'deleteScript',
    'runScript',
    'startRecording',
    'getRecording',
    'stopRecording',
    'cancelRecording',
    'stopRecordingAsAgent',
    'invokeAgent',
    'listAgents',
    'getAgent',
    'deleteAgent',
    'listRuns',
    'getRun',
    'getStats',
    'onEvent',
  ],
});

// 2. Error conformance contract.
runErrorConformanceContract<GsxError>({
  name: 'GsxError',
  ErrorClass: GsxError,
  codeEnum: GSX_ERROR_CODES,
  modulePrefix: 'GSX_',
  constructErrorWithCode: (code) =>
    new GsxError({
      code: code as GsxErrorCode,
      message: 'sample',
      context: { op: 'sample' },
      remediation: 'sample remediation',
    }),
});

// 3. Module-specific shape checks.
describe('GsxApi (default singleton)', () => {
  it('seed scripts are structurally valid and cover the core GSX surfaces', () => {
    const ids = GSX_SEED_SCRIPTS.map((s) => s.id);
    expect(ids).toContain('designer.open');
    expect(ids).toContain('flows.list');
    for (const seed of GSX_SEED_SCRIPTS) {
      expect(seed.source).toBe('seed');
      expect(seed.version).toBe(1);
      expect(seed.steps.length).toBeGreaterThan(0);
      // Every seed must self-evaluate: at least one assertion step.
      const hasAssertion = seed.steps.some((step) =>
        step.kind.startsWith('assert')
      );
      expect(hasAssertion, `seed ${seed.id} has no assertion`).toBe(true);
    }
  });

  it('listScripts on a fresh store returns the seeds', async () => {
    _resetGsxApiForTesting();
    const scripts = await getGsxApi().listScripts();
    expect(scripts.map((s) => s.id).sort()).toEqual(
      [...GSX_SEED_SCRIPTS.map((s) => s.id)].sort()
    );
  });

  it('window-touching methods before initGsx surface a structured GsxError', async () => {
    _resetGsxApiForTesting();
    await expect(getGsxApi().openWindow()).rejects.toMatchObject({
      name: 'GsxError',
      code: GSX_ERROR_CODES.WINDOW_NOT_FOUND,
    });
  });

  it('getScript on an unknown id throws GSX_SCRIPT_NOT_FOUND', async () => {
    _resetGsxApiForTesting();
    await expect(getGsxApi().getScript('nope.nothing')).rejects.toMatchObject({
      code: GSX_ERROR_CODES.SCRIPT_NOT_FOUND,
    });
  });

  it('seed scripts are read-only through the API', async () => {
    _resetGsxApiForTesting();
    const api = getGsxApi();
    const seed = GSX_SEED_SCRIPTS[0];
    if (seed === undefined) throw new Error('seed registry is empty');
    await expect(api.saveScript({ ...seed })).rejects.toMatchObject({
      code: GSX_ERROR_CODES.SEED_READ_ONLY,
    });
    await expect(api.deleteScript(seed.id)).rejects.toMatchObject({
      code: GSX_ERROR_CODES.SEED_READ_ONLY,
    });
  });
});
