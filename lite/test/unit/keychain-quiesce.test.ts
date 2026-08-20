/**
 * ADR-075 — keychain traffic control.
 *
 * The crash this guards against (report 2026-08-20-112705): the process
 * quits while a keytar call is on the libuv threadpool, Node teardown
 * drains the pool half-dismantled, keytar's completion throws a C++
 * exception nothing can catch, SIGABRT, and the user gets an OS crash
 * dialog for an app that was exiting on purpose.
 *
 * Three layers pinned here:
 *   1. the registry itself (track / drain semantics),
 *   2. the inventory: every `require('keytar')` in lite/ is wrapped —
 *      a fourth keytar consumer cannot silently reopen the window,
 *   3. the quit wiring in main-lite.ts (drain before teardowns, capped
 *      rounds, never during a Squirrel update handoff).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import {
  trackKeychainCall,
  trackKeychainBackend,
  pendingKeychainCalls,
  drainKeychain,
  armKeychainFuse,
  keychainFuseArmed,
  _resetKeychainTrackingForTesting,
} from '../../keychain/api.js';

/** A promise settled by hand — the shape of an in-flight keytar call. */
function gate<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let res!: (v: T) => void;
  let rej!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    res = a;
    rej = b;
  });
  return { promise, resolve: res, reject: rej };
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  _resetKeychainTrackingForTesting();
});

describe('the registry', () => {
  it('counts a call while in flight and forgets it on resolve', async () => {
    const g = gate<string>();
    const tracked = trackKeychainCall(g.promise);
    expect(pendingKeychainCalls()).toBe(1);
    g.resolve('secret');
    expect(await tracked).toBe('secret'); // the SAME promise comes back
    await tick();
    expect(pendingKeychainCalls()).toBe(0);
  });

  it('a rejected call also clears — and the rejection stays the caller\'s', async () => {
    const g = gate<never>();
    const tracked = trackKeychainCall(g.promise);
    g.reject(new Error('keychain locked'));
    await expect(tracked).rejects.toThrow('keychain locked');
    await tick();
    // The registry swallowed nothing and leaked nothing: no unhandled
    // rejection (vitest would fail the run), no stuck entry.
    expect(pendingKeychainCalls()).toBe(0);
  });
});

describe('trackKeychainBackend', () => {
  it('tracks every method call without changing results', async () => {
    const g = gate<string | null>();
    const backend = {
      getPassword: () => g.promise,
      setPassword: async () => undefined,
      deletePassword: async () => true,
    };
    const wrapped = trackKeychainBackend(backend);
    const read = wrapped.getPassword();
    expect(pendingKeychainCalls()).toBe(1);
    g.resolve('hunter2');
    expect(await read).toBe('hunter2');
    expect(await wrapped.deletePassword()).toBe(true);
    await tick();
    expect(pendingKeychainCalls()).toBe(0);
  });

  it('covers methods it was never told about — the next keytar API too', async () => {
    // Proxy-based on purpose: a hand-written wrapper misses the method
    // the next consumer starts using, and the crash window reopens.
    const backend = { findCredentials: async () => [{ account: 'a', password: 'p' }] };
    const wrapped = trackKeychainBackend(backend);
    const p = wrapped.findCredentials();
    expect(pendingKeychainCalls()).toBe(1);
    await p;
    await tick();
    expect(pendingKeychainCalls()).toBe(0);
  });

  it('passes through non-function properties and non-promise returns', () => {
    const backend = { version: '7.9.0', isSupported: () => true };
    const wrapped = trackKeychainBackend(backend);
    expect(wrapped.version).toBe('7.9.0');
    expect(wrapped.isSupported()).toBe(true);
    expect(pendingKeychainCalls()).toBe(0);
  });
});

