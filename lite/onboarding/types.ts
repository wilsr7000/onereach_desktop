/**
 * Onboarding -- types.
 *
 * Tracks which "first-run" steps the user has completed so the
 * checklist card on the home view can hide itself once everything
 * is done. Also stores a `dismissed` flag so the user can opt out
 * before completing every step.
 */

/**
 * Stable IDs for each step. New steps append; existing IDs never change.
 *
 * `openai-key-set` was a transient step from the AI/TTS chunk that
 * was pulled. The id stays out of this union so the type system
 * catches stale references; persisted state for that id (if any
 * survived from an old install) is harmlessly ignored by
 * `normalizeState`.
 */
export const ONBOARDING_STEP_IDS = [
  'signed-in',
  'two-factor-saved',
  'first-agent-opened',
] as const;

export type OnboardingStepId = (typeof ONBOARDING_STEP_IDS)[number];

/**
 * Persisted KV blob. One per device (no per-account split today --
 * if the same machine has two GSX accounts, the checklist applies
 * to "this Lite install" rather than "this account").
 */
export interface OnboardingState {
  schemaVersion: 1;
  /** Map of step id -> ISO timestamp at completion. Missing = not done. */
  completedAt: Partial<Record<OnboardingStepId, string>>;
  /** When the user explicitly dismissed the card. Null if still showing. */
  dismissedAt: string | null;
}

export const ONBOARDING_MODULE_VERSION = 1 as const;
