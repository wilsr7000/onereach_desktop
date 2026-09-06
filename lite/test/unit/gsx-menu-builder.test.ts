/**
 * GSX menu-builder tests (2026-09-02: the GSX menu the full app has and
 * Lite had lost).
 *
 * Drives initGsxMenuBuilder against the real menu registry with injected
 * deps (sessions, session-change subscription, window opener). Verifies:
 *   - top:gsx sits at order 65 (between IDW 60 and Tools 70), with
 *     "Open GSX Studio" first and a separator before the links;
 *   - one signed-in env → the seven surfaces flat, URLs carrying the
 *     session's accountId; several → a submenu per env;
 *   - signed out → Edison's links without an account id;
 *   - clicks open Lite's GSX window (never the OS browser) with env + url;
 *   - the menu rebuilds on sign-in / sign-out; teardown clears everything.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { registry } from '../../menu/registry.js';
import {
  initGsxMenuBuilder,
  teardownGsxMenuBuilder,
  gsxLinkUrl,
  activeEnvironments,
  GSX_LINKS,
  TOP_LEVEL_ID,
  OPEN_STUDIO_ID,
  AGENT_LIBRARY_ID,
  SEPARATOR_ID,
  TOP_LEVEL_ORDER,
  type GsxMenuDeps,
} from '../../gsx/menu-builder.js';
import type { Environment } from '../../auth/types.js';

function makeDeps(sessions: Partial<Record<Environment, { accountId: string }>>): GsxMenuDeps & {
  fire: () => void;
  openWindow: ReturnType<typeof vi.fn>;
  openCalendar: ReturnType<typeof vi.fn>;
  openAgentLibrary: ReturnType<typeof vi.fn>;
  sessions: Partial<Record<Environment, { accountId: string }>>;
} {
  const listeners: Array<() => void> = [];
  const deps = {
    sessions,
    getSession: (env: Environment) => deps.sessions[env] ?? null,
    onSessionChanged: (cb: () => void) => {
      listeners.push(cb);
      return () => {
        const i = listeners.indexOf(cb);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
    openWindow: vi.fn(async () => ({})),
    openCalendar: vi.fn(),
    openAgentLibrary: vi.fn(),
    environments: ['edison', 'staging', 'production'] as readonly Environment[],
    fire: () => {
      for (const l of [...listeners]) l();
    },
  };
  return deps;
}

const ids = (parentId?: string): string[] => registry.getChildren(parentId).map((e) => e.id);

describe('GSX menu-builder', () => {
  beforeEach(() => {
    registry._resetForTesting();
  });
  afterEach(() => {
    teardownGsxMenuBuilder();
  });

  it('link URLs match the full app: <surface>.<env>.onereach.ai with the account id', () => {
    expect(gsxLinkUrl('hitl', 'edison', 'acct-1')).toBe('https://hitl.edison.onereach.ai/?accountId=acct-1');
    expect(gsxLinkUrl('actiondesk', 'staging', 'a')).toBe('https://actiondesk.staging.onereach.ai/dashboard/?accountId=a');
    expect(gsxLinkUrl('designer', 'edison', null)).toBe('https://studio.edison.onereach.ai/bots');
    expect(gsxLinkUrl('developer', 'edison', '')).toBe('https://docs.edison.onereach.ai/');
    expect(GSX_LINKS.map((l) => l.label)).toEqual([
      'HITL', 'Action Desk', 'Designer', 'Agents', 'Tickets', 'Calendar', 'Developer',
    ]);
    expect(() => gsxLinkUrl('nope', 'edison', null)).toThrow(/unknown GSX link/);
  });

  it('registers top:gsx at order 65: Open GSX Studio, Agent Library…, then a separator', () => {
    const deps = makeDeps({ edison: { accountId: 'acct-1' } });
    initGsxMenuBuilder(deps);
    const top = registry.get(TOP_LEVEL_ID);
    expect(top?.label).toBe('GSX');
    expect(top?.order).toBe(TOP_LEVEL_ORDER);
    expect(TOP_LEVEL_ORDER).toBe(65);
    const children = ids(TOP_LEVEL_ID);
    expect(children[0]).toBe(OPEN_STUDIO_ID);
    expect(children[1]).toBe(AGENT_LIBRARY_ID);
    expect(children[2]).toBe(SEPARATOR_ID);
    expect(registry.get(AGENT_LIBRARY_ID)?.label).toBe('Agent Library…');
  });

  // 2026-09-05: "I don't see the library in the GSX menu" — the Agent
  // Library moved from IDW to GSX. It opens the registry window through
  // the injected opener, never a hosted page; hosts without a registry
  // simply get no item.
  it('Agent Library… opens the registry window; absent when the host has none', () => {
    const deps = makeDeps({ edison: { accountId: 'acct-1' } });
    initGsxMenuBuilder(deps);
    registry.get(AGENT_LIBRARY_ID)?.click?.();
    expect(deps.openAgentLibrary).toHaveBeenCalledTimes(1);
    expect(deps.openWindow).not.toHaveBeenCalled();
    teardownGsxMenuBuilder();
    expect(registry.has(AGENT_LIBRARY_ID)).toBe(false);

    const { openAgentLibrary: _omit, ...without } = deps;
    initGsxMenuBuilder(without);
    expect(registry.has(AGENT_LIBRARY_ID)).toBe(false);
    expect(ids(TOP_LEVEL_ID)[1]).toBe(SEPARATOR_ID);
  });

  it('one signed-in environment: the seven surfaces sit flat, carrying that session’s account id', () => {
    const deps = makeDeps({ edison: { accountId: 'acct-1' } });
    initGsxMenuBuilder(deps);
    const links = ids(TOP_LEVEL_ID).filter((id) => id.startsWith('gsx:link:'));
    expect(links).toEqual(GSX_LINKS.map((l) => `gsx:link:edison:${l.key}`));
    expect(registry.get('gsx:link:edison:hitl')?.label).toBe('HITL');
    expect(ids(TOP_LEVEL_ID).some((id) => id.startsWith('gsx:env:'))).toBe(false);
  });

  it('several signed-in environments: a submenu per environment', () => {
    const deps = makeDeps({ edison: { accountId: 'a' }, staging: { accountId: 'b' } });
    initGsxMenuBuilder(deps);
    expect(ids(TOP_LEVEL_ID)).toEqual([OPEN_STUDIO_ID, AGENT_LIBRARY_ID, SEPARATOR_ID, 'gsx:env:edison', 'gsx:env:staging']);
    expect(registry.get('gsx:env:staging')?.label).toBe('Staging');
    expect(ids('gsx:env:staging')).toEqual(GSX_LINKS.map((l) => `gsx:link:staging:${l.key}`));
  });

  it('signed out: Edison’s links, without an account id', () => {
    const deps = makeDeps({});
    expect(activeEnvironments(deps)).toEqual(['edison']);
    initGsxMenuBuilder(deps);
    registry.get('gsx:link:edison:agents')?.click?.();
    expect(deps.openWindow).toHaveBeenCalledWith(
      expect.objectContaining({ env: 'edison', url: 'https://agents.edison.onereach.ai/agents' })
    );
  });

  it('a click opens Lite’s GSX window with env + url; Open GSX Studio opens the studio root', () => {
    const deps = makeDeps({ edison: { accountId: 'acct-1' } });
    initGsxMenuBuilder(deps);
    registry.get('gsx:link:edison:tickets')?.click?.();
    expect(deps.openWindow).toHaveBeenLastCalledWith({
      env: 'edison',
      url: 'https://tickets.edison.onereach.ai/?accountId=acct-1',
      title: 'Tickets — Edison',
    });
    registry.get(OPEN_STUDIO_ID)?.click?.();
    expect(deps.openWindow).toHaveBeenLastCalledWith({ env: 'edison', title: 'GSX Studio' });
  });

  it('rebuilds on sign-in / sign-out (flat ↔ per-env), and teardown clears everything', () => {
    const deps = makeDeps({ edison: { accountId: 'a' } });
    initGsxMenuBuilder(deps);
    expect(registry.has('gsx:link:edison:hitl')).toBe(true);
    deps.sessions.staging = { accountId: 'b' };
    deps.fire();
    expect(registry.has('gsx:env:staging')).toBe(true);
    expect(registry.get('gsx:link:edison:hitl')?.parentId).toBe('gsx:env:edison');
    delete deps.sessions.staging;
    deps.fire();
    expect(registry.has('gsx:env:staging')).toBe(false);
    expect(registry.get('gsx:link:edison:hitl')?.parentId).toBe(TOP_LEVEL_ID);
    teardownGsxMenuBuilder();
    expect(registry.has(TOP_LEVEL_ID)).toBe(false);
    expect(registry.getChildren().length).toBe(0);
  });

  it('the source never routes a GSX link to the OS browser', () => {
    // Structural: the builder only ever calls the injected openWindow.
    const candidates = ['gsx/menu-builder.ts', 'lite/gsx/menu-builder.ts'].map((p) => resolve(p));
    const found = candidates.find((p) => existsSync(p));
    expect(found).toBeDefined();
    const src = readFileSync(found as string, 'utf8');
    expect(src).not.toContain('shell.openExternal');
    expect(src).toContain('getGsxApi().openWindow(opts)');
  });
});

// ── ADR-090: Calendar opens Lite's own window, never the dead host ──────
describe('GSX menu — Calendar (ADR-090)', () => {
  beforeEach(() => registry._resetForTesting());
  afterEach(() => teardownGsxMenuBuilder());
  it('the Calendar item opens Lite\'s Calendar for the env and never a calendar.<env>.onereach.ai window', () => {
    const deps = makeDeps({ edison: { accountId: 'acct-1' } });
    initGsxMenuBuilder(deps);
    registry.get('gsx:link:edison:calendar')?.click?.();
    expect(deps.openCalendar).toHaveBeenCalledWith('edison');
    expect(deps.openWindow).not.toHaveBeenCalled();
    registry.get('gsx:link:edison:hitl')?.click?.();
    expect(deps.openWindow).toHaveBeenCalledTimes(1);
  });
});
