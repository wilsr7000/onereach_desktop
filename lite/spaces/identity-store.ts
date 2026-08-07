/**
 * Attribution email fallback — main process.
 *
 * Some sign-in flows never put an email in the `or` cookie (verified
 * live on this install, 2026-08-07: even a fresh re-login carries
 * none). Without an email the identity bootstrap correctly refuses to
 * manufacture a Person — so nothing the user creates is attributed.
 *
 * This store holds a user-declared attribution email (Settings →
 * Account), used by the Spaces identity bootstrap ONLY when the auth
 * session lacks one. One JSON file under userData, same conventions as
 * the sibling stores: atomic writes, validate-on-read, corrupt file
 * degrades to "none".
 *
 * @internal — consumers go through `getSpacesApi().identityAttribution*`.
 */

import { app } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';

/** Overridable for tests. */
let baseDirOverride: string | null = null;

export function setIdentityStoreDirForTesting(dir: string | null): void {
  baseDirOverride = dir;
}

function storePath(): string {
  const base = baseDirOverride ?? app.getPath('userData');
  return path.join(base, 'attribution-email.json');
}

/**
 * Normalize + validate an email candidate. Deliberately simple: one
 * `@`, non-empty local + domain with a dot, ≤254 chars, lowercased.
 * This gates a display identity, not deliverability.
 */
export function validateAttributionEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const email = raw.trim().toLowerCase();
  if (email.length === 0 || email.length > 254) return null;
  const m = email.match(/^[^\s@]+@[^\s@]+\.[^\s@]+$/);
  return m === null ? null : email;
}

export async function readAttributionEmail(): Promise<string | null> {
  try {
    const raw = await fs.readFile(storePath(), 'utf8');
    const parsed = JSON.parse(raw) as { email?: unknown };
    return validateAttributionEmail(parsed.email);
  } catch {
    return null;
  }
}

/** Persist (validated) or clear with null. Returns the stored value. */
export async function writeAttributionEmail(raw: string | null): Promise<string | null> {
  const target = storePath();
  if (raw === null || (typeof raw === 'string' && raw.trim().length === 0)) {
    await fs.rm(target, { force: true });
    return null;
  }
  const valid = validateAttributionEmail(raw);
  if (valid === null) {
    throw new Error('Enter a valid email address (name@example.com).');
  }
  const tmp = `${target}.tmp`;
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(tmp, JSON.stringify({ email: valid }, null, 2), 'utf8');
  await fs.rename(tmp, target);
  return valid;
}
