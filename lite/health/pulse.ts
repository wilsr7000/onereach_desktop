/**
 * Service pulse — the app-wide "is the backend having a moment" state
 * (2026-08-17).
 *
 * THE PROBLEM this solves: an outage (the 08-12 KV 500 storm, a graph
 * blip, GitHub down) used to surface as a WALL of red — every pane's
 * fetch failed independently and each painted its own error. The
 * elegant contract instead: panes keep their last-good content (the
 * SpacesCache already serves stale-while-revalidate), ONE calm banner
 * says "showing recent data, retrying automatically", and everything
 * quietly heals when the backend returns.
 *
 * This module is the shared signal: producers with real knowledge of
 * backend health (today: the KV circuit breaker, which opens after 5
 * consecutive server-side failures and probes recovery) report
 * down/up; subscribers (the health broadcaster → every window) get one
 * coherent status. Pure logic — no Electron imports — so the state
 * machine is unit-testable; the IPC broadcast lives in health/main.
 *
 * @internal — consumers go through `lite/health/api.ts` re-exports.
 */

export interface ServicePulse {
  /** 'ok' when no service is down. */
  status: 'ok' | 'degraded';
  /** Down services, oldest outage first. Empty when status is 'ok'. */
  services: Array<{ service: string; reason: string; downSinceMs: number }>;
  /** ms epoch of the oldest active outage, or null when ok. */
  degradedSinceMs: number | null;
}

type PulseListener = (pulse: ServicePulse) => void;

const down = new Map<string, { reason: string; downSinceMs: number }>();
const listeners = new Set<PulseListener>();
let nowFn: () => number = () => Date.now();

/**
 * Flap suppression (2026-08-17): on a lossy network the breaker cycles
 * down→up→down every few minutes, and each cycle re-mounted the banner
 * and fired a "Back online" toast — the user experienced it as
 * "I still keep getting alerts for connectivity issues." A recovery
 * only PUBLISHES after the service stays up for this long; a re-down
 * inside the window silently cancels the pending clear, so the whole
 * flap reads as ONE continuous episode with its original downSince.
 */
export const RECOVERY_STABLE_MS = 45_000;
const pendingUp = new Map<string, ReturnType<typeof setTimeout>>();

function snapshot(): ServicePulse {
  const services = [...down.entries()]
    .map(([service, d]) => ({ service, reason: d.reason, downSinceMs: d.downSinceMs }))
    .sort((a, b) => a.downSinceMs - b.downSinceMs);
  return {
    status: services.length === 0 ? 'ok' : 'degraded',
    services,
    degradedSinceMs: services.length === 0 ? 0 : services[0]!.downSinceMs,
  } as ServicePulse & { degradedSinceMs: number | null };
}

function notify(): void {
  const pulse = getPulse();
  for (const cb of listeners) {
    try {
      cb(pulse);
    } catch {
      /* a broken subscriber must not break the pulse */
    }
  }
}

/** Current pulse. Always well-shaped; never throws. */
export function getPulse(): ServicePulse {
  const s = snapshot();
  return {
    status: s.status,
    services: s.services,
    degradedSinceMs: s.services.length === 0 ? null : s.services[0]!.downSinceMs,
  };
}

/**
 * A producer observed the service failing in a way users will feel.
 * Idempotent per service — repeated reports refresh the reason but
 * keep the original downSince (and don't re-notify unless something
 * actually changed).
 */
export function reportServiceDown(service: string, reason: string): void {
  // A re-down during the recovery hold is the same episode continuing:
  // cancel the pending clear and stay silent unless something changed.
  const held = pendingUp.get(service);
  if (held !== undefined) {
    clearTimeout(held);
    pendingUp.delete(service);
  }
  const existing = down.get(service);
  if (existing !== undefined && existing.reason === reason) return;
  down.set(service, {
    reason,
    downSinceMs: existing?.downSinceMs ?? nowFn(),
  });
  notify();
}

/**
 * The service recovered. The clear publishes only after the service
 * stays up for RECOVERY_STABLE_MS — flapping never spams subscribers.
 * No-op if it was never reported down.
 */
export function reportServiceUp(service: string): void {
  if (!down.has(service)) return;
  if (pendingUp.has(service)) return; // hold already running
  const t = setTimeout(() => {
    pendingUp.delete(service);
    if (down.delete(service)) notify();
  }, RECOVERY_STABLE_MS);
  (t as { unref?: () => void }).unref?.();
  pendingUp.set(service, t);
}

/** Subscribe to pulse changes. Returns an unsubscribe function. */
export function onPulseChange(cb: PulseListener): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** @internal test seams */
export function _resetPulseForTesting(): void {
  for (const t of pendingUp.values()) clearTimeout(t);
  pendingUp.clear();
  down.clear();
  listeners.clear();
  nowFn = () => Date.now();
}
export function _setPulseClockForTesting(fn: () => number): void {
  nowFn = fn;
}
