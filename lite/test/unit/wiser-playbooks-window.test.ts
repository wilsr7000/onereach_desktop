/**
 * WISER Playbooks launcher — viewer identity + deep-link URL invariants.
 *
 * The hosted app is belonging-gated: without a ?riffUser viewer it
 * fails closed (welcome screen, 0 playbooks, deep links time out with
 * "Deep-linked playbook not found"). These tests pin the two ways the
 * viewer must resolve — session email first, the user-declared
 * attribution email as fallback (the 2026-08-15 viewer-incident
 * pattern, same as viewerId() in spaces/main.ts) — and the URL
 * assembly for the ?riff= deep link.
 *
 * Source-level: the module pulls in electron at import time, so the
 * invariants are pinned against the source text (same pattern as the
 * main-window remote-home wiring tests).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

function source(): string {
  const candidates = [
    path.resolve('wiser-playbooks-window.ts'),
    path.resolve('lite/wiser-playbooks-window.ts'),
  ];
  const found = candidates.find((f) => existsSync(f));
  if (found === undefined) throw new Error('wiser-playbooks-window.ts not found');
  return readFileSync(found, 'utf8');
}

describe('WISER Playbooks viewer identity', () => {
  it('falls back to the attribution email when the session has no email', () => {
    const src = source();
    const start = src.indexOf('function wiserViewerIdentity');
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf('\n}', start);
    const body = src.slice(start, end);
    // Session email first…
    expect(body).toContain("getAuthApi().getSession('edison')");
    // …attribution fallback second — NOT a bare `return null`. Many GSX
    // sign-ins carry no email in the `or` cookie (live incident
    // 2026-08-15); without this fallback the hosted app fails closed
    // and every playbook click looks like a loading issue.
    expect(body).toContain('readAttributionEmailSync()');
    expect(body).not.toMatch(/\n  return null;\n\}$/);
  });

  it('the launcher passes riffUser and riff on the URL', () => {
    const src = source();
    expect(src).toContain("params.set('riff', opts.riffId)");
    expect(src).toContain("params.set('riffUser', viewer)");
    // Deep-linking into an ALREADY-OPEN window re-points the view.
    expect(src).toContain('view.webContents.loadURL(target)');
  });

  it('the app view is partitioned and the URL constant is the deployed build', () => {
    const src = source();
    expect(src).toContain("'persist:lite-wiser-playbooks'");
    expect(src).toMatch(/WISER_PLAYBOOKS_URL =\s*\n?\s*'https:\/\/files\.edison\.api\.onereach\.ai\/public\/[a-f0-9-]+\/riff\/index\.html'/);
  });
});
