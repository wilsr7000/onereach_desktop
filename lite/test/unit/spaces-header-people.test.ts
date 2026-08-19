/**
 * The header People strip names names (2026-08-19).
 *
 * User: "I want to see the names of the people in the space without
 * clicking unless it a large number like more than 7." The strip used to
 * render faces plus a bare count, so finding out WHO was in a space cost
 * a click into the People panel. Small rosters — the common and the
 * interesting case — now read straight off the header.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { personShortName } from '../../spaces/spaces.js';

describe('personShortName — a header chip has no room for a domain', () => {
  it('prefers a real name', () => {
    expect(personShortName({ id: 'robb@onereach.com', name: 'Robb Wilson' })).toBe('Robb Wilson');
  });

  it('falls back to the id, which ADR-068 makes an email, minus the domain', () => {
    expect(personShortName({ id: 'melanie@onereach.com', name: '' })).toBe('melanie');
  });

  it('trims the domain off an email used as a display name', () => {
    expect(personShortName({ id: 'x', name: 'quinn@onereach.com' })).toBe('quinn');
  });

  it('never renders empty — an unnamed person still needs a label', () => {
    expect(personShortName({ id: 'person-123', name: '   ' })).toBe('person-123');
    expect(personShortName({ id: 'person-123', name: '@onereach.com' })).toBe('person-123');
  });
});

describe('header strip: names inline, faces past the threshold', () => {
  const source = (): string => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('node:fs') as typeof import('node:fs');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require('node:path') as typeof import('node:path');
    const found = ['spaces/spaces.ts', 'lite/spaces/spaces.ts']
      .map((r) => path.resolve(r))
      .find((f) => fs.existsSync(f));
    return fs.readFileSync(found as string, 'utf8');
  };

  it('the threshold is 7, per the request', () => {
    expect(source()).toMatch(/const HEADER_MEMBER_NAMES_MAX = 7;/);
  });

  it('a small roster renders names; a large one falls back to avatars + count', () => {
    const src = source();
    const at = src.indexOf('function buildSpaceMembersStrip');
    const body = src.slice(at, at + 3000);
    expect(body).toContain('members.length <= HEADER_MEMBER_NAMES_MAX');
    expect(body).toContain('personShortName(member)');
    // The collapsed path keeps the stacked faces and the count…
    expect(body).toContain('spaces-avatar-more');
    // …and the count is suppressed when the names are already on screen.
    expect(body).toMatch(/summary\.textContent = named\s*\?\s*''/);
  });
});
