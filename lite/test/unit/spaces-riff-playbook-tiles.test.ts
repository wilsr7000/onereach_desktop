/**
 * @vitest-environment jsdom
 *
 * WISER riff playbook tiles say what they are (2026-08-20 report:
 * "the playbook tiles are not very descriptive").
 *
 * Root causes, each pinned here:
 *   1. riff `:Playbook` nodes carry NO content and NO description in
 *      the graph — the real summary lives in the KV sheet. The
 *      enrichment pass copies it onto the node (once, only-while-
 *      empty), so tiles — and every other graph reader — get it.
 *   2. trashed riffs (`isTrashed`, riff's tombstone — NOT `deletedAt`)
 *      rendered as tiles. Every member read now filters them.
 *   3. with no steps and no boxes, the tile pill showed nothing; a
 *      riff plan's lifecycle ("Draft") is its progress and shows now.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { riffSheetDescription, riffStageLabel } from '../../spaces/riff-summary.js';

function read(...candidates: string[]): string {
  const found = candidates.map((p) => resolve(p)).find((p) => existsSync(p));
  if (found === undefined) throw new Error(`not found: ${candidates.join(', ')}`);
  return readFileSync(found, 'utf8');
}

const sdk = (): string => read('spaces/sdk-client.ts', 'lite/spaces/sdk-client.ts');
const mainSrc = (): string => read('spaces/main.ts', 'lite/spaces/main.ts');
const renderer = (): string => read('spaces/spaces.ts', 'lite/spaces/spaces.ts');

// ── The summary extraction (pure) ────────────────────────────────────
describe('riffSheetDescription', () => {
  it('prefers the sheet\'s own summary.text', () => {
    expect(
      riffSheetDescription({
        summary: { text: 'A strategic plan for screening articles before outreach.' },
        content: '<h1>ignored</h1>',
      })
    ).toBe('A strategic plan for screening articles before outreach.');
  });

  it('accepts an older flat-string summary', () => {
    expect(riffSheetDescription({ summary: 'Plain summary.' })).toBe('Plain summary.');
  });

  it('falls back to stripped content HTML, reading as prose', () => {
    const out = riffSheetDescription({
      content: '<h1>Invoice Review Step</h1><p>Evaluates &amp; routes invoices</p>',
    });
    expect(out).toBe('Invoice Review Step. Evaluates & routes invoices.');
  });

  it('strips MARKDOWN content too — a real sheet shipped `# Heading…` (Payments Ops)', () => {
    const out = riffSheetDescription({
      content:
        '# Incident Response Runbook\n## Objective\nProvide a **clear**, repeatable process.\n- Detect alerts\n1. Triage',
    });
    expect(out).toBe(
      'Incident Response Runbook. Objective. Provide a clear, repeatable process. Detect alerts Triage'
    );
    expect(out).not.toContain('#');
    expect(out).not.toContain('**');
  });

  it('caps at the tile paragraph length with an ellipsis', () => {
    const out = riffSheetDescription({ summary: { text: 'x'.repeat(2000) } });
    expect(out).not.toBeNull();
    expect(out?.length).toBeLessThanOrEqual(500);
    expect(out?.endsWith('…')).toBe(true);
  });

  it('junk in, null out — never a throw, never a stamped blank', () => {
    for (const junk of [null, undefined, 42, 'str', [], {}, { summary: {} }, { content: '' }]) {
      expect(riffSheetDescription(junk)).toBeNull();
    }
  });
});

describe('riffStageLabel', () => {
  it('maps the riff lifecycle to human words', () => {
    expect(riffStageLabel('not_submitted', 'draft')).toBe('Draft');
    expect(riffStageLabel('not_submitted', 'final')).toBe('Not submitted');
    expect(riffStageLabel('submitted', 'draft')).toBe('Submitted');
  });

  it('prettifies unknown stages instead of leaking snake_case', () => {
    expect(riffStageLabel('in_review', undefined)).toBe('In review');
    expect(riffStageLabel(undefined, 'draft')).toBe('Draft');
  });

  it('nothing to say → null (the tile shows no pill, not an empty one)', () => {
    expect(riffStageLabel(undefined, undefined)).toBeNull();
    expect(riffStageLabel('', '')).toBeNull();
    expect(riffStageLabel(42, {})).toBeNull();
  });
});

// ── The graph side ───────────────────────────────────────────────────
describe('trashed riffs never render', () => {
  it('every member liveness check pairs deletedAt with isTrashed', () => {
    // `deletedAt` is Lite's tombstone; `isTrashed` is riff's. A member
    // read that checks only one shows the other system's trash.
    const s = sdk();
    const naked = [
      ...s.matchAll(/AND a\.deletedAt IS NULL(?!\s*\n?\s*AND coalesce\(a\.isTrashed)/g),
    ];
    expect(
      naked.length,
      'member reads checking a.deletedAt without the a.isTrashed pair'
    ).toBe(0);
    // ...and the pair actually appears across the read surface.
    expect(
      (s.match(/coalesce\(a\.isTrashed, false\) = false/g) ?? []).length
    ).toBeGreaterThanOrEqual(10);
  });
});

describe('the enrichment write', () => {
  it('only ever fills an EMPTY description', () => {
    const s = sdk();
    const i = s.indexOf('SET_PLAYBOOK_DESCRIPTION: `');
    expect(i).toBeGreaterThan(-1);
    const block = s.slice(i, i + 600);
    // The guard sits in the WHERE — before the SET, so a description
    // written by the riff app or a person is never clobbered.
    const guardAt = block.indexOf("trim(coalesce(p.description, '')) = ''");
    const setAt = block.indexOf('SET p.description');
    expect(guardAt).toBeGreaterThan(-1);
    expect(setAt).toBeGreaterThan(guardAt);
    expect(block).toContain("p.descriptionSource = 'lite:riff-kv-summary'"); // auditable
  });

  it('the candidate list is visibility-gated and capped', () => {
    const s = sdk();
    const i = s.indexOf('LIST_PLAYBOOKS_NEEDING_DESCRIPTION: `');
    expect(i).toBeGreaterThan(-1);
    const block = s.slice(i, i + 800);
    expect(block).toContain('SPACE_VISIBLE');
    expect(block).toContain('LIMIT toInteger($limit)');
    expect(block).toContain('coalesce(p.isTrashed, false) = false'); // no MB-fetches for trash
  });

  it('runs from items.list as fire-and-forget, once per id per boot', () => {
    const s = mainSrc();
    const listAt = s.indexOf('enrichRiffPlaybooks(scope.spaceId)');
    expect(listAt, 'items.list does not trigger the enrichment pass').toBeGreaterThan(-1);
    const fn = s.indexOf('function enrichRiffPlaybooks(');
    const block = s.slice(fn, fn + 3200);
    expect(block).toContain('riffEnrichAttempted'); // multi-MB sheets: one attempt per boot
    expect(block).toContain("getKVApi().get('riff:sheets', id)");
    expect(block).toContain('riffSheetDescription(sheet)');
    expect(block).toContain('cache.invalidate'); // the repaint arrives without a manual refresh
  });
});

// ── The tile ─────────────────────────────────────────────────────────
describe('the playbook tile pill', () => {
  it('shows the riff lifecycle when there is no step data', () => {
    const s = renderer();
    const fn = s.indexOf('function buildPlaybookTilePreview(');
    expect(fn).toBeGreaterThan(-1);
    const block = s.slice(fn, fn + 2600);
    expect(block).toContain('riffStageLabel(item.riffStage, item.riffStatus)');
    expect(block).toContain("'spaces-card-playbook-pill is-stage'");
    // The stage pill is the FALLBACK — checkbox progress still wins.
    const stepsPillAt = block.indexOf('detailed.length > 0');
    const stageAt = block.indexOf('riffStageLabel(');
    expect(stepsPillAt).toBeGreaterThan(-1);
    expect(stageAt).toBeGreaterThan(stepsPillAt);
  });

  it('projects the riff lifecycle through the list queries', () => {
    const s = sdk();
    expect(
      (s.match(/CASE WHEN a:Playbook THEN a\.stage ELSE NULL END AS riffStage/g) ?? []).length
    ).toBeGreaterThanOrEqual(2); // in-space + uncategorized
    expect(s).toContain('riffStatus');
  });
});
