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
import { getLoggingApi } from '../logging/api.js';
import { ONBOARDING_EVENTS } from './events.js';
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
  /**
   * Returns the active accountId or `null` when signed out. Wired by
   * `lite/onboarding/api.ts` to `getAuthApi().getSession('edison')`.
   * Without it the in-memory cache never resets across user
   * switches, leaking one user's checklist progress to the next.
   */
  getActiveAccountId?: () => string | null;
}

type ChangeListener = (state: OnboardingState) => void;

export class OnboardingStore {
  private readonly kvApi: ReturnType<typeof getKVApi>;
  private readonly collection: string;
  private readonly key: string;
  private readonly listeners = new Set<ChangeListener>();
  private readonly getActiveAccountId: (() => string | null) | null;
  private cache: OnboardingState | null = null;
  private cachedForAccountId: string | null | undefined = undefined;

  constructor(options: OnboardingStoreOptions = {}) {
    this.kvApi = options.kvApi ?? getKVApi();
    this.collection = options.collection ?? KV_COLLECTION;
    this.key = options.key ?? KV_KEY;
    this.getActiveAccountId = options.getActiveAccountId ?? null;
  }

  /** Drop the cache so the next read goes to KV. Idempotent. */
  invalidateCache(): void {
    this.cache = null;
    this.cachedForAccountId = undefined;
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
    getLoggingApi().event(ONBOARDING_EVENTS.STEP_COMPLETED, { stepId });
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
    getLoggingApi().event(ONBOARDING_EVENTS.DISMISSED);
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

  private currentAccountId(): string | null {
    if (this.getActiveAccountId === null) return '__legacy__';
    const accountId = this.getActiveAccountId();
    if (typeof accountId !== 'string' || accountId.length === 0) return null;
    return accountId;
  }

  private async readState(): Promise<OnboardingState> {
    const accountId = this.currentAccountId();
    if (accountId === null) {
      // Signed-out: don't read from KV, don't cache. Each fresh call
      // returns defaults so the home view paints a clean checklist
      // when the user signs in. Otherwise the previous user's
      // completedAt map would survive in cache until the next
      // explicit invalidation.
      return defaultState();
    }
    if (this.cache !== null && this.cachedForAccountId === accountId) {
      return this.cache;
    }
    try {
      const v = await this.kvApi.get(this.collection, this.key);
      if (v === null || v === undefined) {
        this.cache = defaultState();
        this.cachedForAccountId = accountId;
        return this.cache;
      }
      if (typeof v !== 'object' || Array.isArray(v)) {
        // Self-heal: overwrite the corrupt blob with a fresh empty
        // record so the bad shape can't survive another launch.
        // Same pattern as main-window / idw / tools.
        const actualType = Array.isArray(v) ? 'array' : typeof v;
        try {
          getLoggingApi().warn(
            'onboarding',
            'onboarding-store: unexpected KV blob shape, resetting in-memory',
            { actualType }
          );
          getLoggingApi().event(ONBOARDING_EVENTS.SELF_HEAL, { actualType });
        } catch {
          /* best-effort */
        }
        const fresh = defaultState();
        void this.kvApi.set(this.collection, this.key, fresh).catch((err) => {
          try {
            getLoggingApi().warn('onboarding', 'onboarding-store: self-heal write failed', {
              error: (err as Error).message,
            });
          } catch {
            /* best-effort */
          }
        });
        this.cache = fresh;
        this.cachedForAccountId = accountId;
        return this.cache;
      }
      const normalized = normalizeState(v as Partial<OnboardingState>);
      this.cache = normalized;
      this.cachedForAccountId = accountId;
      return normalized;
    } catch (err) {
      // KV read failure: surface at warn level rather than swallow
      // silently. We still return defaults so the UI keeps working,
      // but operators have a chance to see why.
      try {
        getLoggingApi().warn('onboarding', 'onboarding-store: KV read failed, returning defaults', {
          error: (err as Error).message,
        });
      } catch {
        /* best-effort */
      }
      return defaultState();
    }
  }

  private async writeState(state: OnboardingState): Promise<void> {
    const accountId = this.currentAccountId();
    if (accountId === null) {
      throw new Error('Cannot save onboarding state while signed out.');
    }
    await this.kvApi.set(this.collection, this.key, state);
    this.cache = state;
    this.cachedForAccountId = accountId;
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
