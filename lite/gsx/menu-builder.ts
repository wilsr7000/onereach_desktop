/**
 * GSX menu builder — the `GSX` top-level menu the full app has and Lite
 * lost somewhere along the way (2026-09-02: "Somehow I forgot to add
 * the GSX menu from the main app to LITE, I'm not sure how we lost it").
 *
 * Mirrors full's `generateDefaultGSXLinks` (menu.js): one set of GSX
 * surfaces per OneReach environment — HITL, Action Desk, Designer,
 * Agents, Tickets, Calendar, Developer — each carrying the account id
 * of the signed-in session as `?accountId=`. Plus "Open GSX Studio"
 * at the top.
 *
 * What differs from full, deliberately:
 *  - Environments come from the AUTH SESSIONS (whoever is signed in,
 *    per env), not from the IDW list — Lite's account id lives on the
 *    session (ADR-068), so no URL scraping. With a single signed-in
 *    env the links sit flat under GSX; with several, one submenu per
 *    environment. Signed out, Edison's links are offered without an
 *    account id (GSX asks for the account itself).
 *  - Every link opens in Lite's GSX window (`lite/gsx/window.ts`):
 *    the session cookie is injected before the load, the UA is
 *    Chrome-shaped, navigation is contained to *.onereach.ai — the
 *    page comes up signed in instead of bouncing through the OS browser.
 *  - The menu rebuilds itself on every sign-in / sign-out.
 *
 * Order 65 slots it between IDW (60) and Tools (70), where full has it.
 * No accelerators (ADR-015).
 *
 * @internal
 */

import { registry } from '../menu/registry.js';
import { getAuthApi, SUPPORTED_ENVIRONMENTS } from '../auth/api.js';
import type { Environment } from '../auth/types.js';
import { getGsxApi } from './api.js';
import { getCalendarApi } from '../calendar/api.js';
import { getLoggingApi } from '../logging/api.js';
import { GSX_EVENTS } from './events.js';

export const TOP_LEVEL_ID = 'top:gsx';
export const OPEN_STUDIO_ID = 'gsx:open-studio';
export const SEPARATOR_ID = 'gsx:sep-links';
/** Order 65: between IDW (60) and Tools (70), matching the full app. */
export const TOP_LEVEL_ORDER = 65;

/** The GSX surfaces, in the order full lists them. */
export const GSX_LINKS: ReadonlyArray<{ key: string; label: string; host: string; path: string }> = [
  { key: 'hitl', label: 'HITL', host: 'hitl', path: '/' },
  { key: 'actiondesk', label: 'Action Desk', host: 'actiondesk', path: '/dashboard/' },
  { key: 'designer', label: 'Designer', host: 'studio', path: '/bots' },
  { key: 'agents', label: 'Agents', host: 'agents', path: '/agents' },
  { key: 'tickets', label: 'Tickets', host: 'tickets', path: '/' },
  { key: 'calendar', label: 'Calendar', host: 'calendar', path: '/' },
  { key: 'developer', label: 'Developer', host: 'docs', path: '/' },
];

/** `https://<host>.<env>.onereach.ai<path>[?accountId=…]` — full's `withAccount`. */
export function gsxLinkUrl(key: string, env: Environment, accountId: string | null): string {
  const link = GSX_LINKS.find((l) => l.key === key);
  if (link === undefined) throw new Error(`unknown GSX link: ${key}`);
  const base = `https://${link.host}.${env}.onereach.ai${link.path}`;
  return accountId !== null && accountId.length > 0 ? `${base}?accountId=${encodeURIComponent(accountId)}` : base;
}

export function envLabel(env: Environment): string {
  return env.charAt(0).toUpperCase() + env.slice(1);
}

export interface GsxMenuDeps {
  /** The signed-in session for an env (null when signed out). */
  getSession: (env: Environment) => { accountId: string } | null;
  /** Subscribe to sign-in / sign-out; returns an unsubscribe. */
  onSessionChanged: (cb: () => void) => () => void;
  /** Open a GSX window (Lite's signed-in, contained window). */
  openWindow: (opts: { env: Environment; url?: string; title?: string }) => Promise<unknown>;
  /** Environments to consider, in menu order. */
  environments: readonly Environment[];
  /** ADR-090 — the Calendar link opens Lite's own Calendar (scheduled flows), not a hosted page. */
  openCalendar: (env: Environment) => void;
}

let initialized = false;
let depsRef: GsxMenuDeps | null = null;
let unsubscribe: (() => void) | null = null;
const dynamicIds = new Set<string>();

function defaultDeps(): GsxMenuDeps {
  return {
    getSession: (env) => {
      const s = getAuthApi().getSession(env);
      return s === null ? null : { accountId: s.accountId };
    },
    onSessionChanged: (cb) => getAuthApi().onSessionChanged(() => cb()),
    openWindow: (opts) => getGsxApi().openWindow(opts),
    environments: SUPPORTED_ENVIRONMENTS,
    openCalendar: () => {
      void getCalendarApi().openWindow();
    },
  };
}

