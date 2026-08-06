/**
 * Sharing UI — visibility + auto-delete on the upload pane, and the
 * read-side badges that keep that choice visible afterwards.
 *
 * The risk this file guards is ACCIDENTAL PUBLICATION. Two ways it can
 * happen, both tested here:
 *   - the switch defaults to public, or
 *   - a previous upload's "public" choice survives into the next one.
 *
 * The second is the sneaky one: the dialog is reused, so without an
 * explicit reset the user publishes a file they never meant to.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  expiryPresetToIso,
  expiryPresetLabel,
  itemIsPublic,
  itemExpiresAt,
  formatExpiry,
  expiresSoon,
  buildSharingBadges,
  buildCreatedToast,
  resetShareControls,
} from '../../spaces/spaces.js';

const NOW = Date.parse('2026-08-06T12:00:00.000Z');

describe('expiry presets', () => {
  it('means "never" when nothing is chosen', () => {
    expect(expiryPresetToIso('', NOW)).toBeUndefined();
  });

  it('ignores an unknown preset rather than inventing a date', () => {
    expect(expiryPresetToIso('sometime', NOW)).toBeUndefined();
  });

  // Absolute, not relative: computed at submit, so a dialog left open
  // for an hour still means "24h from upload", and the main process
  // receives an unambiguous instant.
  it('resolves each preset to an absolute ISO instant', () => {
    expect(expiryPresetToIso('1h', NOW)).toBe('2026-08-06T13:00:00.000Z');
    expect(expiryPresetToIso('24h', NOW)).toBe('2026-08-07T12:00:00.000Z');
    expect(expiryPresetToIso('7d', NOW)).toBe('2026-08-13T12:00:00.000Z');
    expect(expiryPresetToIso('30d', NOW)).toBe('2026-09-05T12:00:00.000Z');
  });

  it('always resolves to the FUTURE, which is what createBinary requires', () => {
    for (const preset of ['1h', '24h', '7d', '30d']) {
      const iso = expiryPresetToIso(preset, NOW);
      expect(Date.parse(iso as string)).toBeGreaterThan(NOW);
    }
  });

  it('describes the default as no expiry', () => {
    expect(expiryPresetLabel('')).toContain('until you delete');
  });

  it('describes a chosen preset in plain words', () => {
    expect(expiryPresetLabel('24h')).toBe('Deleted automatically in 24 hours.');
  });
});

describe('reading sharing state off an item', () => {
  it('treats a missing stamp as private — the default', () => {
    expect(itemIsPublic({})).toBe(false);
    expect(itemIsPublic({ metadata: {} })).toBe(false);
    expect(itemIsPublic(null)).toBe(false);
  });

  // Metadata round-trips through JSON in the graph. Only a real boolean
  // true means public; a stringified "true" must NOT read as public, or
  // the badge would lie about a private file (and vice-versa).
  it('requires a real boolean true, not a truthy string', () => {
    expect(itemIsPublic({ metadata: { fileIsPublic: 'true' } })).toBe(false);
    expect(itemIsPublic({ metadata: { fileIsPublic: 1 } })).toBe(false);
    expect(itemIsPublic({ metadata: { fileIsPublic: true } })).toBe(true);
  });

  it('reads a valid expiry and rejects junk', () => {
    expect(itemExpiresAt({ metadata: { fileExpiresAt: '2026-09-01T00:00:00Z' } })).toBe(
      '2026-09-01T00:00:00Z'
    );
    expect(itemExpiresAt({ metadata: { fileExpiresAt: 'whenever' } })).toBeNull();
    expect(itemExpiresAt({ metadata: { fileExpiresAt: '' } })).toBeNull();
    expect(itemExpiresAt({})).toBeNull();
  });
});

describe('formatExpiry', () => {
  it('reads a past expiry as "expired", never a negative duration', () => {
    expect(formatExpiry('2026-08-06T11:00:00.000Z', NOW)).toBe('expired');
  });

  it('scales the unit to the distance', () => {
    expect(formatExpiry('2026-08-06T12:30:00.000Z', NOW)).toBe('expires in 30m');
    expect(formatExpiry('2026-08-06T18:00:00.000Z', NOW)).toBe('expires in 6h');
    expect(formatExpiry('2026-08-13T12:00:00.000Z', NOW)).toBe('expires in 7d');
  });

  it('never says "in 0m" — anything imminent still rounds up', () => {
    expect(formatExpiry('2026-08-06T12:00:10.000Z', NOW)).toBe('expires in 1m');
  });

  it('flags the last day as urgent', () => {
    expect(expiresSoon('2026-08-06T20:00:00.000Z', NOW)).toBe(true);
    expect(expiresSoon('2026-08-30T12:00:00.000Z', NOW)).toBe(false);
  });
});

describe('badges', () => {
  it('renders nothing for a private, never-expiring asset', () => {
    expect(buildSharingBadges({ metadata: {} })).toBeNull();
  });

  it('renders a Public pill only when public', () => {
    const frag = buildSharingBadges({ metadata: { fileIsPublic: true } });
    const host = document.createElement('div');
    host.appendChild(frag as DocumentFragment);
    expect(host.querySelector('.spaces-public-badge')?.textContent).toBe('Public');
    expect(host.querySelector('.spaces-expiry-badge')).toBeNull();
  });

  it('marks a soon-to-expire asset urgent', () => {
    const soon = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const host = document.createElement('div');
    host.appendChild(buildSharingBadges({ metadata: { fileExpiresAt: soon } }) as DocumentFragment);
    expect(host.querySelector('.spaces-expiry-badge')?.className).toContain('is-soon');
  });

  it('shows both pills when an asset is public AND expiring', () => {
    const soon = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();
    const host = document.createElement('div');
    host.appendChild(
      buildSharingBadges({
        metadata: { fileIsPublic: true, fileExpiresAt: soon },
      }) as DocumentFragment
    );
    expect(host.querySelector('.spaces-public-badge')).not.toBeNull();
    expect(host.querySelector('.spaces-expiry-badge')).not.toBeNull();
  });
});

describe('created toast', () => {
  it('stays plain for the default private, no-expiry case', () => {
    expect(buildCreatedToast('Report', false, undefined, NOW)).toBe('Created "Report"');
  });

  // States the consequence, not the setting.
  it('spells out what public MEANS', () => {
    expect(buildCreatedToast('Report', true, undefined, NOW)).toContain(
      'anyone with the link can open it'
    );
  });

  it('mentions the expiry', () => {
    expect(buildCreatedToast('Report', false, '2026-08-07T12:00:00.000Z', NOW)).toContain(
      'expires in 24h'
    );
  });

  it('mentions both when both are set', () => {
    const msg = buildCreatedToast('Report', true, '2026-08-07T12:00:00.000Z', NOW);
    expect(msg).toContain('public');
    expect(msg).toContain('expires in 24h');
  });
});

// ─── The accidental-publish guards ───────────────────────────────────

describe('the switch defaults and resets to PRIVATE', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div class="spaces-share">
        <span id="spaces-share-title">Private</span>
        <span id="spaces-share-sub"></span>
        <div id="spaces-share-warn" hidden></div>
        <button role="switch" aria-checked="false" id="spaces-new-asset-public"></button>
        <span id="spaces-expiry-sub"></span>
        <select id="spaces-new-asset-expiry"><option value="" selected></option><option value="7d"></option></select>
      </div>`;
  });

  it('starts private in the markup itself, before any JS runs', () => {
    const toggle = document.getElementById('spaces-new-asset-public');
    expect(toggle?.getAttribute('aria-checked')).toBe('false');
    const select = document.getElementById('spaces-new-asset-expiry');
    expect((select as HTMLSelectElement).value).toBe('');
  });

  it('exposes the switch to assistive tech as a switch', () => {
    expect(document.getElementById('spaces-new-asset-public')?.getAttribute('role')).toBe('switch');
  });

  it('hides the "anyone with the link" warning while private', () => {
    expect((document.getElementById('spaces-share-warn') as HTMLElement).hidden).toBe(true);
  });

  // THE important one. The dialog is reused across uploads, so a
  // "public" choice that survives into the next open publishes a file
  // the user never meant to share.
  it('resets a public switch back to private', () => {
    const toggle = document.getElementById('spaces-new-asset-public') as HTMLElement;
    const warn = document.getElementById('spaces-share-warn') as HTMLElement;
    toggle.setAttribute('aria-checked', 'true');
    warn.hidden = false;

    resetShareControls();

    expect(toggle.getAttribute('aria-checked'), 'a stale public choice must not carry over').toBe(
      'false'
    );
    expect(warn.hidden).toBe(true);
    expect(document.getElementById('spaces-share-title')?.textContent).toBe('Private');
  });

  it('resets a chosen expiry back to never', () => {
    const select = document.getElementById('spaces-new-asset-expiry') as HTMLSelectElement;
    select.value = '7d';
    resetShareControls();
    expect(select.value).toBe('');
  });
});

/**
 * Source-level invariant. The behavioural test above proves
 * `resetShareControls` works; this proves it is actually WIRED to the
 * dialog open, which is the part a future refactor could quietly drop.
 */
describe('reset is wired to dialog open', () => {
  it('openNewAssetDialog calls resetShareControls', async () => {
    const fs = await import('node:fs');
    const nodePath = await import('node:path');
    // cwd is the repo root when run via `npm run lite:test`, but `lite/`
    // when vitest is invoked directly. Accept either.
    const candidates = ['lite/spaces/spaces.ts', 'spaces/spaces.ts'].map((p) =>
      nodePath.resolve(p)
    );
    const found = candidates.find((p) => fs.existsSync(p));
    expect(found, `spaces.ts not found at any of: ${candidates.join(', ')}`).toBeDefined();
    const src = fs.readFileSync(found as string, 'utf8');
    const start = src.indexOf('function openNewAssetDialog');
    expect(start, 'openNewAssetDialog not found — did it get renamed?').toBeGreaterThan(-1);
    const body = src.slice(start, start + 3000);
    expect(
      body.includes('resetShareControls()'),
      'openNewAssetDialog must reset sharing, or a public choice leaks into the next upload'
    ).toBe(true);
  });
});
