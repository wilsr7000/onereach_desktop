/**
 * Phase 2b (calendar agent overhaul) -- dedicated regression guard for the
 * schema-version migration runner.
 *
 * The Phase 0 entry criterion: hand-run the migration chain on synthetic v1
 * / v2 / v3 markdown files before any Phase 2 commit lands. This test file
 * encodes that exercise so the runner is exercised in CI from day one.
 *
 * Coverage:
 *   1. Synthetic section v1 -> v2 migration applied on load with markdown
 *      round-trip.
 *   2. Chained v1 -> v2 -> v3 migration produces a v3 file in one load.
 *   3. Missing migration (file at v5 in a v3 build) refuses to load with
 *      the documented user-facing error.
 *   4. Failed mid-migration leaves the original file untouched (atomic-write
 *      contract -- the migration runner throws BEFORE any write hits the
 *      underlying store, so the store's previous content is preserved).
 *
 * SECTION_VERSIONS and MIGRATIONS are deliberately not frozen so tests can
 * mutate them directly. Each test saves and restores its overrides via a
 * try/finally to keep the suite hermetic.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

const calendarMemory = require('../../lib/calendar-memory');

// Test seam matching test/unit/calendar-memory.test.js -- a synthetic
// AgentMemoryStore that lives entirely in-memory.
function makeFakeStore(initialRaw) {
  const sections = new Map();
  let raw = initialRaw || '';
  if (raw) {
    const lines = raw.split('\n');
    let cur = '_header';
    let buf = [];
    for (const line of lines) {
      const m = line.match(/^##\s+(.+)$/);
      if (m) {
        sections.set(cur, buf.join('\n').trim());
        cur = m[1].trim();
        buf = [];
      } else {
        if (cur === '_header' && /^#\s+/.test(line)) continue;
        buf.push(line);
      }
    }
    sections.set(cur, buf.join('\n').trim());
  }

  const store = {
    isLoaded: () => true,
    isDirty: () => store._dirty,
    _dirty: false,
    async load() {
      return true;
    },
    async save() {
      store._dirty = false;
      return true;
    },
    getSection(name) {
      return sections.get(name) || null;
    },
    updateSection(name, content) {
      sections.set(name, content);
      store._dirty = true;
    },
    appendToSection(name, entry) {
      const cur = sections.get(name) || '';
      sections.set(name, cur ? `${cur}\n${entry}` : entry);
      store._dirty = true;
    },
    getSectionNames() {
      return [...sections.keys()].filter((k) => k !== '_header');
    },
    parseSectionAsKeyValue() {
      return {};
    },
    getRaw() {
      return raw;
    },
    setRaw(r) {
      raw = r;
      store._dirty = true;
    },
  };
  return store;
}

// Helper: temporarily override a section's target version + migration table.
function withSyntheticMigration({ section, version, migrations }, fn) {
  const originalVersion = calendarMemory.SECTION_VERSIONS[section];
  const originalMigrations = calendarMemory.MIGRATIONS[section];

  calendarMemory.SECTION_VERSIONS[section] = version;
  if (migrations) {
    calendarMemory.MIGRATIONS[section] = migrations;
  }

  return Promise.resolve(fn()).finally(() => {
    calendarMemory.SECTION_VERSIONS[section] = originalVersion;
    if (originalMigrations) {
      calendarMemory.MIGRATIONS[section] = originalMigrations;
    } else {
      delete calendarMemory.MIGRATIONS[section];
    }
  });
}

let tmpDir;

beforeEach(() => {
  calendarMemory._resetForTests();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cal-mem-mig-test-'));
  calendarMemory._setSidecarPathForTests(path.join(tmpDir, 'sidecar.jsonl'));
});

afterEach(() => {
  calendarMemory._resetForTests();
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe('Phase 2b: schema-version migration runner', () => {
  describe('1) synthetic v1 -> v2 migration', () => {
    it('applies a single-step migration on load and bumps the section comment', async () => {
      const v1Section = '<!-- schemaVersion: 1 -->\n- entry: legacy';
      const fakeStore = makeFakeStore(`## Cadences\n${v1Section}\n`);

      const mem = new calendarMemory.CalendarMemory();
      mem._setStoreForTests(fakeStore);

      await withSyntheticMigration(
        {
          section: 'Cadences',
          version: 2,
          migrations: {
            1: (content) =>
              content.replace(/<!--\s*schemaVersion:\s*1\s*-->/, '').concat('\n- migrated-marker: v2'),
          },
        },
        async () => {
          await mem.load();
          const after = mem.getSectionRaw('Cadences');
          expect(after).toMatch(/<!--\s*schemaVersion:\s*2\s*-->/);
          expect(after).toContain('migrated-marker: v2');
          expect(after).toContain('entry: legacy');
        }
      );
    });
  });

  describe('2) chained v1 -> v2 -> v3 produces a v3 file in one load', () => {
    it('runs both migrations and stamps the latest version', async () => {
      const v1Section = '<!-- schemaVersion: 1 -->\n- entry: original';
      const fakeStore = makeFakeStore(`## Cadences\n${v1Section}\n`);

      const mem = new calendarMemory.CalendarMemory();
      mem._setStoreForTests(fakeStore);

      await withSyntheticMigration(
        {
          section: 'Cadences',
          version: 3,
          migrations: {
            1: (content) =>
              content.replace(/<!--\s*schemaVersion:\s*1\s*-->/, '').concat('\n- mig-1to2: applied'),
            2: (content) =>
              content.replace(/<!--\s*schemaVersion:\s*2\s*-->/, '').concat('\n- mig-2to3: applied'),
          },
        },
        async () => {
          await mem.load();
          const after = mem.getSectionRaw('Cadences');
          expect(after).toMatch(/<!--\s*schemaVersion:\s*3\s*-->/);
          expect(after).toContain('mig-1to2: applied');
          expect(after).toContain('mig-2to3: applied');
          expect(after).toContain('entry: original');
        }
      );
    });
  });

  describe('3) missing migration: section at v5 in a v3 build', () => {
    it('refuses to load with the documented user-facing error', async () => {
      const v5Section = '<!-- schemaVersion: 5 -->\n- entry: future-format';
      const fakeStore = makeFakeStore(`## Cadences\n${v5Section}\n`);

      const mem = new calendarMemory.CalendarMemory();
      mem._setStoreForTests(fakeStore);

      await withSyntheticMigration({ section: 'Cadences', version: 3 }, async () => {
        await expect(mem.load()).rejects.toThrow(/v5.*v3.*Refusing to load/i);
      });
    });

    it('refuses to load when an intermediate migration is missing (v1 -> v3 with no v2)', async () => {
      const v1Section = '<!-- schemaVersion: 1 -->\n- entry: x';
      const fakeStore = makeFakeStore(`## Cadences\n${v1Section}\n`);

      const mem = new calendarMemory.CalendarMemory();
      mem._setStoreForTests(fakeStore);

      await withSyntheticMigration(
        {
          section: 'Cadences',
          version: 3,
          migrations: {
            1: (content) => content.concat('\n- v2'),
            // intentionally missing 2: ...
          },
        },
        async () => {
          await expect(mem.load()).rejects.toThrow(/v2 -> v3.*Refusing to silently truncate/i);
        }
      );
    });
  });

  describe('4) atomic-write: failed migration does not corrupt the store', () => {
    it('throw inside a migration leaves prior content untouched', async () => {
      const v1Section = '<!-- schemaVersion: 1 -->\n- entry: trusted-original';
      const fakeStore = makeFakeStore(`## Cadences\n${v1Section}\n`);
      const beforeContent = fakeStore.getSection('Cadences');

      const mem = new calendarMemory.CalendarMemory();
      mem._setStoreForTests(fakeStore);

      await withSyntheticMigration(
        {
          section: 'Cadences',
          version: 2,
          migrations: {
            1: () => {
              throw new Error('synthetic migration failure');
            },
          },
        },
        async () => {
          await expect(mem.load()).rejects.toThrow(/synthetic migration failure/);
          const afterContent = fakeStore.getSection('Cadences');
          expect(afterContent).toBe(beforeContent);
        }
      );
    });
  });

  describe('file-level version refusal', () => {
    it('rejects a calendarMemoryVersion higher than the build supports', async () => {
      const fakeStore = makeFakeStore('<!-- calendarMemoryVersion: 99 -->\n');
      const mem = new calendarMemory.CalendarMemory();
      mem._setStoreForTests(fakeStore);

      await expect(mem.load()).rejects.toThrow(/version 99.*version 1.*update Onereach\.ai/i);
    });
  });

  describe('happy path: file has no version comment yet (legacy)', () => {
    it('seeds defaults and stamps the current version on load', async () => {
      const fakeStore = makeFakeStore('');
      const mem = new calendarMemory.CalendarMemory();
      mem._setStoreForTests(fakeStore);

      await mem.load();

      const header = fakeStore.getSection('_header') || '';
      expect(header).toMatch(/<!--\s*calendarMemoryVersion:\s*1\s*-->/);

      for (const name of calendarMemory.SECTION_ORDER) {
        const content = fakeStore.getSection(name);
        expect(content).toMatch(/<!--\s*schemaVersion:\s*\d+\s*-->/);
      }
    });
  });
});
