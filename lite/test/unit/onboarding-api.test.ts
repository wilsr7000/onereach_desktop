/**
 * OnboardingApi conformance tests (Rule 12).
 *
 * The deeper behavior tests live in `onboarding-store.test.ts`;
 * this file just runs `runApiConformanceContract` against the
 * documented surface.
 */

import { describe, it, expect } from 'vitest';
import {
  getOnboardingApi,
  _resetOnboardingApiForTesting,
  _setOnboardingApiForTesting,
  buildOnboardingApi,
  type OnboardingApi,
} from '../../onboarding/api.js';
import { OnboardingStore } from '../../onboarding/store.js';
import { FakeKV } from '../harness/index.js';
import { runApiConformanceContract } from '../harness/api-conformance.js';

runApiConformanceContract<OnboardingApi>({
  name: 'OnboardingApi',
  getInstance: getOnboardingApi,
  resetForTesting: _resetOnboardingApiForTesting,
  setForTesting: _setOnboardingApiForTesting,
  expectedMethods: ['load', 'markComplete', 'dismiss', 'onChange'],
});

describe('OnboardingApi (buildOnboardingApi)', () => {
  it('roundtrips a markComplete via the singleton replacement', async () => {
    const fakeKV = new FakeKV();
    const customApi = buildOnboardingApi(new OnboardingStore({ kvApi: fakeKV }));
    _setOnboardingApiForTesting(customApi);
    try {
      const before = await getOnboardingApi().load();
      expect(Object.keys(before.completedAt)).toEqual([]);
      await getOnboardingApi().markComplete('signed-in');
      const after = await getOnboardingApi().load();
      expect(after.completedAt['signed-in']).toBeDefined();
    } finally {
      _resetOnboardingApiForTesting();
    }
  });
});
