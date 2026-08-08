/**
 * GSX automation module -- shared types.
 *
 * The domain model for driving GSX windows (Designer, Flows, any
 * studio.<env>.onereach.ai surface) from scripts:
 *
 *   - A {@link GsxScript} is a serializable list of deterministic
 *     {@link GsxScriptStep}s (navigate / wait / click / fill / assert).
 *   - Running a script produces a {@link GsxRunRecord} with a graded
 *     {@link GsxRunVerdict} -- the unit of the evaluation feedback loop.
 *   - When a run fails, the repair path snapshots the page
 *     ({@link GsxPageSnapshot}), asks the AI module to correct the
 *     steps, and re-runs. A repaired script that passes is saved as a
 *     `learned` variant; repeated failures invalidate it back to the
 *     `seed` (see {@link GsxScriptStats}).
 *
 * Everything here is JSON-serializable so scripts and run records can
 * cross the IPC bridge and persist to disk unchanged.
 *
 * @internal -- consumers import these via `./api.ts` re-exports.
 */

import type { Environment } from '../auth/types.js';

/** Where a script came from -- drives trust + invalidation policy. */
export type GsxScriptSource = 'seed' | 'learned';

/**
 * One deterministic action inside a script. Selector-bearing steps
 * accept an optional `textFallback` (exact-ish visible-text match) so a
 * selector drifting under a GSX redeploy doesn't immediately kill the
 * script -- mirrors the selector-then-text idiom in
 * `lite/auth/sso-skip.ts`.
 *
 * `{param}` placeholders in `url` / `selector` / `value` / `pattern`
 * are substituted from the run's `params` (plus the built-ins
 * `{accountId}` and `{env}`) before compilation.
 */
export type GsxScriptStep =
  | {
      /** Load a URL in the target window. */
      kind: 'navigate';
      url: string;
    }
  | {
      /** Wait for a selector to appear (poll + timeout). */
      kind: 'waitFor';
      selector: string;
      timeoutMs?: number;
    }
  | {
      /** Click the first match of `selector`, else an element whose
       *  trimmed text matches one of `textFallback`. */
      kind: 'click';
      selector: string;
      textFallback?: string[];
      timeoutMs?: number;
    }
  | {
      /** Set an input/textarea value (React-safe: dispatches input +
       *  change events). */
      kind: 'fill';
      selector: string;
      value: string;
      timeoutMs?: number;
    }
  | {
      /** Assert a selector is present and visible. Failing this grades
       *  the run `fail` (not `error`). */
      kind: 'assertVisible';
      selector: string;
      /** Human description used in run records + repair prompts. */
      description?: string;
      timeoutMs?: number;
    }
  | {
      /** Assert the window's current URL matches a regex pattern. */
      kind: 'assertUrl';
      pattern: string;
      description?: string;
    }
  | {
      /** Assert an element's visible text contains `text`. */
      kind: 'assertText';
      selector: string;
      text: string;
      description?: string;
      timeoutMs?: number;
    }
  | {
      /** Unconditional pause (SPA settle). Use sparingly -- prefer waitFor. */
      kind: 'wait';
      ms: number;
    };

/** The step kinds that are assertions (grade the run, never throw). */
export const GSX_ASSERTION_KINDS = ['assertVisible', 'assertUrl', 'assertText'] as const;

/** A named, versioned, serializable automation script. */
export interface GsxScript {
  /** Stable id, e.g. `designer.open`. Learned variants keep the id. */
  id: string;
  title: string;
  description: string;
  /** Monotonic per-id version. Seeds start at 1; each learned repair bumps. */
  version: number;
  source: GsxScriptSource;
  /** Params the script expects (documentation + validation). */
  params?: string[];
  steps: GsxScriptStep[];
}

/** Per-step outcome inside a run. */
export interface GsxStepResult {
  index: number;
  kind: GsxScriptStep['kind'];
  ok: boolean;
  /** Short machine-ish detail: matched selector, failure reason, etc. */
  detail?: string;
  durationMs: number;
}

/**
 * Graded outcome of a run -- the currency of the feedback loop.
 *
 *   pass           every step (incl. assertions) succeeded
 *   fail           an assertion or action step failed; page reachable
 *   error          the run aborted (window gone, JS threw, nav refused)
 *   repaired-pass  original failed, the AI-repaired script passed
 *   repaired-fail  original failed AND the repaired script failed too
 */
export type GsxRunVerdict = 'pass' | 'fail' | 'error' | 'repaired-pass' | 'repaired-fail';

/** What the repair attempt did, embedded in the run record. */
export interface GsxRepairSummary {
  attempted: boolean;
  /** Version of the learned script the repair produced (when saved). */
  learnedVersion?: number;
  /** Why repair was skipped or failed, when it was. */
  skippedReason?: string;
  /** Step results of the repaired re-run, when one happened. */
  steps?: GsxStepResult[];
}

/** One run of one script -- persisted for the eval loop + docs UI. */
export interface GsxRunRecord {
  runId: string;
  scriptId: string;
  scriptVersion: number;
  source: GsxScriptSource;
  windowId: string;
  params: Record<string, string>;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  verdict: GsxRunVerdict;
  steps: GsxStepResult[];
  /** First failing step's detail, hoisted for list views. */
  failure?: string;
  repair?: GsxRepairSummary;
}

