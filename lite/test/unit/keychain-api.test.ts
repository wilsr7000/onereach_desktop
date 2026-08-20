/**
 * KeychainApi conformance (Rule 12, ADR-075).
 *
 * Shape only — the traffic-control BEHAVIOR (tracking, draining, the
 * require-site inventory, the quit wiring) lives in
 * `keychain-quiesce.test.ts`. This file pins the singleton contract and
 * that the singleton is a live view over the real registry, not a copy.
 */

import { describe, it, expect } from 'vitest';
import { runApiConformanceContract } from '../harness/api-conformance.js';
import {
  getKeychainApi,
  _resetKeychainApiForTesting,
  _setKeychainApiForTesting,
  trackKeychainCall,
  pendingKeychainCalls,
  type KeychainApi,
} from '../../keychain/api.js';

// 1. Conformance contract.
runApiConformanceContract<KeychainApi>({
  name: 'KeychainApi',
  getInstance: getKeychainApi,
  resetForTesting: _resetKeychainApiForTesting,
  setForTesting: _setKeychainApiForTesting,
  expectedMethods: ['trackCall', 'trackBackend', 'pendingCalls', 'drain'],
});

// 2. The singleton is the SAME registry as the module functions.
describe('KeychainApi (default singleton)', () => {
  it('sees calls tracked through the plain functions', async () => {
    _resetKeychainApiForTesting();
    let release!: () => void;
    const call = new Promise<void>((r) => {
      release = r;
    });
    trackKeychainCall(call);
    // One registry: the singleton counts what the function tracked.
    expect(getKeychainApi().pendingCalls()).toBe(1);
    expect(pendingKeychainCalls()).toBe(1);
    release();
    expect(await getKeychainApi().drain(500)).toEqual({ drained: true, remaining: 0 });
  });
});
