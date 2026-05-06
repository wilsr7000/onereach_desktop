/**
 * Onboarding store + api tests.
 *
 * Verifies persistence, idempotent markComplete, dismiss / reset,
 * and listener notification (with isolation -- one bad listener
 * doesn't stop the others).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { OnboardingStore } from '../../onboarding/store.js';
import {
  buildOnboardingApi,
  ONBOARDING_STEP_IDS,
  type OnboardingApi,
} from '../../onboarding/api.js';
import { FakeKV } from '../harness/index.js';

function makeStore(): OnboardingStore {
  return new OnboardingStore({ kvApi: new FakeKV() });
}

describe('OnboardingStore', () => {
  let store: OnboardingStore;
  beforeEach(() => {
    store = makeStore();
  });

  it('default state has no completedAt entries and no dismissal', async () => {
    const state = await store.load();
    expect(state.schemaVersion).toBe(1);
    expect(Object.keys(state.completedAt)).toEqual([]);
    expect(state.dismissedAt).toBeNull();
  });

  it('markComplete sets the timestamp', async () => {
    const state = await store.markComplete('signed-in');
    expect(state.completedAt['signed-in']).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('markComplete is idempotent (preserves earliest timestamp)', async () => {
    const first = await store.markComplete('signed-in');
    const ts1 = first.completedAt['signed-in'];
    expect(ts1).toBeDefined();
    // Sleep so a re-mark would record a different timestamp if not idempotent.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await store.markComplete('signed-in');
    expect(second.completedAt['signed-in']).toBe(ts1);
  });

  it('markComplete throws on unknown step id', async () => {
    await expect(store.markComplete('does-not-exist' as unknown as 'signed-in')).rejects.toThrow(
      /Unknown onboarding step id/
    );
  });

  it('dismiss sets dismissedAt', async () => {
    const state = await store.dismiss();
    expect(state.dismissedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('reset clears all completedAt and dismissedAt', async () => {
    await store.markComplete('signed-in');
    await store.markComplete('two-factor-saved');
    await store.dismiss();
    const cleared = await store.reset();
    expect(Object.keys(cleared.completedAt)).toEqual([]);
    expect(cleared.dismissedAt).toBeNull();
  });

  it('persists across new store instances backed by the same KV', async () => {
    const kvApi = new FakeKV();
    const a = new OnboardingStore({ kvApi });
    await a.markComplete('signed-in');
    const b = new OnboardingStore({ kvApi });
    const state = await b.load();
    expect(state.completedAt['signed-in']).toBeDefined();
  });

  it('onChange notifies listeners on writes; isolates throwing listeners', async () => {
    const calls: Array<string[]> = [];
    const unsub1 = store.onChange(() => {
      throw new Error('first listener throws');
    });
    const unsub2 = store.onChange((s) => calls.push(Object.keys(s.completedAt)));
    await store.markComplete('signed-in');
    expect(calls.length).toBe(1);
    expect(calls[0]).toEqual(['signed-in']);
    unsub1();
    unsub2();
  });

  it('onChange unsubscribe stops further notifications', async () => {
    const calls: Array<string[]> = [];
    const unsub = store.onChange((s) => calls.push(Object.keys(s.completedAt)));
    await store.markComplete('signed-in');
    unsub();
    await store.markComplete('two-factor-saved');
    expect(calls.length).toBe(1);
  });
});

describe('OnboardingApi (buildOnboardingApi)', () => {
  let api: OnboardingApi;
  beforeEach(() => {
    api = buildOnboardingApi(makeStore());
  });

  it('exposes the documented surface', () => {
    expect(typeof api.load).toBe('function');
    expect(typeof api.markComplete).toBe('function');
    expect(typeof api.dismiss).toBe('function');
    expect(typeof api.onChange).toBe('function');
  });

  it('every step id in ONBOARDING_STEP_IDS is markable', async () => {
    for (const id of ONBOARDING_STEP_IDS) {
      await api.markComplete(id);
    }
    const state = await api.load();
    for (const id of ONBOARDING_STEP_IDS) {
      expect(state.completedAt[id]).toBeDefined();
    }
  });
});
