/**
 * Learning Center page — end-to-end renderer flow.
 *
 * The main window's Home tab (lite/learn/learn.ts). Drives the real
 * page bundle against an in-memory `window.lite.spaces.learn` bridge:
 * first-run render, role personalization, mission auto-detection from
 * workspace signals, lesson modal + completion persistence, and
 * fail-soft when the graph is unreachable.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach } from 'vitest';

interface BridgeEnvelopeOk<T> {
  ok: true;
  value: T;
}
interface BridgeEnvelopeErr {
  ok: false;
  error: { code: string; message: string };
}
type Envelope<T> = BridgeEnvelopeOk<T> | BridgeEnvelopeErr;

interface LearnProgressStub {
  version: 1;
  role: 'designer' | 'builder' | 'leader' | null;
  done: Record<string, string>;
  lastLessonId: string | null;
  updatedAt: string;
}

interface LearnSignalsStub {
  spaces: number;
  otherMembers: number;
  kinds: Record<string, number>;
}

function ok<T>(value: T): Envelope<T> {
  return { ok: true, value };
}

function err(code: string, message: string): Envelope<never> {
  return { ok: false, error: { code, message } };
}

function emptyProgress(): LearnProgressStub {
  return {
    version: 1,
    role: null,
    done: {},
    lastLessonId: null,
    updatedAt: '2026-08-07T00:00:00Z',
  };
}

const NO_SIGNALS: LearnSignalsStub = { spaces: 0, otherMembers: 0, kinds: {} };

function installBridge(overrides: {
  progress?: LearnProgressStub;
  signals?: LearnSignalsStub | 'error';
}): { savedProgress: LearnProgressStub[] } {
  const savedProgress: LearnProgressStub[] = [];
  (window as unknown as { lite?: unknown }).lite = {
    spaces: {
      learn: {
        signals: async (): Promise<Envelope<LearnSignalsStub>> =>
          overrides.signals === 'error'
            ? err('NEON_DOWN', 'graph unreachable')
            : ok(overrides.signals ?? NO_SIGNALS),
        progressGet: async (): Promise<Envelope<LearnProgressStub>> =>
          ok(overrides.progress ?? emptyProgress()),
        progressSave: async (p: LearnProgressStub): Promise<Envelope<LearnProgressStub>> => {
          savedProgress.push(p);
          return ok(p);
        },
      },
    },
  };
  return { savedProgress };
}

async function bootPage(): Promise<void> {
  document.body.innerHTML = '<main id="learn-root" class="learn-page"></main>';
  await import('../../../learn/learn.js');
  const handle = (window as unknown as {
    __learnPageForTesting?: { reinitForTesting(): Promise<void> };
  }).__learnPageForTesting;
  if (handle === undefined) throw new Error('learn page escape hatch missing');
  await handle.reinitForTesting();
  await Promise.resolve();
  await Promise.resolve();
}

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

beforeEach(() => {
  document.body.innerHTML = '';
  delete (window as unknown as { lite?: unknown }).lite;
});

describe('Learning Center page — first run', () => {
  it('renders hero, role picker, and all three tracks', async () => {
    installBridge({});
    await bootPage();
    const root = document.getElementById('learn-root');
    expect(root?.querySelector('.learn-hero')).not.toBeNull();
    expect(root?.querySelector('.learn-hero-title')?.textContent).toContain(
      'Learn the method behind the machine'
    );
    expect(root?.querySelector('.learn-role-picker')).not.toBeNull();
    const tracks = Array.from(root?.querySelectorAll<HTMLElement>('.learn-track') ?? []);
    expect(tracks.map((t) => t.getAttribute('data-track-id'))).toEqual([
      'wiser',
      'app',
      'im',
    ]);
    expect(root?.querySelector('.learn-ring-label')?.textContent).toBe('0%');
  });

  it('the next-up CTA starts at the first lesson of the default order', async () => {
    installBridge({});
    await bootPage();
    const cta = document.querySelector('.learn-cta');
    expect(cta?.textContent).toContain('Start:');
    expect(cta?.textContent).toContain('What the WISER Method is');
  });
});

describe('Learning Center page — role personalization', () => {
  it('picking Builder saves the role and reorders tracks hands-on-first', async () => {
    const bridge = installBridge({});
    await bootPage();
    document
      .querySelector<HTMLButtonElement>('.learn-role-card[data-role="builder"]')
      ?.click();
    await flush();
    expect(bridge.savedProgress[bridge.savedProgress.length - 1]?.role).toBe('builder');
    const tracks = Array.from(document.querySelectorAll<HTMLElement>('.learn-track'));
    expect(tracks[0]?.getAttribute('data-track-id')).toBe('app');
    expect(document.querySelector('.learn-role-picker')).toBeNull();
    expect(document.querySelector('.learn-role-chip')?.textContent).toContain('Builder');
    expect(document.querySelector('.learn-track-rolenote')).not.toBeNull();
  });

  it('a persisted leader role renders method-first without the picker', async () => {
    installBridge({ progress: { ...emptyProgress(), role: 'leader' } });
    await bootPage();
    const tracks = Array.from(document.querySelectorAll<HTMLElement>('.learn-track'));
    expect(tracks[0]?.getAttribute('data-track-id')).toBe('wiser');
    expect(document.querySelector('.learn-role-picker')).toBeNull();
  });
});

describe('Learning Center page — mission auto-detection', () => {
  it('workspace signals check off missions without any clicks', async () => {
    installBridge({
      signals: {
        spaces: 3,
        otherMembers: 1,
        kinds: { agent: 2, transcript: 1, document: 4 },
      },
    });
    await bootPage();
    const isDone = (id: string): boolean =>
      document
        .querySelector(`.learn-lesson[data-lesson-id="${id}"]`)
        ?.classList.contains('is-done') ?? false;
    expect(isDone('app-space')).toBe(true);
    expect(isDone('app-asset')).toBe(true);
    expect(isDone('app-agent')).toBe(true);
    expect(isDone('app-transcript')).toBe(true);
    expect(isDone('app-share')).toBe(true);
    expect(isDone('app-knowledge')).toBe(false);
    expect(isDone('app-journey')).toBe(false);
    expect(
      document.querySelectorAll('.learn-lesson.is-done .learn-lesson-auto').length
    ).toBeGreaterThanOrEqual(5);
    expect(document.querySelector('.learn-ring-label')?.textContent).not.toBe('0%');
  });

  it('a dead graph fails soft: page renders, nothing detected', async () => {
    installBridge({ signals: 'error' });
    await bootPage();
    expect(document.querySelector('.learn-hero')).not.toBeNull();
    expect(document.querySelectorAll('.learn-lesson.is-done')).toHaveLength(0);
    expect(document.querySelector('.learn-ring-label')?.textContent).toBe('0%');
  });
});

describe('Learning Center page — lessons', () => {
  it('opening a lesson shows its markdown and records the resume pointer', async () => {
    const bridge = installBridge({});
    await bootPage();
    document
      .querySelector<HTMLButtonElement>('.learn-lesson[data-lesson-id="wiser-overview"]')
      ?.click();
    await flush();
    const modal = document.querySelector('.learn-modal');
    expect(modal).not.toBeNull();
    expect(modal?.querySelector('.learn-modal-body h1')?.textContent).toContain(
      'What the WISER Method is'
    );
    expect(bridge.savedProgress[bridge.savedProgress.length - 1]?.lastLessonId).toBe(
      'wiser-overview'
    );
  });

  it('Mark complete persists, survives reboot, and drives next-up forward', async () => {
    const bridge = installBridge({});
    await bootPage();
    document
      .querySelector<HTMLButtonElement>('.learn-lesson[data-lesson-id="wiser-overview"]')
      ?.click();
    await flush();
    const doneBtn = document.querySelector<HTMLButtonElement>('.learn-done-toggle');
    expect(doneBtn?.textContent).toBe('Mark complete');
    doneBtn?.click();
    await flush();
    expect(doneBtn?.textContent).toContain('Completed');
    const saved = bridge.savedProgress[bridge.savedProgress.length - 1];
    expect(saved?.done['wiser-overview']).toBeDefined();

    installBridge({ progress: { ...emptyProgress(), done: saved?.done ?? {} } });
    await bootPage();
    expect(
      document
        .querySelector('.learn-lesson[data-lesson-id="wiser-overview"]')
        ?.classList.contains('is-done')
    ).toBe(true);
    expect(document.querySelector('.learn-cta')?.textContent).toContain('Next up:');
  });

  it('Escape closes the modal and re-renders the page', async () => {
    installBridge({});
    await bootPage();
    document
      .querySelector<HTMLButtonElement>('.learn-lesson[data-lesson-id="wiser-maturity"]')
      ?.click();
    await flush();
    expect(document.querySelector('.learn-modal')).not.toBeNull();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await flush();
    expect(document.querySelector('.learn-modal')).toBeNull();
    expect(document.querySelector('.learn-hero')).not.toBeNull();
  });
});
