/**
 * Install identity — the random UUID that ties one machine's rollups
 * together, and nothing else.
 *
 * Deliberately NOT derived from hardware (MAC, serial, hostname): a
 * derived id is a device fingerprint that survives reinstalls and can
 * be correlated with other systems. A random id minted on first run
 * does the one job needed here, and deleting the app's data resets it —
 * which is the correct behaviour for "forget this install".
 *
 * Pure over an injected IO seam so corruption/absence handling is
 * exhaustively testable without a filesystem.
 */

import type { InstallIdentity } from './types.js';

/** Storage seam. `read` returns null when the file is absent. */
export interface IdentityIo {
  read(): string | null;
  write(content: string): void;
}

/**
 * Load the persisted identity, or mint and persist a fresh one.
 *
 * Anything unreadable — missing file, junk JSON, a tampered or
 * truncated record — results in a NEW identity rather than an error.
 * Telemetry identity is not worth a boot failure, and a fresh id is
 * always safe: the worst case is one machine appearing twice, which the
 * per-day rollup model tolerates.
 */
export function loadOrMintIdentity(
  io: IdentityIo,
  mintUuid: () => string,
  nowIso: () => string
): InstallIdentity {
  const raw = safeRead(io);
  if (raw !== null) {
    const parsed = parseIdentity(raw);
    if (parsed !== null) return parsed;
  }
  const fresh: InstallIdentity = { installId: mintUuid(), firstSeenAt: nowIso() };
  try {
    io.write(JSON.stringify(fresh, null, 2));
  } catch {
    // Persisting failed (read-only disk, permissions). The in-memory
    // identity still serves this session; next boot mints again. A
    // rotating id under-counts installs — acceptable; crashing is not.
  }
  return fresh;
}

function safeRead(io: IdentityIo): string | null {
  try {
    return io.read();
  } catch {
    return null;
  }
}

/** Strict parse: both fields present, both plausible. */
export function parseIdentity(raw: string): InstallIdentity | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (value === null || typeof value !== 'object') return null;
  const id = (value as { installId?: unknown }).installId;
  const seen = (value as { firstSeenAt?: unknown }).firstSeenAt;
  if (typeof id !== 'string' || !looksLikeUuid(id)) return null;
  if (typeof seen !== 'string' || Number.isNaN(Date.parse(seen))) return null;
  return { installId: id, firstSeenAt: seen };
}

/**
 * Sanity check, not validation theatre: the id must be shaped like the
 * UUIDs we mint, so a hand-edited file can't smuggle an arbitrary
 * string (an email, a hostname) into every payload we ever send.
 */
export function looksLikeUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/** Short display form for Space names: first 8 hex chars. */
export function shortInstallId(installId: string): string {
  return installId.slice(0, 8);
}
