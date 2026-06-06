/**
 * Boot-chat renderer tests.
 *
 * Exercises the pure builders (bubbles, action button, name pretty-
 * print) plus the state machine via a stubbed auth bridge. The bundle
 * is imported once and the test escape hatch on
 * `window.__bootChatForTesting` surfaces the symbols.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';

interface BootChatTestApi {
  buildBotBubble(text: string): HTMLElement;
  buildBotBubbleRich(node: HTMLElement): HTMLElement;
  buildUserBubble(text: string): HTMLElement;
  buildTypingBubble(): HTMLElement;
  buildErrorBubble(text: string): HTMLElement;
  buildActionButton(opts: {
    label: string;
    primary?: boolean;
    icon?: string;
    onClick: () => void;
  }): HTMLElement;
  buildWelcomeFirstTime(): HTMLElement;
  buildWelcomeBack(name: string): HTMLElement;
  buildWelcomeBackPrompt(name: string): HTMLElement;
  buildWelcomeHeadline(name: string): HTMLElement;
  buildWelcomeExpired(name: string): HTMLElement;
  buildEventDigestBubble(digest: {
    totalEvents: number;
    bullets: string[];
    oldestTimestamp: string | null;
  }): HTMLElement;
  friendlyNameFromSession(s: { accountId: string; email?: string }): string;
  runBootChat(deps: {
    thread: HTMLElement;
    actions: HTMLElement;
    auth: StubAuthBridge;
    spaces?: StubSpacesBridge;
    onFinish: () => void;
    schedule?: (fn: () => void, ms: number) => void;
  }): Promise<void>;
}

interface StubSpacesBridge {
  listRecentEvents(opts?: { limit?: number; since?: number }): Promise<
    | {
        ok: true;
        value: Array<{
          id: string;
          author: string;
          kind: string;
          timestamp: string;
          spaceId?: string;
          spaceName?: string;
        }>;
      }
    | { ok: false; error: { code: string; message: string } }
  >;
}

interface StubAuthBridge {
  getSession(env: 'edison'): Promise<{
    session: { accountId: string; email?: string; capturedAt: number } | null;
  }>;
  hasValidSession(env: 'edison'): Promise<{ valid: boolean }>;
  signIn(
    env: 'edison'
  ): Promise<{
    session: { accountId: string; email?: string; capturedAt: number };
  }>;
}

let api: BootChatTestApi;

beforeAll(async () => {
  await import('../../boot-chat/boot-chat.js');
  api = (window as unknown as { __bootChatForTesting: BootChatTestApi })
    .__bootChatForTesting;
  expect(api).toBeDefined();
});

let thread: HTMLElement;
let actions: HTMLElement;

beforeEach(() => {
  thread = document.createElement('section');
  actions = document.createElement('section');
  // Make sure actions is "hidden" by default (mirror real HTML).
  actions.hidden = true;
});

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

// ─── Pure builders ──────────────────────────────────────────────────────

describe('boot-chat builders', () => {
  it('buildBotBubble renders an avatar + text-content body', () => {
    const el = api.buildBotBubble('hello');
    expect(el.classList.contains('boot-chat-bubble-bot')).toBe(true);
    expect(el.querySelector('.boot-chat-avatar')).not.toBeNull();
    expect(el.querySelector('.boot-chat-bubble-body')?.textContent).toBe('hello');
  });

  it('buildBotBubble uses textContent (XSS guard)', () => {
    const el = api.buildBotBubble('<img src=x onerror=alert(1)>');
    expect(el.querySelector('img')).toBeNull();
    expect(el.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('buildUserBubble renders on the right side with "You" avatar', () => {
    const el = api.buildUserBubble('me');
    expect(el.classList.contains('boot-chat-bubble-user')).toBe(true);
    expect(el.querySelector('.boot-chat-avatar')?.textContent).toBe('You');
  });

  it('buildTypingBubble has data-typing + three dots', () => {
    const el = api.buildTypingBubble();
    expect(el.getAttribute('data-typing')).toBe('true');
    expect(el.querySelectorAll('.boot-chat-typing-dot')).toHaveLength(3);
  });

  it('buildErrorBubble carries the is-error class', () => {
    const el = api.buildErrorBubble('boom');
    expect(el.classList.contains('is-error')).toBe(true);
    expect(el.querySelector('.boot-chat-bubble-body')?.textContent).toBe('boom');
  });

  it('buildActionButton fires onClick + carries label', () => {
    let clicked = false;
    const btn = api.buildActionButton({
      label: 'Sign in',
      onClick: () => {
        clicked = true;
      },
    });
    btn.click();
    expect(clicked).toBe(true);
    expect(btn.textContent).toContain('Sign in');
  });

  it('buildActionButton primary=false uses secondary class', () => {
    const btn = api.buildActionButton({
      label: 'Cancel',
      primary: false,
      onClick: () => undefined,
    });
    expect(btn.classList.contains('boot-chat-button-secondary')).toBe(true);
  });

  it('buildActionButton optionally renders an icon', () => {
    const btn = api.buildActionButton({
      label: 'Go',
      icon: '→',
      onClick: () => undefined,
    });
    expect(btn.querySelector('.boot-chat-button-icon')?.textContent).toBe('→');
  });

  it('buildWelcomeFirstTime mentions "new Onereach App"', () => {
    const el = api.buildWelcomeFirstTime();
    expect(el.textContent ?? '').toMatch(/new Onereach App/i);
  });

  it('buildWelcomeBack includes the display name when supplied', () => {
    const el = api.buildWelcomeBack('Robb');
    expect(el.textContent ?? '').toMatch(/Robb/);
    expect(el.textContent ?? '').toMatch(/Opening your workspace/i);
  });

  it('buildWelcomeExpired explains the re-verify reason', () => {
    const el = api.buildWelcomeExpired('Robb');
    expect(el.textContent ?? '').toMatch(/expired/i);
  });

  it('buildWelcomeBackPrompt waits for the user (no "Opening…")', () => {
    const el = api.buildWelcomeBackPrompt('Robb');
    expect(el.textContent ?? '').toMatch(/Welcome back, Robb/i);
    expect(el.textContent ?? '').toMatch(/ready when you are/i);
    // Importantly: doesn't say "Opening your workspace…" (that's the
    // transition copy — and post-fix, returning users never see the
    // auto-advance transition).
    expect(el.textContent ?? '').not.toMatch(/Opening your workspace/);
  });

  it('buildWelcomeHeadline is a tight headline (no body copy)', () => {
    const el = api.buildWelcomeHeadline('Robb');
    expect(el.tagName).toBe('STRONG');
    expect(el.textContent).toBe('Welcome back, Robb.');
  });

  it('buildEventDigestBubble: empty digest → "quiet" line', () => {
    const el = api.buildEventDigestBubble({
      totalEvents: 0,
      bullets: [],
      oldestTimestamp: null,
    });
    expect(el.textContent ?? '').toMatch(/quiet/i);
    expect(el.querySelector('ul')).toBeNull();
  });

  it('buildEventDigestBubble: bullets render as a <ul>', () => {
    const el = api.buildEventDigestBubble({
      totalEvents: 3,
      bullets: [
        'Alice added 2 items in Engineering',
        'Bob updated a item in Q3 Audit',
      ],
      oldestTimestamp: '2026-05-18T00:00:00Z',
    });
    expect(el.textContent ?? '').toMatch(/Since you were last here/);
    const items = el.querySelectorAll('ul.boot-chat-digest-list li');
    expect(items).toHaveLength(2);
    expect(items[0]?.textContent).toBe('Alice added 2 items in Engineering');
  });

  it('buildEventDigestBubble: shows "+N more" when total > shown bullets', () => {
    const el = api.buildEventDigestBubble({
      totalEvents: 17,
      bullets: ['Alice added 5 items in Engineering'],
      oldestTimestamp: '2026-05-18T00:00:00Z',
    });
    expect(el.querySelector('.boot-chat-digest-more')?.textContent ?? '').toMatch(
      /\+16 more/
    );
  });

  it('buildEventDigestBubble: omits "more" footer when totals match', () => {
    const el = api.buildEventDigestBubble({
      totalEvents: 2,
      bullets: ['Alice added 2 items in Engineering', 'Bob updated a item'],
      oldestTimestamp: '2026-05-18T00:00:00Z',
    });
    expect(el.querySelector('.boot-chat-digest-more')).toBeNull();
  });
});

describe('friendlyNameFromSession', () => {
  it('uses the email local part when present, titlecased', () => {
    expect(
      api.friendlyNameFromSession({
        accountId: 'acc-1',
        email: 'robb.wilson@onereach.ai',
      })
    ).toBe('Robb Wilson');
  });

  it('splits on dots / underscores / hyphens', () => {
    expect(
      api.friendlyNameFromSession({
        accountId: 'acc-1',
        email: 'jane_doe@example.com',
      })
    ).toBe('Jane Doe');
    expect(
      api.friendlyNameFromSession({
        accountId: 'acc-1',
        email: 'jane-doe@example.com',
      })
    ).toBe('Jane Doe');
  });

  it('falls back to accountId when email is missing', () => {
    expect(api.friendlyNameFromSession({ accountId: 'acc-1' })).toBe('acc-1');
  });
});

// ─── State machine ──────────────────────────────────────────────────────

function buildStubBridge(opts: {
  session?: { accountId: string; email?: string; capturedAt: number } | null;
  valid?: boolean;
  signInReturn?: { accountId: string; email?: string; capturedAt: number };
  signInReject?: Error;
}): StubAuthBridge {
  const session = opts.session ?? null;
  const valid = opts.valid ?? false;
  return {
    getSession: async () => ({ session }),
    hasValidSession: async () => ({ valid }),
    signIn: async () => {
      if (opts.signInReject !== undefined) throw opts.signInReject;
      return {
        session:
          opts.signInReturn ??
          { accountId: 'acc-new', email: 'new@onereach.ai', capturedAt: Date.now() },
      };
    },
  };
}

describe('runBootChat — state transitions', () => {
  it('valid session → "Welcome back" headline + event digest, then onFinish (no CTA)', async () => {
    let finished = false;
    const spaces: StubSpacesBridge = {
      listRecentEvents: async () => ({
        ok: true,
        value: [
          {
            id: 'c1',
            author: 'alice@onereach.ai',
            kind: 'item:added',
            timestamp: '2026-05-18T10:00:00Z',
            spaceName: 'Engineering',
          },
          {
            id: 'c2',
            author: 'alice@onereach.ai',
            kind: 'item:added',
            timestamp: '2026-05-18T10:01:00Z',
            spaceName: 'Engineering',
          },
          {
            id: 'c3',
            author: 'Audit Agent',
            kind: 'item:added',
            timestamp: '2026-05-18T11:00:00Z',
            spaceName: 'Q3 Audit',
          },
        ],
      }),
    };
    await api.runBootChat({
      thread,
      actions,
      auth: buildStubBridge({
        session: { accountId: 'acc-1', email: 'robb@onereach.ai', capturedAt: 1 },
        valid: true,
      }),
      spaces,
      onFinish: () => {
        finished = true;
      },
      schedule: () => undefined,
    });
    // Welcome headline appears as a bot bubble.
    expect(thread.textContent ?? '').toMatch(/Welcome back, Robb\./);
    // Digest bubble appears with bullets summarizing the events.
    expect(thread.textContent ?? '').toMatch(/Since you were last here/);
    const bullets = thread.querySelectorAll('ul.boot-chat-digest-list li');
    expect(bullets.length).toBeGreaterThan(0);
    expect(
      Array.from(bullets).map((li) => li.textContent ?? '')
    ).toEqual(expect.arrayContaining([expect.stringMatching(/Alice added 2 items in Engineering/)]));
    // The chat IS the Home tab — no "Open my workspace" handoff.
    // onFinish fires automatically once the chat settles, the action
    // row stays hidden, and the user moves on by opening an IDW tab.
    expect(finished).toBe(true);
    expect(actions.hidden).toBe(true);
    expect(actions.querySelector('button')).toBeNull();
  });

  it('valid session, no events → "quiet" line instead of bullets', async () => {
    let finished = false;
    const spaces: StubSpacesBridge = {
      listRecentEvents: async () => ({ ok: true, value: [] }),
    };
    await api.runBootChat({
      thread,
      actions,
      auth: buildStubBridge({
        session: { accountId: 'acc-1', email: 'robb@onereach.ai', capturedAt: 1 },
        valid: true,
      }),
      spaces,
      onFinish: () => {
        finished = true;
      },
      schedule: () => undefined,
    });
    expect(thread.textContent ?? '').toMatch(/Welcome back, Robb\./);
    expect(thread.textContent ?? '').toMatch(/quiet/i);
    expect(thread.querySelector('ul.boot-chat-digest-list')).toBeNull();
    expect(finished).toBe(true);
  });

  it('valid session, no spaces bridge → digest is skipped silently', async () => {
    let finished = false;
    await api.runBootChat({
      thread,
      actions,
      auth: buildStubBridge({
        session: { accountId: 'acc-1', email: 'robb@onereach.ai', capturedAt: 1 },
        valid: true,
      }),
      // No spaces bridge.
      onFinish: () => {
        finished = true;
      },
      schedule: () => undefined,
    });
    expect(thread.textContent ?? '').toMatch(/Welcome back, Robb\./);
    // No digest bubble appended.
    expect(thread.textContent ?? '').not.toMatch(/Since you were last here/);
    expect(thread.textContent ?? '').not.toMatch(/quiet/i);
    // Still settles into the Home-tab resting state.
    expect(finished).toBe(true);
  });

  it('valid session, spaces bridge errors → digest soft-fails, chat still settles', async () => {
    let finished = false;
    const spaces: StubSpacesBridge = {
      listRecentEvents: async () => ({
        ok: false,
        error: { code: 'NETWORK', message: 'down' },
      }),
    };
    await api.runBootChat({
      thread,
      actions,
      auth: buildStubBridge({
        session: { accountId: 'acc-1', email: 'robb@onereach.ai', capturedAt: 1 },
        valid: true,
      }),
      spaces,
      onFinish: () => {
        finished = true;
      },
      schedule: () => undefined,
    });
    // Welcome bubble appears; digest bubble is omitted; no CTA — the
    // chat still settles into the Home-tab resting state.
    expect(thread.textContent ?? '').toMatch(/Welcome back, Robb\./);
    expect(thread.textContent ?? '').not.toMatch(/Since you were last here/);
    expect(actions.hidden).toBe(true);
    expect(finished).toBe(true);
  });

  it('no session at all → "Welcome to your new Onereach App" + sign-in button', async () => {
    await api.runBootChat({
      thread,
      actions,
      auth: buildStubBridge({ session: null, valid: false }),
      onFinish: () => undefined,
      schedule: () => undefined,
    });
    expect(thread.textContent ?? '').toMatch(/new Onereach App/i);
    expect(actions.hidden).toBe(false);
    expect(actions.querySelector('.boot-chat-button')?.textContent).toMatch(
      /Sign in/i
    );
  });

  it('expired session → "Welcome back" + re-verify CTA', async () => {
    await api.runBootChat({
      thread,
      actions,
      auth: buildStubBridge({
        session: { accountId: 'acc-1', email: 'alice@onereach.ai', capturedAt: 1 },
        valid: false,
      }),
      onFinish: () => undefined,
      schedule: () => undefined,
    });
    expect(thread.textContent ?? '').toMatch(/Welcome back/i);
    expect(thread.textContent ?? '').toMatch(/expired/i);
    expect(actions.querySelector('.boot-chat-button')?.textContent).toMatch(
      /Re-verify/i
    );
  });

  it('sign-in success → "Welcome back" + onFinish auto-fires (no "Open my workspace")', async () => {
    let finished = false;
    await api.runBootChat({
      thread,
      actions,
      auth: buildStubBridge({
        session: null,
        valid: false,
        signInReturn: { accountId: 'acc-2', email: 'bob@onereach.ai', capturedAt: 2 },
      }),
      onFinish: () => {
        finished = true;
      },
      schedule: () => undefined,
    });
    // Click the sign-in button (welcome-first-time CTA).
    const signInBtn = actions.querySelector('button');
    expect(signInBtn?.textContent ?? '').toMatch(/Sign in/i);
    signInBtn?.click();
    await flush();
    expect(thread.textContent ?? '').toMatch(/Welcome back/i);
    expect(thread.textContent ?? '').toMatch(/Bob/);
    // The chat IS the Home tab now — no second-step "Open my workspace"
    // CTA. onFinish fires as soon as the welcome + digest render so
    // the host can un-suspend the re-sign-in prompter.
    expect(finished).toBe(true);
    expect(actions.hidden).toBe(true);
    expect(actions.querySelector('button')).toBeNull();
  });

  it('sign-in failure → error bubble + "Try again" button (no onFinish)', async () => {
    let finished = false;
    await api.runBootChat({
      thread,
      actions,
      auth: buildStubBridge({
        session: null,
        valid: false,
        signInReject: new Error('User cancelled the popup'),
      }),
      onFinish: () => {
        finished = true;
      },
      schedule: () => undefined,
    });
    const button = actions.querySelector('button');
    button?.click();
    await flush();
    expect(thread.textContent ?? '').toMatch(/cancelled/i);
    expect(actions.querySelector('button')?.textContent).toMatch(/Try again/i);
    expect(finished).toBe(false);
  });

  it('getSession throws → error bubble + Retry button', async () => {
    let finished = false;
    const bridge: StubAuthBridge = {
      getSession: async () => {
        throw new Error('network');
      },
      hasValidSession: async () => ({ valid: false }),
      signIn: async () => ({
        session: { accountId: 'x', capturedAt: 0 },
      }),
    };
    await api.runBootChat({
      thread,
      actions,
      auth: bridge,
      onFinish: () => {
        finished = true;
      },
      schedule: () => undefined,
    });
    expect(thread.textContent ?? '').toMatch(/network might be off/i);
    expect(actions.querySelector('button')?.textContent).toMatch(/Retry/i);
    expect(finished).toBe(false);
  });
});
