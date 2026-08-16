/**
 * Attribution email fallback (Settings → Account, 2026-08-07).
 *
 * Some sign-in flows never put an email in the or-cookie — verified
 * live: even a fresh re-login on this install carries none, so
 * attribution could never self-heal. The user-declared email fills the
 * gap; the bootstrap uses it ONLY when the session lacks one.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  readAttributionEmail,
  setIdentityStoreDirForTesting,
  validateAttributionEmail,
  writeAttributionEmail,
} from '../../spaces/identity-store.js';

describe('identity store', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'identity-'));
    setIdentityStoreDirForTesting(dir);
  });

  afterEach(() => {
    setIdentityStoreDirForTesting(null);
    rmSync(dir, { recursive: true, force: true });
  });

  it('starts unset; round-trips; clears with null or empty', async () => {
    expect(await readAttributionEmail()).toBeNull();
    expect(await writeAttributionEmail('  Robb@OneReach.com ')).toBe('robb@onereach.com');
    expect(await readAttributionEmail()).toBe('robb@onereach.com');
    expect(await writeAttributionEmail(null)).toBeNull();
    expect(await readAttributionEmail()).toBeNull();
    await writeAttributionEmail('robb@onereach.com');
    expect(await writeAttributionEmail('   ')).toBeNull();
    expect(await readAttributionEmail()).toBeNull();
  });

  it('rejects non-emails; corrupt file degrades to unset', async () => {
    for (const bad of ['nope', 'a@b', '@x.com', 'a b@c.com', `x@y.${'z'.repeat(260)}`]) {
      expect(validateAttributionEmail(bad), bad.slice(0, 30)).toBeNull();
      await expect(writeAttributionEmail(bad)).rejects.toThrow(/valid email/);
    }
    writeFileSync(path.join(dir, 'attribution-email.json'), '{broken');
    expect(await readAttributionEmail()).toBeNull();
  });
});

describe('bootstrap fallback wiring (source-level)', () => {
  const read = (rel: string): string => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('node:fs') as typeof import('node:fs');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const p = require('node:path') as typeof import('node:path');
    const candidates = [p.resolve(rel), p.resolve('lite', rel)];
    const found = candidates.find((f) => fs.existsSync(f));
    if (found === undefined) throw new Error(`${rel} not found`);
    return fs.readFileSync(found, 'utf8');
  };

  it('loadCurrentUser falls back to the attribution email, never a UUID', () => {
    const src = read('spaces/spaces.ts');
    const start = src.indexOf('async function loadCurrentUser');
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, start + 2600);
    expect(body).toContain('attributionEmailGet()');
    expect(body).toContain('skipping person bootstrap');
    expect(body).not.toMatch(/session\.accountId/);
  });

  it('the Account section mounts the attribution block outside the re-render host', () => {
    const src = read('settings/sections/account.ts');
    expect(src).toContain('mountAttributionEmail(attributionHost)');
    expect(src).toContain('renderState(authHost)');
    expect(src).toContain('attributionEmailSet(');
  });

  it('IPC + preload carry the attribution channels', () => {
    expect(read('spaces/ipc.ts')).toContain("'lite:spaces:identity:attributionEmail:get'");
    expect(read('preload-lite.ts')).toContain('attributionEmailGet: ()');
  });
});

describe('attribution email sync cache (viewerId fallback — 2026-08-15 incident)', () => {
  it('primes a sync accessor so an email-less session resolves to the declared email', async () => {
    const os = await import('node:os');
    const fs = await import('node:fs');
    const path = await import('node:path');
    const mod = await import('../../spaces/identity-store');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attr-cache-'));
    try {
      mod.setIdentityStoreDirForTesting(dir);
      // Cold: nothing stored yet.
      await mod.primeAttributionEmailCache();
      expect(mod.readAttributionEmailSync()).toBeNull();
      // Write warms the cache synchronously for the next reader.
      await mod.writeAttributionEmail('Robb@Onereach.com');
      expect(mod.readAttributionEmailSync()).toBe('robb@onereach.com'); // lowercased
      // A fresh process (cache reset) re-primes from disk.
      await mod.primeAttributionEmailCache();
      expect(mod.readAttributionEmailSync()).toBe('robb@onereach.com');
      // Clearing empties the cache.
      await mod.writeAttributionEmail(null);
      expect(mod.readAttributionEmailSync()).toBeNull();
    } finally {
      mod.setIdentityStoreDirForTesting(null);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
