/**
 * Onereach Lite Auto-Updater -- check-for-updates entry point.
 *
 * Single in-flight guard + 30s timeout. Borrowed pattern: main.js
 * checkForUpdates (lines 17001-17063).
 *
 * The lifecycle module's event handlers do the actual user-facing work
 * (dialogs etc.) -- this module just kicks off the check and reports
 * timeouts to the caller.
 */

import type { AutoUpdaterLike } from './init.js';
import type { UpdaterStatusEvent } from './types.js';

const DEFAULT_CHECK_TIMEOUT_MS = 30_000;

/**
 * Retry policy for periodic (non-manual) checks. Manual checks bypass
 * retry so the user gets immediate feedback when they click "Check for
 * Updates".
 *
 * Transient errors (network unreachable, DNS, brief 5xx) most often
 * resolve in a few seconds -- e.g., laptop wakes from sleep, captive
 * portal logs in. Two retries with 2s/4s backoff covers the common
 * case without making a periodic check take longer than its 30s
 * timeout if the server is genuinely down.
 */
const RETRY_BACKOFF_MS = [2_000, 4_000];

/**
 * Error-message patterns that indicate a transient failure worth
 * retrying. Permanent failures (404 release missing, 401/403, checksum
 * mismatch) are NOT in this list -- they fail fast.
 */
const TRANSIENT_PATTERNS: RegExp[] = [
  /ENOTFOUND/i,
  /ECONNREFUSED/i,
  /ECONNRESET/i,
  /ETIMEDOUT/i,
  /EAI_AGAIN/i,
  /network\s*(unreachable|error)/i,
  /timed\s*out/i,
  /HTTP\s*5\d\d/i,
  /socket\s*hang\s*up/i,
];

function isTransient(err: unknown): boolean {
  const message = (err as Error)?.message ?? '';
  return TRANSIENT_PATTERNS.some((re) => re.test(message));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface CheckOptions {
  /** True if user-initiated (manual menu click). Surfaces "no updates" dialogs. */
  manual: boolean;
  /** Override for the 30s default. */
  timeoutMs?: number;
}

export interface CheckRunner {
  /**
   * Kick off a check. Resolves when the underlying checkForUpdates promise
   * settles OR the timeout fires (whichever first). Multiple concurrent
   * calls are coalesced -- the second caller awaits the first's result.
   */
  check(opts: CheckOptions): Promise<{ inFlight: boolean; timedOut: boolean; manual: boolean }>;
  /** True while a check is currently in progress. */
  isCheckInFlight(): boolean;
  /** True if the most recent check was manual. */
  wasLastManual(): boolean;
}

export interface CheckRunnerDeps {
  autoUpdater: AutoUpdaterLike;
  /** Called when status transitions -- forwards to the lifecycle's IPC. */
  emitStatus: (event: UpdaterStatusEvent) => void;
  logger?: {
    info: (msg: string, data?: unknown) => void;
    warn: (msg: string, data?: unknown) => void;
    error: (msg: string, data?: unknown) => void;
  };
  /**
   * Optional span emitter -- wraps every `check()` call in an
   * `updater.check.start` / `.finish` / `.fail` span. ADR-030.
   */
  spanEmitter?: (name: string, data?: unknown) => import('../logging/events.js').Span;
}

/**
 * Build a check runner. Caller owns the lifecycle of the AutoUpdater
 * instance (typically the singleton from initAutoUpdater).
 */
export function createCheckRunner(deps: CheckRunnerDeps): CheckRunner {
  const log = deps.logger ?? { info: () => {}, warn: () => {}, error: () => {} };
  let inFlight = false;
  let lastManual = false;
  let inFlightPromise: Promise<{ inFlight: boolean; timedOut: boolean; manual: boolean }> | null = null;

  function check(opts: CheckOptions): Promise<{ inFlight: boolean; timedOut: boolean; manual: boolean }> {
    if (inFlight && inFlightPromise !== null) {
      log.info('updater: check already in flight -- coalescing');
      return inFlightPromise;
    }
    inFlight = true;
    lastManual = opts.manual;
    deps.emitStatus({ status: 'checking' });
    log.info('updater: checkForUpdates start', { manual: opts.manual });
    // ADR-030: span every check. The .start fires here; .finish/.fail
    // happens in the IIFE below at success/failure.
    const span = deps.spanEmitter?.('updater.check', { manual: opts.manual });

    const timeoutMs = opts.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
    const result = (async (): Promise<{ inFlight: boolean; timedOut: boolean; manual: boolean }> => {
      // Auto-recovery: periodic (non-manual) checks retry transient
      // failures with exponential backoff. Manual checks fail fast so
      // the clicker sees a result. The timeout guards each individual
      // attempt; total worst-case duration for a periodic check is
      // (30s + 2s + 30s + 4s + 30s) = ~96s.
      const maxAttempts = opts.manual ? 1 : 1 + RETRY_BACKOFF_MS.length;
      let lastErr: unknown = null;
      let lastTimedOut = false;

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        let timedOut = false;
        try {
          await Promise.race([
            deps.autoUpdater.checkForUpdates(),
            new Promise<void>((_, reject) =>
              setTimeout(() => {
                timedOut = true;
                reject(new Error(`updater: check timed out after ${timeoutMs}ms`));
              }, timeoutMs)
            ),
          ]);
          span?.finish({ manual: opts.manual, attempts: attempt });
          return { inFlight: false, timedOut: false, manual: opts.manual };
        } catch (err) {
          lastErr = err;
          lastTimedOut = timedOut;
          // Decide whether to retry. Manual + last attempt fall through
          // to the surfacing path below.
          const transient = timedOut || isTransient(err);
          if (attempt < maxAttempts && transient) {
            const backoff = RETRY_BACKOFF_MS[attempt - 1] ?? 4_000;
            log.warn('updater: check transient failure -- retrying', {
              attempt,
              backoffMs: backoff,
              error: (err as Error).message,
            });
            await sleep(backoff);
            continue;
          }
          break;
        }
      }

      // All attempts exhausted -- surface the last error.
      if (lastTimedOut) {
        deps.emitStatus({ status: 'error', info: { error: 'Update check timed out' } });
        span?.fail(new Error(`updater: check timed out after ${timeoutMs}ms (${maxAttempts} attempt(s))`));
      } else {
        deps.emitStatus({ status: 'error', info: { error: (lastErr as Error).message } });
        log.error('updater: check failed', {
          error: (lastErr as Error).message,
          attempts: maxAttempts,
        });
        span?.fail(lastErr);
      }
      return { inFlight: false, timedOut: lastTimedOut, manual: opts.manual };
    })();

    // Grace-window cleanup runs after the IIFE settles regardless of
    // success/failure. Matches the original 1s coalesce window.
    void result.finally(() => {
      setTimeout(() => {
        inFlight = false;
        inFlightPromise = null;
      }, 1_000);
    });
    inFlightPromise = result;
    return result;
  }

  return {
    check,
    isCheckInFlight: () => inFlight,
    wasLastManual: () => lastManual,
  };
}
