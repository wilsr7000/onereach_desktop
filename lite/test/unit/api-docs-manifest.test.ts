/**
 * Manifest builder snapshot tests (ADR-035).
 *
 * Verifies the harvested manifest covers every documented module and
 * that each module's surface matches what its `api.ts` declares.
 *
 * Drift signal: if a method is added to an `XApi` interface without a
 * preceding JSDoc block, this test fails because the harvester emits
 * `description: ''` and the assertion below requires non-empty
 * descriptions on canonical-example modules.
 */

import { describe, it, expect } from 'vitest';
import { MANIFEST } from '../../api-docs/manifest.generated.js';

describe('API docs manifest', () => {
  it('covers every documented module', () => {
    const slugs = MANIFEST.modules.map((m) => m.slug).sort();
    expect(slugs).toEqual(
      [
        'ai-run-times',
        'auth',
        'bug-report',
        'discovery',
        'event-bus',
        'files',
        'health',
        'idw',
        'kv',
        'logging',
        'main-window',
        'neon',
        'onboarding',
        'settings',
        'tools',
        'totp',
        'university',
      ].sort()
    );
  });

  it('every module has a non-empty surface with at least one method', () => {
    for (const mod of MANIFEST.modules) {
      expect(mod.surface, `module ${mod.slug} has no surface`).not.toBeNull();
      if (mod.surface !== null) {
        expect(mod.surface.methods.length, `module ${mod.slug} has zero methods`).toBeGreaterThan(0);
        expect(mod.surface.interfaceName, `module ${mod.slug} has empty interface name`).not.toBe('');
      }
    }
  });

  it('every module has a non-empty README content', () => {
    for (const mod of MANIFEST.modules) {
      expect(mod.readme, `module ${mod.slug} missing README`).not.toBeNull();
      if (mod.readme !== null) {
        expect(mod.readme.length, `module ${mod.slug} README is empty`).toBeGreaterThan(0);
      }
    }
  });

  it('lists all KVApi methods including onEvent (typed events surface)', () => {
    const kv = MANIFEST.modules.find((m) => m.slug === 'kv');
    expect(kv).toBeDefined();
    if (kv?.surface !== null && kv?.surface !== undefined) {
      const names = kv.surface.methods.map((m) => m.name).sort();
      expect(names).toEqual(['delete', 'get', 'list', 'listKeys', 'onEvent', 'set'].sort());
    }
  });

  it('lists all SettingsApi methods (single-method module)', () => {
    const settings = MANIFEST.modules.find((m) => m.slug === 'settings');
    expect(settings).toBeDefined();
    if (settings?.surface !== null && settings?.surface !== undefined) {
      expect(settings.surface.methods.map((m) => m.name)).toEqual(['open']);
    }
  });

  it('every method on canonical modules has non-empty JSDoc description (drift catcher)', () => {
    // KV is the canonical example. Other modules may have less mature
    // doc coverage; the strict assertion stays on KV so the test is
    // useful but not noisy.
    const kv = MANIFEST.modules.find((m) => m.slug === 'kv');
    expect(kv).toBeDefined();
    if (kv?.surface !== null && kv?.surface !== undefined) {
      const undocumented = kv.surface.methods.filter((m) => m.description === '').map((m) => m.name);
      expect(
        undocumented,
        `KVApi methods missing JSDoc description: ${undocumented.join(', ')}`
      ).toEqual([]);
    }
  });

  it('events catalog is present for modules that emit events', () => {
    const expectedWithEvents = ['auth', 'bug-report', 'kv', 'neon'];
    for (const slug of expectedWithEvents) {
      const mod = MANIFEST.modules.find((m) => m.slug === slug);
      expect(mod, `module ${slug} not found`).toBeDefined();
      if (mod !== undefined) {
        expect(mod.events, `module ${slug} should have events catalog`).not.toBeNull();
        if (mod.events !== null) {
          expect(mod.events.count, `module ${slug} has zero events`).toBeGreaterThan(0);
          expect(mod.events.constantName, `module ${slug} has empty constant name`).toMatch(
            /^[A-Z_]+_EVENTS$/
          );
        }
      }
    }
  });

  it('KV events catalog has 15 entries (5 ops x 3 outcomes)', () => {
    const kv = MANIFEST.modules.find((m) => m.slug === 'kv');
    expect(kv?.events?.count).toBe(15);
    if (kv?.events !== null && kv?.events !== undefined) {
      const names = kv.events.entries.map((e) => e.name);
      expect(names).toContain('kv.set.start');
      expect(names).toContain('kv.set.finish');
      expect(names).toContain('kv.set.fail');
      expect(names).toContain('kv.delete.fail');
    }
  });

  it('untyped modules list contains updater + menu', () => {
    const slugs = MANIFEST.untyped.map((m) => m.slug).sort();
    expect(slugs).toEqual(['menu', 'updater']);
    for (const u of MANIFEST.untyped) {
      expect(u.title, `untyped ${u.slug} has empty title`).not.toBe('');
      expect(u.reason.length, `untyped ${u.slug} has empty reason`).toBeGreaterThan(20);
    }
  });

  it('generatedAt is a valid ISO timestamp', () => {
    const date = new Date(MANIFEST.generatedAt);
    expect(Number.isNaN(date.getTime())).toBe(false);
  });
});
