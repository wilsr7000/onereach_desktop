/**
 * Space activity, back in Spaces — but not in the shape that was
 * rejected (2026-08-19).
 *
 * History this pins: the per-Space view once merged events INTO the
 * asset grid as chat-style rows; the user rejected that ("they look like
 * Slack messages vs assets") and events were exiled to Home. Home cannot
 * scope activity to a Space, so "what happened here?" became
 * unanswerable. Activity now lives in the header's orientation zone with
 * its own dense one-line-per-event shape.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';

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

const stripBody = (): string => {
  const src = source();
  const at = src.indexOf('function buildSpaceActivityStrip');
  expect(at, 'buildSpaceActivityStrip not found — renamed?').toBeGreaterThan(-1);
  return src.slice(at, at + 4200);
};

describe('space activity strip', () => {
  it('rides the space header, so BOTH space kinds get it from one implementation', () => {
    const src = source();
    expect(src.match(/function buildSpaceActivityStrip/g)?.length).toBe(1);
    // buildSpaceHeader is shared by the user grid and the shared dashboard.
    const header = src.slice(
      src.indexOf('function buildSpaceHeader'),
      src.indexOf('function buildSpaceHeader') + 1800
    );
    expect(header).toContain('buildSpaceActivityStrip()');
  });

  it('shows a bounded preview so events never push assets down', () => {
    expect(source()).toMatch(/const HEADER_ACTIVITY_ROWS = 3;/);
    expect(stripBody()).toContain('events.slice(0, HEADER_ACTIVITY_ROWS)');
    expect(stripBody()).toMatch(/Show all \$\{events\.length\}/);
  });

  it('keeps its own shape — none of the timeline chrome that was rejected', () => {
    const body = stripBody();
    // No chat-row reuse: no dot, no excerpt, no space chip (we are IN it).
    expect(body).not.toContain('buildTimelineRow');
    expect(body).not.toContain('home-timeline');
    expect(body).not.toContain('buildSpaceChip');
    expect(body).not.toContain('excerpt');
  });

  it('never reports an empty history when the read failed', () => {
    const body = stripBody();
    expect(body).toContain("Couldn't load activity");
    expect(body).toContain('Nothing yet');
    // The distinction is made on the error, not on an empty array alone.
    expect(body).toMatch(/state\.spaceEvents\.error !== null/);
  });

  it('reuses the established event phrasing rather than inventing its own', () => {
    const body = stripBody();
    expect(body).toContain('prettyAuthor(e.author)');
    expect(body).toContain('deriveVerb(e.kind)');
    expect(body).toContain('deriveObject(e.kind)');
    expect(body).toContain('formatRecency(e.timestamp)');
  });

  it('expanding swaps the strip in place, never repainting the asset grid', () => {
    const body = stripBody();
    expect(body).toContain('wrap.replaceWith(next)');
    expect(body).not.toContain('renderItemList');
  });
});
