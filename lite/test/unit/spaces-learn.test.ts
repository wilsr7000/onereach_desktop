/**
 * Learning Center — curriculum logic, persistence, and Cypher surface.
 *
 * The curriculum content is grounded (wisermethod.com + uxmag.com,
 * fetched 2026-08-07; university/curated-content.ts URLs reused) — so
 * these tests also pin the grounding: no acronym expansion, external
 * URLs only from the shared constants' hosts, mission keys that map
 * onto real asset kinds.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  LEARN_TRACKS,
  LEARNER_ROLES,
  ROLE_TRACK_ORDER,
  effectiveDone,
  emptyLearnProgress,
  findLesson,
  missionComplete,
  nextUp,
  normalizeLearnProgress,
  overallProgress,
  trackProgress,
  tracksForRole,
  type LearnSignals,
} from '../../spaces/learn-content.js';
import { ITEM_KINDS } from '../../spaces/types.js';

const NO_SIGNALS: LearnSignals = { spaces: 0, otherMembers: 0, kinds: {} };

describe('curriculum integrity', () => {
  it('lesson ids are globally unique (progress is keyed on them)', () => {
    const seen = new Set<string>();
    for (const track of LEARN_TRACKS) {
      for (const lesson of track.lessons) {
        expect(seen.has(lesson.id), `duplicate lesson id ${lesson.id}`).toBe(false);
        seen.add(lesson.id);
      }
    }
    expect(seen.size).toBeGreaterThanOrEqual(15);
  });

  it('every lesson is actionable: a body to read or a URL to open', () => {
    for (const track of LEARN_TRACKS) {
      for (const lesson of track.lessons) {
        expect(
          lesson.body !== undefined || lesson.url !== undefined,
          `${lesson.id} has neither body nor url`
        ).toBe(true);
        expect(lesson.minutes).toBeGreaterThan(0);
        expect(lesson.summary.length).toBeGreaterThan(0);
      }
    }
  });

  it('external URLs stay on the grounded hosts (no invented destinations)', () => {
    const allowed = ['www.wisermethod.com', 'uxmag.com', 'learning.staging.onereach.ai'];
    for (const track of LEARN_TRACKS) {
      for (const lesson of track.lessons) {
        if (lesson.url === undefined) continue;
        const host = new URL(lesson.url).hostname;
        expect(allowed, `${lesson.id} points at unexpected host ${host}`).toContain(host);
        expect(new URL(lesson.url).protocol).toBe('https:');
      }
    }
  });

  it('never invents an expansion for the W-I-S-E-R acronym', () => {
    // wisermethod.com deliberately does not expand the acronym; the
    // curriculum must not fabricate one. Guard against the obvious
    // shapes: "W stands for", "W is for", "W — Word" letter lists.
    const text = JSON.stringify(LEARN_TRACKS).toLowerCase();
    expect(text).not.toMatch(/stands for/);
    expect(text).not.toMatch(/w is for|i is for|s is for|e is for|r is for/);
  });

  it('kind-based mission keys are real asset kinds', () => {
    const kindKeys = ['playbook', 'agent', 'transcript', 'knowledge', 'journey'];
    for (const key of kindKeys) {
      expect(ITEM_KINDS as readonly string[], `mission key ${key}`).toContain(key);
    }
    // And every kind-mission in the curriculum is one of those.
    for (const track of LEARN_TRACKS) {
      for (const lesson of track.lessons) {
        if (lesson.mission === undefined) continue;
        expect(['space', 'asset', 'share', ...kindKeys]).toContain(lesson.mission);
      }
    }
  });
});

describe('mission auto-detection', () => {
  it('detects each mission from the matching signal', () => {
    expect(missionComplete('space', { ...NO_SIGNALS, spaces: 1 })).toBe(true);
    expect(missionComplete('space', NO_SIGNALS)).toBe(false);
    expect(missionComplete('share', { ...NO_SIGNALS, otherMembers: 1 })).toBe(true);
    expect(missionComplete('share', NO_SIGNALS)).toBe(false);
    expect(missionComplete('agent', { ...NO_SIGNALS, kinds: { agent: 2 } })).toBe(true);
    expect(missionComplete('transcript', { ...NO_SIGNALS, kinds: { agent: 2 } })).toBe(false);
    // "any asset" counts across kinds.
    expect(missionComplete('asset', { ...NO_SIGNALS, kinds: { document: 1 } })).toBe(true);
  });

  it('effectiveDone = manual completions UNION detected missions', () => {
    const progress = emptyLearnProgress('2026-08-07T00:00:00Z');
    progress.done['wiser-overview'] = '2026-08-07T00:00:00Z';
    const signals: LearnSignals = { spaces: 3, otherMembers: 0, kinds: { agent: 1 } };
    const done = effectiveDone(progress, signals);
    expect(done.has('wiser-overview')).toBe(true); // manual
    expect(done.has('app-space')).toBe(true); // detected (spaces>=1)
    expect(done.has('app-agent')).toBe(true); // detected (agent>=1)
    expect(done.has('app-share')).toBe(false); // not detected
    // Null signals (pre-fetch) → manual only, no crash.
    expect(effectiveDone(progress, null).has('app-space')).toBe(false);
  });
});

describe('progress + personalization', () => {
  it('track and overall percentages are honest', () => {
    const appTrack = LEARN_TRACKS.find((t) => t.id === 'app');
    expect(appTrack).toBeDefined();
    if (appTrack === undefined) return;
    const done = new Set(appTrack.lessons.slice(0, 2).map((l) => l.id));
    const p = trackProgress(appTrack, done);
    expect(p.done).toBe(2);
    expect(p.total).toBe(appTrack.lessons.length);
    expect(p.pct).toBe(Math.round((2 / appTrack.lessons.length) * 100));
    expect(overallProgress(new Set()).pct).toBe(0);
    const everything = new Set(
      LEARN_TRACKS.flatMap((t) => t.lessons.map((l) => l.id))
    );
    expect(overallProgress(everything).pct).toBe(100);
  });

  it('each role reorders tracks; every track always present exactly once', () => {
    for (const role of LEARNER_ROLES) {
      const ordered = tracksForRole(role);
      expect(ordered.map((t) => t.id).sort()).toEqual(
        [...LEARN_TRACKS].map((t) => t.id).sort()
      );
      expect(ordered[0]?.id).toBe(ROLE_TRACK_ORDER[role][0]);
    }
    // Builder leads hands-on; leader leads with the method.
    expect(tracksForRole('builder')[0]?.id).toBe('app');
    expect(tracksForRole('leader')[0]?.id).toBe('wiser');
  });

  it('nextUp walks the role order and skips completed lessons', () => {
    const first = nextUp('builder', new Set());
    expect(first?.track.id).toBe('app');
    expect(first?.lesson.id).toBe('app-space');
    const afterFirst = nextUp('builder', new Set(['app-space']));
    expect(afterFirst?.lesson.id).toBe('app-asset');
    const everything = new Set(LEARN_TRACKS.flatMap((t) => t.lessons.map((l) => l.id)));
    expect(nextUp('builder', everything)).toBeNull();
  });
});

describe('normalizeLearnProgress', () => {
  it('accepts a valid record and drops unknown lesson ids', () => {
    const got = normalizeLearnProgress(
      {
        version: 1,
        role: 'builder',
        done: { 'app-space': '2026-08-07T00:00:00Z', 'deleted-lesson': 'x' },
        lastLessonId: 'app-agent',
      },
      '2026-08-07T01:00:00Z'
    );
    expect(got.role).toBe('builder');
    expect(got.done['app-space']).toBe('2026-08-07T00:00:00Z');
    expect('deleted-lesson' in got.done).toBe(false);
    expect(got.lastLessonId).toBe('app-agent');
  });

  it('degrades garbage to a fresh start instead of throwing', () => {
    for (const garbage of [null, 'nope', 42, [], { role: 'hacker', done: 'x' }]) {
      const got = normalizeLearnProgress(garbage, '2026-08-07T00:00:00Z');
      expect(got.version).toBe(1);
      expect(got.role).toBeNull();
      expect(Object.keys(got.done)).toHaveLength(0);
    }
  });

  it('findLesson resolves every curriculum lesson and rejects unknowns', () => {
    for (const track of LEARN_TRACKS) {
      for (const lesson of track.lessons) {
        expect(findLesson(lesson.id)?.track.id).toBe(track.id);
      }
    }
    expect(findLesson('nope')).toBeNull();
  });
});

describe('learn-store (main process, temp dir)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'learn-store-'));
    const store = await import('../../spaces/learn-store.js');
    store.setLearnStoreDirForTesting(dir);
  });

  afterEach(async () => {
    const store = await import('../../spaces/learn-store.js');
    store.setLearnStoreDirForTesting(null);
    rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips progress through disk', async () => {
    const store = await import('../../spaces/learn-store.js');
    const fresh = await store.readLearnProgress();
    expect(fresh.role).toBeNull();
    const saved = await store.writeLearnProgress({
      version: 1,
      role: 'designer',
      done: { 'wiser-overview': '2026-08-07T00:00:00Z' },
      lastLessonId: 'wiser-overview',
    });
    expect(saved.role).toBe('designer');
    const read = await store.readLearnProgress();
    expect(read.role).toBe('designer');
    expect(read.done['wiser-overview']).toBe('2026-08-07T00:00:00Z');
    expect(read.lastLessonId).toBe('wiser-overview');
  });

  it('normalizes malicious/garbage payloads on write', async () => {
    const store = await import('../../spaces/learn-store.js');
    const saved = await store.writeLearnProgress({
      role: 'root',
      done: { 'not-a-lesson': 'x', 'app-space': '2026-08-07T00:00:00Z' },
      lastLessonId: '../../etc/passwd',
    });
    expect(saved.role).toBeNull();
    expect(Object.keys(saved.done)).toEqual(['app-space']);
    expect(saved.lastLessonId).toBeNull();
  });
});

describe('LEARN_* Cypher surface', () => {
  it('signal queries carry the visibility gates + live-grant time check', async () => {
    const { CYPHER } = await import('../../spaces/sdk-client.js');
    // Asset counts: visibility-gated like every other read.
    expect(CYPHER.LEARN_KIND_COUNTS).toContain('a.deletedAt IS NULL');
    expect(CYPHER.LEARN_KIND_COUNTS).toContain('$viewerId');
    // Space count: same.
    expect(CYPHER.LEARN_SPACE_COUNT).toContain('s.deletedAt IS NULL');
    expect(CYPHER.LEARN_SPACE_COUNT).toContain('$viewerId');
    // Other members: excludes self, respects grant expiry (ADR-052).
    expect(CYPHER.LEARN_OTHER_MEMBERS).toContain('member.id <> $viewerId');
    expect(CYPHER.LEARN_OTHER_MEMBERS).toContain(
      'r.expiresUnixMs IS NULL OR r.expiresUnixMs > $nowMs'
    );
  });
});

describe('Learning Center wiring (source-level)', () => {
  const read = (rel: string): string => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('node:fs') as typeof import('node:fs');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require('node:path') as typeof import('node:path');
    const candidates = [path.resolve(rel), path.resolve('lite', rel)];
    const found = candidates.find((p) => fs.existsSync(p));
    if (found === undefined) throw new Error(`${rel} not found`);
    return fs.readFileSync(found, 'utf8');
  };

  it('the main window Home tab defaults to the configured remote page', () => {
    const src = read('main-window/window.ts');
    expect(src).toContain("'remote-learn'");
    expect(src).toContain('attachRemoteHome(win)');
    // The local Learning Center + old feed stay reachable, opt-in.
    expect(src).toContain("process.env.LITE_HOME === 'learn'");
    expect(src).toContain("process.env.LITE_HOME === 'feed'");
    expect(src).toContain('attachLearnHome(win)');
  });

  it('the learn view gets the kernel preload; lesson links leave via the OS browser', () => {
    const src = read('main-window/window.ts');
    const start = src.indexOf('function attachLearnHome');
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, start + 2600);
    expect(body).toContain('preload: mainWindowConfig.preloadPath');
    expect(body).toContain('shell.openExternal(url)');
    expect(body).toContain("action: 'deny'");
  });

  it('the Spaces window Home is restored (no learn rendering there)', () => {
    const src = read('spaces/spaces.ts');
    const start = src.indexOf('function renderHome(): void {');
    const end = src.indexOf('\n}', start);
    const body = src.slice(start, end);
    expect(body).toContain('buildWelcomeCard()');
    expect(body).not.toContain('buildLearnView');
    const html = read('spaces/spaces.html');
    expect(html).toContain('<span class="spaces-row-name">Home</span>');
  });

  it('the learn page boots via the learn bridge, fail-soft', () => {
    const src = read('learn/learn.ts');
    expect(src).toContain('window.lite?.spaces?.learn');
    expect(src).toContain('Promise.allSettled');
    expect(src).toContain('window.open(lesson.url)');
  });

  it('markdown + hex logo are shared, not duplicated', () => {
    const learn = read('learn/learn.ts');
    expect(learn).toContain("from '../spaces/render-shared.js'");
    const spaces = read('spaces/spaces.ts');
    expect(spaces).toContain("from './render-shared.js'");
    // Exactly one definition of each.
    const shared = read('spaces/render-shared.ts');
    expect(shared).toContain('export function renderMarkdown');
    expect(spaces).not.toContain('export function renderMarkdown(');
    expect(learn).not.toContain('function renderMarkdown(');
  });
});