describe('drainKeychain', () => {
  it('returns immediately when nothing is in flight', async () => {
    const t0 = Date.now();
    expect(await drainKeychain(2000)).toEqual({ drained: true, remaining: 0 });
    expect(Date.now() - t0).toBeLessThan(100);
  });

  it('waits for in-flight calls, then reports drained', async () => {
    const g = gate<void>();
    trackKeychainCall(g.promise);
    const drain = drainKeychain(1000);
    setTimeout(() => g.resolve(undefined), 30);
    expect(await drain).toEqual({ drained: true, remaining: 0 });
  });

  it('waits for calls issued DURING the drain (teardowns write too)', async () => {
    const first = gate<void>();
    const second = gate<void>();
    trackKeychainCall(first.promise);
    const drain = drainKeychain(1000);
    setTimeout(() => {
      trackKeychainCall(second.promise); // arrives mid-drain
      first.resolve(undefined);
      setTimeout(() => second.resolve(undefined), 20);
    }, 20);
    expect(await drain).toEqual({ drained: true, remaining: 0 });
  });

  it('gives up at the cap rather than turning quit into a hang', async () => {
    trackKeychainCall(gate<void>().promise); // never settles — wedged securityd
    const t0 = Date.now();
    const result = await drainKeychain(120);
    expect(result.drained).toBe(false);
    expect(result.remaining).toBe(1);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(100);
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});

describe('the shutdown fuse', () => {
  it('armed: new calls reject without ever reaching the backend', async () => {
    let backendTouched = 0;
    const wrapped = trackKeychainBackend({
      getPassword: async () => {
        backendTouched += 1;
        return 'secret';
      },
    });
    expect(await wrapped.getPassword()).toBe('secret'); // works before arming
    armKeychainFuse();
    expect(keychainFuseArmed()).toBe(true);
    await expect(wrapped.getPassword()).rejects.toThrow(/quitting/);
    // The whole point: no NEW native work after the last quit gate —
    // a call issued past will-quit is exactly the in-flight keytar
    // completion that aborts Node teardown.
    expect(backendTouched).toBe(1);
    expect(pendingKeychainCalls()).toBe(0);
  });

  it('is one-way in production, reset only by the test seam', () => {
    armKeychainFuse();
    expect(keychainFuseArmed()).toBe(true);
    _resetKeychainTrackingForTesting();
    expect(keychainFuseArmed()).toBe(false);
  });
});

// ── The inventory: no untracked keytar anywhere in lite/ ─────────────
describe('every require(\'keytar\') is tracked', () => {
  function liteDir(): string {
    const found = ['lite', '.'].map((p) => resolve(p)).find((p) => existsSync(join(p, 'main-lite.ts')));
    if (found === undefined) throw new Error('lite/ not found');
    return found;
  }

  function tsFilesUnder(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry.startsWith('.')) continue;
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) out.push(...tsFilesUnder(full));
      else if (entry.endsWith('.ts')) out.push(full);
    }
    return out;
  }

  it('finds the known consumers at all (guards the detector)', () => {
    const hits = tsFilesUnder(liteDir()).filter((f) =>
      readFileSync(f, 'utf8').includes("require('keytar')")
    );
    // session-vault, ai key store, totp store — plus the test harness.
    expect(hits.length).toBeGreaterThanOrEqual(3);
  });

  it('every production require site wraps with trackKeychainBackend', () => {
    const offenders: string[] = [];
    for (const file of tsFilesUnder(liteDir())) {
      if (file.includes('/test/')) continue; // harness fakes don't reach the threadpool
      const src = readFileSync(file, 'utf8');
      if (!src.includes("require('keytar')")) continue;
      for (const line of src.split('\n')) {
        const trimmed = line.trim();
        // Prose about the rule is not a violation of it.
        if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) {
          continue;
        }
        if (line.includes("require('keytar')") && !line.includes('trackKeychainBackend(')) {
          offenders.push(`${file}: ${trimmed}`);
        }
      }
    }
    expect(
      offenders,
      'untracked keytar — wrap with trackKeychainBackend() or the teardown SIGABRT returns'
    ).toEqual([]);
  });
});

// ── The quit wiring ──────────────────────────────────────────────────
describe('main-lite quit path', () => {
  const mainSrc = (): string => {
    const found = ['main-lite.ts', 'lite/main-lite.ts']
      .map((p) => resolve(p))
      .find((p) => existsSync(p));
    if (found === undefined) throw new Error('main-lite.ts not found');
    return readFileSync(found, 'utf8');
  };

  it('the gate holds the quit and actually drains', () => {
    const s = mainSrc();
    const gate = s.indexOf('function keychainQuitGate(');
    expect(gate).toBeGreaterThan(-1);
    const block = s.slice(gate, gate + 2200);
    expect(block).toContain('event.preventDefault()');
    expect(block).toContain('drainKeychain(');
    expect(block).toContain('app.quit()'); // re-quits after the drain
  });

  it('before-quit consults the gate before any teardown', () => {
    const s = mainSrc();
    const handler = s.indexOf("app.on('before-quit'");
    expect(handler).toBeGreaterThan(-1);
    const gateAt = s.indexOf("keychainQuitGate(event, 'before-quit')", handler);
    const teardownAt = s.indexOf('updaterHandle?.teardown()', handler);
    expect(gateAt).toBeGreaterThan(handler);
    expect(teardownAt).toBeGreaterThan(gateAt); // the gate gates the teardowns
  });

  it('never holds the door during a Squirrel update handoff', () => {
    const s = mainSrc();
    const handler = s.indexOf("app.on('before-quit'");
    const updGuard = s.indexOf('isUpdatingApp', handler);
    const gateAt = s.indexOf("keychainQuitGate(event, 'before-quit')", handler);
    // The install path has a 10s budget; the gate must sit AFTER the
    // updating guard so it can never spend it.
    expect(updGuard).toBeGreaterThan(-1);
    expect(updGuard).toBeLessThan(gateAt);
  });

  it('caps the drain rounds so quit can never loop forever', () => {
    const s = mainSrc();
    expect(s).toContain('keychainDrainRounds >= 3');
    expect(s).toContain('keychainDrainRounds += 1');
  });

  it('will-quit is the second checkpoint AND arms the fuse when it passes', () => {
    const s = mainSrc();
    const handler = s.indexOf("app.on('will-quit'");
    expect(handler).toBeGreaterThan(-1);
    const block = s.slice(handler, handler + 1200);
    const gateAt = block.indexOf("keychainQuitGate(event, 'will-quit')");
    const fuseAt = block.indexOf('armKeychainFuse()');
    expect(gateAt).toBeGreaterThan(-1);
    // Fuse arms ONLY once the gate lets the quit proceed — past that
    // point there is no gate left, so new calls must not reach keytar.
    expect(fuseAt).toBeGreaterThan(gateAt);
    // ...and never during a Squirrel handoff.
    expect(block.indexOf('isUpdatingApp')).toBeLessThan(gateAt);
  });

  it('before-quit never arms the fuse — teardowns may still need the keychain', () => {
    const s = mainSrc();
    const bq = s.indexOf("app.on('before-quit'");
    const wq = s.indexOf("app.on('will-quit'");
    expect(bq).toBeGreaterThan(-1);
    // The only armKeychainFuse() call sits inside the will-quit handler.
    const arms = [...s.matchAll(/armKeychainFuse\(\)/g)].map((m) => m.index ?? -1);
    const calls = arms.filter((i) => {
      const lineStart = s.lastIndexOf('\n', i) + 1;
      return !s.slice(lineStart, i).trimStart().startsWith('import');
    });
    expect(calls.length).toBe(1);
    expect(calls[0]).toBeGreaterThan(wq);
  });
});
