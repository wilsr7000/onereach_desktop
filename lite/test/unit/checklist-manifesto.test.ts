/**
 * The Checklist Manifesto — principle integrity + the coach's rules.
 *
 * The manifesto is product copy AND enforcement: the editor renders it
 * verbatim and lints drafts against it, so both halves are pinned.
 */

import { describe, it, expect } from 'vitest';
import {
  CHECKLIST_MANIFESTO,
  COACH_ALL_CLEAR,
  lintChecklistDraft,
} from '../../spaces/checklist-manifesto.js';

const item = (text: string, extra: { killer?: boolean; optional?: boolean } = {}) => ({
  text,
  ...extra,
});

describe('manifesto integrity', () => {
  it('eight principles, each fully written (rule/why/good/bad)', () => {
    expect(CHECKLIST_MANIFESTO.length).toBe(8);
    const seen = new Set<string>();
    for (const p of CHECKLIST_MANIFESTO) {
      expect(seen.has(p.id), `duplicate principle id ${p.id}`).toBe(false);
      seen.add(p.id);
      for (const field of [p.title, p.rule, p.why, p.good, p.bad] as const) {
        expect(field.trim().length, `${p.id} has an empty field`).toBeGreaterThan(0);
      }
    }
  });

  it('covers the load-bearing ideas: short, killer, pause point, mode, living', () => {
    const ids = CHECKLIST_MANIFESTO.map((p) => p.id);
    for (const required of ['short', 'killer', 'one-breath', 'pause-point', 'mode', 'living']) {
      expect(ids).toContain(required);
    }
  });

  it('every coach finding cites a real principle', () => {
    const ids = new Set(CHECKLIST_MANIFESTO.map((p) => p.id));
    const noisy = lintChecklistDraft({
      pausePoint: '',
      items: [
        item('handle everything about releases somehow and also make sure the whole thing is generally fine before anyone proceeds with it'),
        item('handle everything about releases somehow and also make sure the whole thing is generally fine before anyone proceeds with it'),
        ...Array.from({ length: 12 }, (_, i) => item(`step ${i}`, { optional: true })),
      ],
    });
    expect(noisy.length).toBeGreaterThan(0);
    for (const finding of noisy) {
      expect(ids.has(finding.principleId), finding.principleId).toBe(true);
    }
  });
});

describe('the coach', () => {
  it('a clean draft gets zero findings (and the all-clear exists)', () => {
    const findings = lintChecklistDraft({
      pausePoint: 'before publishing a release',
      items: [
        item('Run the full test gate.', { killer: true }),
        item('Verify the asar boots.', { killer: true }),
        item('Check the manifest version.'),
        item('Attach release notes.', { optional: true }),
      ],
    });
    expect(findings).toEqual([]);
    expect(COACH_ALL_CLEAR.length).toBeGreaterThan(0);
  });

  it('missing pause point warns, and leads', () => {
    const findings = lintChecklistDraft({
      pausePoint: '  ',
      items: [item('Run the gate.', { killer: true })],
    });
    expect(findings[0]?.principleId).toBe('pause-point');
    expect(findings[0]?.severity).toBe('warn');
  });

  it('counts rule: >9 notes, >12 warns as a procedure', () => {
    const mk = (n: number) =>
      lintChecklistDraft({
        pausePoint: 'before merge',
        items: Array.from({ length: n }, (_, i) => item(`Do step ${i}.`, i === 0 ? { killer: true } : {})),
      });
    expect(mk(9).find((f) => f.principleId === 'short')).toBeUndefined();
    expect(mk(10).find((f) => f.principleId === 'short')?.severity).toBe('note');
    expect(mk(13).find((f) => f.principleId === 'short')?.severity).toBe('warn');
  });

  it('four-plus items with no killer draws the killer note', () => {
    const findings = lintChecklistDraft({
      pausePoint: 'before merge',
      items: [item('A.'), item('B.'), item('C.'), item('D.')],
    });
    expect(findings.find((f) => f.principleId === 'killer')?.severity).toBe('note');
  });

  it('vague openers warn; long items note; duplicates note', () => {
    const vague = lintChecklistDraft({
      pausePoint: 'x',
      items: [item('Handle the release stuff', { killer: true })],
    });
    expect(vague.find((f) => f.principleId === 'one-breath')?.severity).toBe('warn');

    const long = lintChecklistDraft({
      pausePoint: 'x',
      items: [item(`Verify ${'the build output '.repeat(7)}is fine`, { killer: true })],
    });
    expect(long.find((f) => f.principleId === 'one-breath')?.severity).toBe('note');

    const dup = lintChecklistDraft({
      pausePoint: 'x',
      items: [item('Run the gate.', { killer: true }), item('run the gate.')],
    });
    expect(dup.some((f) => f.message.includes('appears twice'))).toBe(true);
  });

  it('an all-optional list warns that it gates nothing', () => {
    const findings = lintChecklistDraft({
      pausePoint: 'before merge',
      items: [item('A.', { optional: true }), item('B.', { optional: true })],
    });
    expect(findings.find((f) => f.principleId === 'honest-optional')?.severity).toBe('warn');
  });

  it('empty rows are ignored, not linted', () => {
    const findings = lintChecklistDraft({
      pausePoint: 'before merge',
      items: [item('Run the gate.', { killer: true }), item('   '), item('')],
    });
    expect(findings).toEqual([]);
  });
});

describe('editor wiring (source-level)', () => {
  const read = (): string => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('node:fs') as typeof import('node:fs');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require('node:path') as typeof import('node:path');
    const found = ['spaces/spaces.ts', 'lite/spaces/spaces.ts']
      .map((r) => path.resolve(r))
      .find((f) => fs.existsSync(f));
    if (found === undefined) throw new Error('spaces.ts not found');
    return fs.readFileSync(found, 'utf8');
  };

  it('the editor mounts the manifesto drawer, live coach, meter, and reorder', () => {
    const src = read();
    const start = src.indexOf('function openChecklistEditorPanel');
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, start + 14000);
    expect(body).toContain('CHECKLIST_MANIFESTO');
    expect(body).toContain('lintChecklistDraft');
    expect(body).toContain('COACH_ALL_CLEAR');
    expect(body).toContain('spaces-checklist-coach');
    expect(body).toContain('spaces-checklist-meter');
    expect(body).toContain("upBtn.setAttribute('aria-label', 'Move item up')");
    // The coach re-runs on every mutation surface.
    expect(body).toContain("text.addEventListener('input', () => runCoach())");
    expect(body).toContain("pauseInput.addEventListener('input', () => runCoach())");
  });
});