export function initGsxMenuBuilder(overrides: Partial<GsxMenuDeps> = {}): void {
  if (initialized) return;
  const deps: GsxMenuDeps = { ...defaultDeps(), ...overrides };
  depsRef = deps;

  registry.upsert({ id: TOP_LEVEL_ID, type: 'top-level', label: 'GSX', order: TOP_LEVEL_ORDER });
  registry.upsert({
    id: OPEN_STUDIO_ID,
    type: 'item',
    parentId: TOP_LEVEL_ID,
    label: 'Open GSX Studio',
    order: 0,
    click: () => openStudio(),
  });
  registry.upsert({ id: SEPARATOR_ID, type: 'separator', parentId: TOP_LEVEL_ID, order: 10 });

  rebuild();
  unsubscribe = deps.onSessionChanged(() => rebuild());
  initialized = true;
}

export function teardownGsxMenuBuilder(): void {
  if (!initialized) return;
  try {
    unsubscribe?.();
  } catch {
    /* best-effort */
  }
  unsubscribe = null;
  for (const id of dynamicIds) registry.unregister(id);
  dynamicIds.clear();
  registry.unregister(SEPARATOR_ID);
  registry.unregister(OPEN_STUDIO_ID);
  registry.unregister(TOP_LEVEL_ID);
  depsRef = null;
  initialized = false;
}

/** Signed-in environments, in menu order; Edison alone when signed out. */
export function activeEnvironments(deps: GsxMenuDeps): Environment[] {
  const signedIn = deps.environments.filter((env) => deps.getSession(env) !== null);
  return signedIn.length > 0 ? signedIn : ['edison'];
}

function rebuild(): void {
  const deps = depsRef;
  if (deps === null) return;
  const envs = activeEnvironments(deps);
  const wanted = new Map<string, Parameters<typeof registry.upsert>[0]>();

  if (envs.length === 1) {
    const env = envs[0] as Environment;
    GSX_LINKS.forEach((link, i) => {
      wanted.set(`gsx:link:${env}:${link.key}`, {
        id: `gsx:link:${env}:${link.key}`,
        type: 'item',
        parentId: TOP_LEVEL_ID,
        label: link.label,
        order: 100 + i,
        click: link.key === 'calendar' ? () => openCalendar(env) : () => openLink(env, link.key, link.label),
      });
    });
  } else {
    envs.forEach((env, e) => {
      const envId = `gsx:env:${env}`;
      wanted.set(envId, { id: envId, type: 'item', parentId: TOP_LEVEL_ID, label: envLabel(env), order: 100 + e });
      GSX_LINKS.forEach((link, i) => {
        wanted.set(`gsx:link:${env}:${link.key}`, {
          id: `gsx:link:${env}:${link.key}`,
          type: 'item',
          parentId: envId,
          label: link.label,
          order: i,
          click: link.key === 'calendar' ? () => openCalendar(env) : () => openLink(env, link.key, link.label),
        });
      });
    });
  }

  for (const id of Array.from(dynamicIds)) {
    if (!wanted.has(id)) {
      registry.unregister(id);
      dynamicIds.delete(id);
    }
  }
  for (const [id, entry] of wanted) {
    registry.upsert(entry);
    dynamicIds.add(id);
  }
}

function openStudio(): void {
  const deps = depsRef;
  if (deps === null) return;
  const env = activeEnvironments(deps)[0] ?? 'edison';
  getLoggingApi().event(GSX_EVENTS.MENU_OPEN_STUDIO, { env });
  deps.openWindow({ env, title: 'GSX Studio' }).catch((err: unknown) => {
    getLoggingApi().warn('gsx', 'menu: Open GSX Studio failed', {
      env,
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

/** ADR-090 — Calendar: Lite's scheduled-flows window (calendar.<env>.onereach.ai does not exist). */
function openCalendar(env: Environment): void {
  const deps = depsRef;
  if (deps === null) return;
  getLoggingApi().event(GSX_EVENTS.MENU_OPEN_LINK, { env, link: 'calendar', target: 'lite-calendar' });
  try {
    deps.openCalendar(env);
  } catch (err) {
    getLoggingApi().warn('gsx', 'menu: open calendar failed', { env, error: err instanceof Error ? err.message : String(err) });
  }
}

function openLink(env: Environment, key: string, label: string): void {
  const deps = depsRef;
  if (deps === null) return;
  const url = gsxLinkUrl(key, env, deps.getSession(env)?.accountId ?? null);
  getLoggingApi().event(GSX_EVENTS.MENU_OPEN_LINK, { env, link: key });
  deps.openWindow({ env, url, title: `${label} — ${envLabel(env)}` }).catch((err: unknown) => {
    getLoggingApi().warn('gsx', 'menu: open link failed', {
      env,
      link: key,
      error: err instanceof Error ? err.message : String(err),
    });
  });
}
