/**
 * Onboarding state store: KV-backed checklist progress.
 *
 * Single blob in `lite-onboarding` / `default`. Atomic writes via
 * `lite/kv/api.ts`. Listener isolation matches the `lite/idw/store.ts`
 * pattern -- one bad listener doesn't stop the others from seeing
 * the change.
 *
 * @internal
 */

import { getKVApi } from '../kv/api.js';
import {
  ONBOARDING_STEP_IDS,
  type OnboardingState,
  type OnboardingStepId,
} from './types.js';

const KV_COLLECTION = 'lite-onboarding';
const KV_KEY = 'default';

export interface OnboardingStoreOptions {
  kvApi?: ReturnType<typeof getKVApi>;
  collection?: string;
  key?: string;
}

type ChangeListener = (state: OnboardingState) => void;

export class OnboardingStore {
  private readonly kvApi: ReturnType<typeof getKVApi>;
  private readonly collection: string;
  private readonly key: string;
  private readonly listeners = new Set<ChangeListener>();

  constructor(options: OnboardingStoreOptions = {}) {
    this.kvApi = options.kvApi ?? getKVApi();
    this.collection = options.collection ?? KV_COLLECTION;
    this.key = options.key ?? KV_KEY;
  }

  async load(): Promise<OnboardingState> {
    return this.readState();
  }

  /**
   * Mark a step complete. Idempotent -- repeated calls keep the
   * earliest completion timestamp. Returns the updated state.
   */
  async markComplete(stepId: OnboardingStepId): Promise<OnboardingState> {
    if (!isKnownStep(stepId)) {
      throw new Error(`Unknown onboarding step id: ${stepId}`);
    }
    const state = await this.readState();
    if (state.completedAt[stepId] !== undefined) {
      // Already done -- idempotent.
      return state;
    }
    state.completedAt[stepId] = new Date().toISOString();
    await this.writeState(state);
    return state;
  }

  /**
   * Dismiss the checklist (user clicked "I'll do this later" or
   * similar). The card hides; `markComplete` calls still work but
   * the card stays hidden.
   */
  async dismiss(): Promise<OnboardingState> {
    const state = await this.readState();
    state.dismissedAt = new Date().toISOString();
    await this.writeState(state);
    return state;
  }

  /**
   * Reset all progress + dismissal. Intended for tests + diagnostic
   * "reset onboarding" debug commands; not exposed to users today.
   */
  async reset(): Promise<OnboardingState> {
    const state: OnboardingState = {
      schemaVersion: 1,
      completedAt: {},
      dismissedAt: null,
    };
    await this.writeState(state);
    return state;
  }

  /** Subscribe to state changes. Returns an unsubscribe. */
  onChange(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    return (): void => {
      this.listeners.delete(listener);
    };
  }

  // ── internals ────────────────────────────────────────────────────────

  private async readState(): Promise<OnboardingState> {
    try {
      const v = await this.kvApi.get(this.collection, this.key);
      if (v === null || v === undefined || typeof v !== 'object') {
        return defaultState();
      }
      return normalizeState(v as Partial<OnboardingState>);
    } catch {
      return defaultState();
    }
  }

  private async writeState(state: OnboardingState): Promise<void> {
    await this.kvApi.set(this.collection, this.key, state);
    for (const listener of Array.from(this.listeners)) {
      try {
        listener({ ...state });
      } catch {
        // isolate throwing listeners -- one bad subscriber doesn't
        // block others.
      }
    }
  }
}

function defaultState(): OnboardingState {
  return {
    schemaVersion: 1,
    completedAt: {},
    dismissedAt: null,
  };
}

function normalizeState(v: Partial<OnboardingState>): OnboardingState {
  const completed: OnboardingState['completedAt'] = {};
  if (v.completedAt !== null && typeof v.completedAt === 'object') {
    for (const id of ONBOARDING_STEP_IDS) {
      const ts = (v.completedAt as Record<string, unknown>)[id];
      if (typeof ts === 'string' && ts.length > 0) {
        completed[id] = ts;
      }
    }
  }
  return {
    schemaVersion: 1,
    completedAt: completed,
    dismissedAt: typeof v.dismissedAt === 'string' ? v.dismissedAt : null,
  };
}

function isKnownStep(id: string): id is OnboardingStepId {
  return (ONBOARDING_STEP_IDS as readonly string[]).includes(id);
}
