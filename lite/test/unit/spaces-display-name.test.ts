/**
 * `displayPersonName` — never print an identifier where a name belongs.
 *
 * Found by looking at the running app: the detail pane's identity line,
 * the most prominent text on the pane, read
 *
 *     Created by 35254342-4a2e-475b-aec1-18547e517e29
 *
 * The renderer was faithful; the graph genuinely holds that as the
 * person's `name`. Upstream producers have historically defaulted a
 * missing name to the entity's own id — the same defect that shipped a
 * Space to production called `402abae35ea49651576e3a8d61f3ee3a`
 * (LITE-PUNCH-LIST). Lite already reads legacy data through coalesce
 * fallbacks; this is the display-layer equivalent.
 *
 * The tension: be aggressive enough to catch identifiers, conservative
 * enough that real names survive. Blanking a real person's name is a
 * worse failure than showing an occasional GUID, so every ambiguous
 * case resolves toward keeping the name.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect } from 'vitest';
import { displayPersonName } from '../../spaces/spaces.js';

describe('identifiers are not names', () => {
  it('replaces the exact GUID seen in the app', () => {
    expect(displayPersonName('35254342-4a2e-475b-aec1-18547e517e29')).toBe('(unknown)');
  });

  it('replaces an uppercase UUID', () => {
    expect(displayPersonName('35254342-4A2E-475B-AEC1-18547E517E29')).toBe('(unknown)');
  });

  it('replaces a bare hex blob — the production Space name defect', () => {
    expect(displayPersonName('402abae35ea49651576e3a8d61f3ee3a')).toBe('(unknown)');
  });

  it('replaces a string with no letters at all', () => {
    expect(displayPersonName('1234567890')).toBe('(unknown)');
    expect(displayPersonName('---')).toBe('(unknown)');
  });

  it('handles absent and blank input', () => {
    expect(displayPersonName(null)).toBe('(unknown)');
    expect(displayPersonName(undefined)).toBe('(unknown)');
    expect(displayPersonName('   ')).toBe('(unknown)');
  });
});

describe('real names survive — the more important half', () => {
  const KEEP = [
    'Robb Wilson',
    'Anne-Marie Legrand', // hyphen, like a UUID has
    'R2', // letters + digits, very short
    "O'Brien",
    'Ada',
    '李雷', // non-Latin script must not read as "no letters"
    'Renée Öström',
    'agent-42', // hyphen + digits, still a name
    'Team 6KTEPA3LSD', // has an id-ish token but is a phrase
  ];
  for (const name of KEEP) {
    it(`keeps ${JSON.stringify(name)}`, () => {
      expect(displayPersonName(name)).toBe(name);
    });
  }

  it('trims surrounding whitespace rather than rejecting', () => {
    expect(displayPersonName('  Robb Wilson  ')).toBe('Robb Wilson');
  });

  // A short hex-looking word is far more likely to be a real name or
  // initials than an id, so the blob rule requires real length.
  it('does not mistake a short hex-ish word for an id', () => {
    expect(displayPersonName('Ada')).toBe('Ada');
    expect(displayPersonName('deadbeef')).toBe('deadbeef');
  });
});
