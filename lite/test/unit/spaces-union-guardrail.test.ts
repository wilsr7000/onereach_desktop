/**
 * The union-rule guardrail.
 *
 * Asset visibility is a UNION — an item is visible if ANY Space it
 * belongs to is visible. The Cypher says so in as many words:
 *
 *   "An item in both a restricted space and an open one is visible —
 *    it genuinely lives in the open space."
 *
 * That was a fine rule when filing into a second Space meant hunting
 * through a dropdown. It stopped being fine the moment the membership
 * panel made it one click and the AI suggester started proposing
 * Spaces: the easiest way to leak a restricted asset became "accept a
 * helpful suggestion".
 *
 * Both directions are load-bearing here:
 *   - MISSING the warning silently widens who can see a restricted
 *     asset;
 *   - warning too eagerly trains people to click through, which is the
 *     same failure with extra steps.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect } from 'vitest';
import {
  isRestrictedSpace,
  wouldExposeRestrictedItem,
  exposureWarningText,
} from '../../spaces/spaces.js';

const OPEN_A = { id: 'open-a', visibility: 'open' };
const OPEN_B = { id: 'open-b' }; // visibility absent = open (the default)
const LOCKED_A = { id: 'lock-a', visibility: 'restricted' };
const LOCKED_B = { id: 'lock-b', visibility: 'restricted' };
const ALL = [OPEN_A, OPEN_B, LOCKED_A, LOCKED_B];

const ids = (...v: string[]): ReadonlySet<string> => new Set(v);

describe('isRestrictedSpace', () => {
  it('treats a missing visibility as open — the pre-ADR-051 default', () => {
    expect(isRestrictedSpace({})).toBe(false);
    expect(isRestrictedSpace(undefined)).toBe(false);
  });

  it('recognises restricted', () => {
    expect(isRestrictedSpace({ visibility: 'restricted' })).toBe(true);
  });
});

describe('wouldExposeRestrictedItem — warns', () => {
  it('when a restricted-only item is added to an open Space', () => {
    expect(wouldExposeRestrictedItem(ids('lock-a'), OPEN_A, ALL)).toBe(true);
  });

  it('when the item is in SEVERAL restricted Spaces and none open', () => {
    expect(wouldExposeRestrictedItem(ids('lock-a', 'lock-b'), OPEN_A, ALL)).toBe(true);
  });

  // A Space with no `visibility` property is open. Adding a
  // restricted-only item to it is exactly the leak we're guarding.
  it('when the target Space is open by omission rather than by value', () => {
    expect(wouldExposeRestrictedItem(ids('lock-a'), OPEN_B, ALL)).toBe(true);
  });
});

describe('wouldExposeRestrictedItem — stays quiet', () => {
  // Crying wolf is its own failure: a warning people always dismiss
  // stops being a warning.
  it('when the target is itself restricted — nothing widens', () => {
    expect(wouldExposeRestrictedItem(ids('lock-a'), LOCKED_B, ALL)).toBe(false);
  });

  it('when the item is ALREADY in an open Space — exposure has happened', () => {
    expect(wouldExposeRestrictedItem(ids('lock-a', 'open-a'), OPEN_B, ALL)).toBe(false);
  });

  it('when the item is uncategorized — it was never limited', () => {
    expect(wouldExposeRestrictedItem(ids(), OPEN_A, ALL)).toBe(false);
  });

  it('when a current Space is unknown — we cannot prove it was limited', () => {
    // Better to skip a warning than to fire one on an item that was
    // already account-visible.
    expect(wouldExposeRestrictedItem(ids('lock-a', 'ghost'), OPEN_A, ALL)).toBe(false);
  });
});

describe('exposureWarningText', () => {
  it('names the item, the destination, and the consequence', () => {
    const text = exposureWarningText('Q3 Comp Review', 'Engineering', ['HR Private']);
    expect(text).toContain('Q3 Comp Review');
    expect(text).toContain('HR Private');
    expect(text).toContain('Engineering');
    expect(text).toContain('visible to everyone in the account');
  });

  // The rule is unintuitive: people assume the restricted Space keeps
  // limiting things. The copy has to say that it doesn't.
  it('says the item stays in the restricted Space but is no longer limited by it', () => {
    const text = exposureWarningText('Doc', 'Team', ['Legal']);
    expect(text).toContain('stays in');
    expect(text).toContain('no longer limits');
  });

  it('summarises rather than listing when several Spaces are involved', () => {
    const text = exposureWarningText('Doc', 'Team', ['Legal', 'HR', 'Board']);
    expect(text).toContain('3 members-only spaces');
  });
});

/**
 * The other half of the guardrail: the AI suggester must not PROPOSE
 * the exposure it would then have to warn about. Asserted at source
 * level because `loadSpaceSuggestions` needs the AI bridge, the DOM
 * panel and a live `state` to exercise — but the filter itself is one
 * line that a refactor could quietly drop, taking the protection with
 * it while every behavioural test still passed.
 */
describe('the suggester does not recommend exposing a restricted item', () => {
  it('filters candidates to restricted Spaces for a restricted-only item', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const candidates = ['spaces/spaces.ts', 'lite/spaces/spaces.ts'].map((p) => path.resolve(p));
    const found = candidates.find((p) => fs.existsSync(p));
    expect(found, `spaces.ts not found: ${candidates.join(', ')}`).toBeDefined();
    const src = fs.readFileSync(found as string, 'utf8');

    const start = src.indexOf('async function loadSpaceSuggestions');
    expect(start, 'loadSpaceSuggestions not found — renamed?').toBeGreaterThan(-1);
    const body = src.slice(start, start + 2500);

    expect(
      body.includes('restrictedOnly'),
      'suggester must know whether the item is restricted-only'
    ).toBe(true);
    expect(
      body.includes('!restrictedOnly || isRestrictedSpace(sp)'),
      'suggester must drop open Spaces for a restricted-only item, or it recommends the leak'
    ).toBe(true);
  });
});
