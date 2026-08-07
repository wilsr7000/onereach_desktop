/**
 * TelemetryApi conformance (Rule 12) + the uninitialized posture.
 *
 * The uninitialized default is load-bearing for consent: a caller
 * racing boot must see `unset` and must not be able to record a grant
 * against a module that has nowhere to persist it. Inert-until-wired
 * is the safe failure mode for a privacy surface.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  getTelemetryApi,
  _resetTelemetryApiForTesting,
  _setTelemetryApiForTesting,
  type TelemetryApi,
} from '../../telemetry/api.js';
import { runApiConformanceContract } from '../harness/conformance.js';

runApiConformanceContract<TelemetryApi>({
  name: 'TelemetryApi',
  getInstance: getTelemetryApi,
  resetForTesting: _resetTelemetryApiForTesting,
  setForTesting: _setTelemetryApiForTesting,
  expectedMethods: ['getStatus', 'setConsent', 'promptIfNeeded'],
});

describe('uninitialized posture — inert is the safe failure mode', () => {
  beforeEach(() => {
    _resetTelemetryApiForTesting();
  });

  it('reports unset consent, never a default grant', () => {
    expect(getTelemetryApi().getStatus().consent.state).toBe('unset');
  });

  it('ignores a consent decision it has nowhere to persist', () => {
    const after = getTelemetryApi().setConsent('granted');
    expect(after.consent.state, 'an unwired module must not mint a grant').toBe('unset');
  });

  it('resolves promptIfNeeded without prompting', async () => {
    await expect(getTelemetryApi().promptIfNeeded(null)).resolves.toBeUndefined();
  });
});
