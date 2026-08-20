/**
 * Keychain traffic control (ADR-075, 2026-08-20).
 *
 * WHY THIS EXISTS — the crash it prevents, from a real report
 * (`Onereach.ai Lite-2026-08-20-112705.ips`):
 *
 *     __cxa_throw                          ← keytar throws a C++ exception
 *     keytar.node +26960 / +26708 / +21368
 *     uv__work_done → uv_run
 *     node::Environment::CleanupHandles()  ← ...while Node is tearing down
 *     node::Environment::RunCleanup()
 *     → std::terminate → SIGABRT           ← macOS files it as a crash
 *
 * keytar runs every keychain call on the libuv threadpool. When the
 * process starts quitting while one of those calls is still in flight,
 * Node's environment teardown drains the pool with the runtime already
 * half-dismantled; keytar's completion path throws a C++ exception,
 * nothing above it can catch a native throw, and the process aborts.
 * The user sees the OS "quit unexpectedly" dialog — for an app that
 * was, in fact, exiting on purpose. (Same native-throw failure mode as
 * the 2026-08-12 keytar SIGABRT in the logging incident.)
 *
 * The fix is traffic control, not exception handling (a native throw
 * is uncatchable from JS): every keychain call registers here, and the
 * quit path holds the door until the registry is empty — see the
 * `before-quit` drain in `main-lite.ts`. Keychain calls settle in tens
 * of milliseconds, so in practice the hold is invisible; the cap keeps
 * a wedged securityd (the 45s hangs of the logging incident) from
 * turning quit into a hang.
 *
 * Every `require('keytar')` in the codebase MUST wrap the module with
 * `trackKeychainBackend(...)` — a source-inventory test enforces this,
 * so a fourth keytar consumer cannot silently reopen the crash window.
 */

/**
 * In-flight keychain calls. Holds settle-markers (never the caller's
 * promise directly — markers swallow rejection so the registry can be
 * awaited without stealing or duplicating the caller's error handling).
 */
const pending = new Set<Promise<void>>();

/**
 * Register one keychain call. Returns the SAME promise so call sites
 * stay expression-shaped; rejection still belongs to the caller.
 */
export function trackKeychainCall<T>(promise: Promise<T>): Promise<T> {
  const marker: Promise<void> = promise.then(
    () => {
      pending.delete(marker);
    },
    () => {
      pending.delete(marker);
    }
  );
  pending.add(marker);
  return promise;
}

/**
 * Wrap a keytar-shaped backend so every method call is tracked.
 *
 * Proxy-based on purpose: keytar's surface (getPassword, setPassword,
 * deletePassword, findCredentials, …) varies by call site's declared
 * subset, and a hand-written wrapper would silently miss a method the
 * next consumer starts using. Non-function properties and non-promise
 * returns pass through untouched.
 */
export function trackKeychainBackend<T extends object>(backend: T): T {
  return new Proxy(backend, {
    get(target, prop, receiver): unknown {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof value !== 'function') return value;
      return (...args: unknown[]): unknown => {
        if (fuseArmed) {
          return Promise.reject(
            new Error('keychain unavailable: the app is quitting (ADR-075 fuse)')
          );
        }
        const out = (value as (...a: unknown[]) => unknown).apply(target, args);
        return out instanceof Promise ? trackKeychainCall(out) : out;
      };
    },
  }) as T;
}

/** How many keychain calls are in flight right now. */
export function pendingKeychainCalls(): number {
  return pending.size;
}

/**
 * Wait for every in-flight keychain call to settle, up to `timeoutMs`.
 *
 * Re-snapshots in a short poll loop so calls ISSUED DURING the drain
 * (e.g. by a teardown) are waited on too. `drained: false` means the
 * cap was hit with calls still outstanding — the caller proceeds to
 * quit anyway (a wedged securityd must not turn quit into a hang), and
 * the residual abort risk is confined to that pathological case.
 */
export async function drainKeychain(
  timeoutMs = 2000
): Promise<{ drained: boolean; remaining: number }> {
  const deadline = Date.now() + timeoutMs;
  while (pending.size > 0) {
    const left = deadline - Date.now();
    if (left <= 0) return { drained: false, remaining: pending.size };
    await Promise.race([
      Promise.all([...pending]), // markers never reject
      new Promise<void>((resolve) => {
        const t = setTimeout(resolve, Math.min(left, 50));
        // The drain's own poll timer must never be what keeps the
        // process alive.
        if (typeof t === 'object' && 'unref' in t) t.unref();
      }),
    ]);
  }
  return { drained: true, remaining: 0 };
}

/**
 * Once armed, no NEW call may reach keytar. Armed at the last quit
 * checkpoint (`will-quit` in main-lite.ts): from there to process exit
 * there is no further gate, so a call issued in that window would be
 * exactly the in-flight native work whose completion aborts the
 * process. Fused calls reject immediately instead — for a write that
 * means "rejected and logged" rather than "aborted the process and
 * lost anyway", which is the better half of a bad trade.
 */
let fuseArmed = false;

/** Arm the shutdown fuse. One-way: only a new process resets it. */
export function armKeychainFuse(): void {
  fuseArmed = true;
}

/** Whether the shutdown fuse is armed. */
export function keychainFuseArmed(): boolean {
  return fuseArmed;
}

/** @internal — tests reset the registry between cases. */
export function _resetKeychainTrackingForTesting(): void {
  pending.clear();
  fuseArmed = false;
}

// ─── Singleton view (Rule 12) ────────────────────────────────────────
// The tracker itself is module-level state on purpose: the three keytar
// call sites wrap at require() time, before any init runs, so the plain
// functions above are the real surface. This singleton is the same
// registry behind the house API shape — conformance-contract tested,
// swappable for tests like every other module.

/** Public surface of the keychain traffic controller. */
export interface KeychainApi {
  /** Register one keychain call; returns the same promise. */
  trackCall<T>(promise: Promise<T>): Promise<T>;
  /** Wrap a keytar-shaped backend so every method call is tracked. */
  trackBackend<T extends object>(backend: T): T;
  /** How many keychain calls are in flight right now. */
  pendingCalls(): number;
  /** Wait (capped) for every in-flight call to settle. */
  drain(timeoutMs?: number): Promise<{ drained: boolean; remaining: number }>;
}

const defaultApi: KeychainApi = {
  trackCall: trackKeychainCall,
  trackBackend: trackKeychainBackend,
  pendingCalls: pendingKeychainCalls,
  drain: drainKeychain,
};

let activeApi: KeychainApi = defaultApi;

/** The keychain traffic controller. */
export function getKeychainApi(): KeychainApi {
  return activeApi;
}

/** @internal — restore the real registry-backed API. */
export function _resetKeychainApiForTesting(): void {
  activeApi = defaultApi;
  pending.clear();
}

/** @internal — swap in a stub for consumers under test. */
export function _setKeychainApiForTesting(api: KeychainApi): void {
  activeApi = api;
}