/** Rolling per-script health -- input to the invalidation policy. */
export interface GsxScriptStats {
  scriptId: string;
  runs: number;
  passes: number;
  failures: number;
  /** Consecutive non-pass verdicts of the CURRENT variant. */
  consecutiveFailures: number;
  lastVerdict?: GsxRunVerdict;
  lastRunAt?: string;
  /** Set when a learned variant was demoted back to the seed. */
  lastInvalidatedAt?: string;
}

/** A compact interactive-element census of the page, for repair prompts. */
export interface GsxPageSnapshot {
  url: string;
  title: string;
  elements: Array<{
    ref: number;
    tag: string;
    text: string;
    /** Selector-relevant attributes only (id, class, data-*, role, name). */
    attrs: Record<string, string>;
  }>;
}

/** An open GSX window, as seen over the bridge. */
export interface GsxWindowInfo {
  windowId: string;
  env: Environment;
  url: string;
  title: string;
}

/** Options for opening a GSX window. */
export interface GsxOpenWindowOptions {
  /** OneReach environment (default `edison`). */
  env?: Environment;
  /**
   * URL to load. Relative paths resolve against
   * `https://studio.<env>.onereach.ai`. Defaults to the studio root.
   * `{accountId}` / `{env}` placeholders are substituted.
   */
  url?: string;
  title?: string;
}

/** Options for running a script. */
export interface GsxRunScriptOptions {
  scriptId: string;
  /** Target window; when omitted a window is opened (and reused). */
  windowId?: string;
  env?: Environment;
  /** `{param}` substitutions for the script's placeholders. */
  params?: Record<string, string>;
  /**
   * Whether a failing run may invoke the AI repair loop
   * (default true). Requires the AI module to be configured;
   * silently skipped (recorded in the run) when it isn't.
   */
  repair?: boolean;
}

/** Options for finishing a teach-mode recording. */
export interface GsxStopRecordingOptions {
  /** Id for the produced template (must not collide with a seed unless
   *  intentionally shadowing it). */
  scriptId: string;
  title: string;
  /** What this walkthrough accomplishes -- feeds the LLM's param naming. */
  description: string;
  /**
   * Whether to ask the AI module to generalize the recording into a
   * parameterized template (default true). When false -- or when AI is
   * unavailable or returns garbage -- the deterministic recording is
   * saved as-is.
   */
  generalize?: boolean;
}

/** Live status of a teach-mode recording. */
export interface GsxRecordingStatus {
  windowId: string;
  recording: boolean;
  /** Events accumulated so far (drained from the page + navigations). */
  eventCount: number;
}

/** One documented parameter of a UI-automation agent. */
export interface GsxAgentParam {
  name: string;
  /** What the caller should pass -- drives free-form extraction. */
  description: string;
}

/**
 * A named, invokable UI-automation agent: a taught template plus the
 * metadata (title, description, documented params) that makes it
 * callable by name from other software.
 */
export interface GsxAgent {
  /** Callable slug, e.g. `open-designer`. Unique. */
  name: string;
  /** Human title (AI-written from the recording, or derived from name). */
  title: string;
  /** What this agent accomplishes (AI-written from the recording). */
  description: string;
  /** The learned script this agent replays (`agent.<name>`). */
  scriptId: string;
  params: GsxAgentParam[];
  createdAt: string;
  updatedAt: string;
  /** Spaces item id when published to the "GSX Build" Space. */
  spaceItemId?: string;
}

/** Options for saving an active recording as an agent. */
export interface GsxStopRecordingAsAgentOptions {
  /** Callable slug (lowercase, dashes), e.g. `open-designer`. */
  name: string;
  /** Optional one-liner about intent -- improves the AI's description. */
  hint?: string;
  /** Publish to the "GSX Build" Space (default true; soft-fails). */
  publish?: boolean;
}

/** Options for invoking an agent by name. */
export interface GsxInvokeAgentOptions {
  /**
   * Free-form request text; the agent's param descriptions are used to
   * extract values from it ("open the billing bot flow" ->
   * `{ flowName: "Billing Bot" }`). Requires the AI module.
   */
  details?: string;
  /** Structured params (merged over anything extracted from details). */
  params?: Record<string, string>;
  windowId?: string;
  env?: Environment;
  /** Forwarded to runScript (default true). */
  repair?: boolean;
}

/** Result of an agent invocation. */
export interface GsxInvokeAgentResult {
  agent: GsxAgent;
  /** The params the run actually used (extracted + provided). */
  params: Record<string, string>;
  run: GsxRunRecord;
}

/** Default per-step timeout when a step doesn't specify one. */
export const GSX_DEFAULT_STEP_TIMEOUT_MS = 10_000;

/** Learned-variant demotion threshold (consecutive failures). */
export const GSX_INVALIDATE_AFTER_CONSECUTIVE_FAILURES = 3;

/** Ring-buffer cap on retained run records. */
export const GSX_MAX_RUN_RECORDS = 200;
