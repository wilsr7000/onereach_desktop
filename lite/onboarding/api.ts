/**
 * Onboarding module -- PUBLIC API.
 *
 * Per ADR-019 / Rule 11, only this file is importable from other
 * lite modules. The chrome view consumes via
 * `getOnboardingApi().load()` (main-process direct) or
 * `window.lite.onboarding.*` (renderer via preload bridge).
 *
 * v1 surface is intentionally tiny: a 4-step checklist + a
 * dismiss flag. Rendering lives in the chrome (`chrome.ts`); this
 * module only owns persistence + subscribers.
 */

import { OnboardingStore } from './store.js';
import type { OnboardingState, OnboardingStepId } from './types.js';

export type {
  OnboardingState,
  OnboardingStepId,
} from './types.js';
export {
  ONBOARDING_STEP_IDS,
  ONBOARDING_MODULE_VERSION,
} from './types.js';

export interface OnboardingApi {
  /** Read current state. */
  load(): Promise<OnboardingState>;
  /** Mark a step complete. Idempotent. */
  markComplete(stepId: OnboardingStepId): Promise<OnboardingState>;
  /** User dismissed the card. */
  dismiss(): Promise<OnboardingState>;
  /** Subscribe to state changes. Returns an unsubscribe. */
  onChange(listener: (state: OnboardingState) => void): () => void;
}

let _instance: OnboardingApi | null = null;

export function getOnboardingApi(): OnboardingApi {
  if (_instance === null) {
    _instance = buildDefaultApi();
  }
  return _instance;
}

export function _resetOnboardingApiForTesting(): void {
  _instance = null;
}

export function _setOnboardingApiForTesting(api: OnboardingApi): void {
  _instance = api;
}

export function buildOnboardingApi(store: OnboardingStore): OnboardingApi {
  return {
    load: () => store.load(),
    markComplete: (id) => store.markComplete(id),
    dismiss: () => store.dismiss(),
    onChange: (listener) => store.onChange(listener),
  };
}

function buildDefaultApi(): OnboardingApi {
  return buildOnboardingApi(new OnboardingStore());
}
