/**
 * Spaces tiles: text never blows out, and a tile shows what it holds
 * (2026-09-02, user: "make the tiles in Spaces actually look good and
 * text not blow out"). Found live with real Spaces: playbook prose cut
 * mid-line at both tile edges (centred column), saved web pages and
 * minified bundles rendered as "paper", 35/45 documents with an AI
 * summary shown as empty boxes, 150-char filenames ellipsized to nothing.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  buildItemCard,
  humanizeTileTitle,
  looksLikeCode,
  looksLikeMarkup,
  stripMarkupForExcerpt,
  tileExcerptText,
  tileSummaryText,
} from '../../spaces/spaces.js';

const ROOT = resolve(__dirname, '../..');
const css = readFileSync(join(ROOT, 'spaces/spaces.css'), 'utf8');

const base = (over: Record<string, unknown>) =>
  ({
    id: 'i1',
    title: 'A doc',
    kind: 'document',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    otherSpaces: [],
    producedBy: null,
    ...over,
  }) as never;

describe('excerpt hygiene', () => {
  it('a saved web page is not paper: tags stripped, nothing left → null', () => {
    const html =
      '\n<!-- saved from url=(0011)about:blank -->\n<html><head><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"><script>window.__CF$cv$params={r:\'a2\',t:\'MT\'};var a=document.createElement(\'script\');a.nonce=\'uJ\';a.src=\'/cd';
    expect(looksLikeMarkup(html)).toBe(true);
    expect(tileExcerptText(html)).toBeNull();
  });

  it('a comment cut open by the excerpt length is dropped too', () => {
    const cut = '<!DOCTYPE html>\n<!-- saved from url=(0253)https://f407e55d.frame.claudeusercontent.com/_f/?__frame_t=UXGa';
    expect(tileExcerptText(cut)).toBeNull();
  });

  it('markup with real text keeps the text', () => {
    expect(tileExcerptText('<p>Hello <b>world</b> &amp; friends</p><p>Second.</p><br/>')).toBe(
      'Hello world & friends Second.'
    );
    expect(stripMarkupForExcerpt('<div>a</div><div>b</div>')).toBe('a b');
  });

  it('a minified bundle is refused so the tile falls back to its badge', () => {
    const js =
      'import{t as e}from"./preload-helper-BE_pJ-Hw.js";var t=/^(0|[1-9]\\d{0,3})\\.(0|[1-9]\\d{0,4})$/;function n(e){return t.test(e)}var o="0.0.0";function r(e,t=!1,n=[]){const o=e??{};return{id:t&&"string"==typeof o.id}}';
    expect(looksLikeCode(js)).toBe(true);
    expect(tileExcerptText(js)).toBeNull();
  });

  it('prose survives — including a long URL and a stray angle bracket', () => {
    const note =
      'See https://example.com/a/very/long/path?with=query&and=more#fragment-that-keeps-going for the details, then compare x < y.';
    expect(looksLikeCode(note)).toBe(false);
    expect(looksLikeMarkup(note)).toBe(false);
    expect(tileExcerptText(note)).toBe(note);
    expect(tileExcerptText('Just a normal note.')).toBe('Just a normal note.');
  });
});

describe('tileSummaryText', () => {
  it('uses the AI summary, then the description, then nothing', () => {
    expect(tileSummaryText({ metadata: { ai_summary: 'A **short** summary.' } as never })).toBe('A short summary.');
    expect(tileSummaryText({ description: 'Plain description.' })).toBe('Plain description.');
    expect(tileSummaryText({ metadata: { ai_summary: '  ' } as never, description: '' })).toBeNull();
  });
});

describe('humanizeTileTitle', () => {
  it('filenames read as words and drop a known extension', () => {
    expect(
      humanizeTileTitle('RFI Submission_ OneReach.ai_Everest_Group_Conversational_AI_and_AI_Agents.pdf')
    ).toBe('RFI Submission OneReach.ai Everest Group Conversational AI and AI Agents');
    expect(humanizeTileTitle('Transcript_AMPMQSync20260820Transcript.md.pdf')).toBe(
      'Transcript AMPMQSync20260820Transcript.md'
    );
  });

  it('leaves real titles and generated titles untouched', () => {
    expect(humanizeTileTitle('A spec doc')).toBe('A spec doc');
    expect(humanizeTileTitle('Doc · i1')).toBe('Doc · i1');
    expect(humanizeTileTitle('WISER 10/10 — Master Plan')).toBe('WISER 10/10 — Master Plan');
    expect(humanizeTileTitle('Release 1: Solid Ground')).toBe('Release 1: Solid Ground');
  });
});

describe('buildItemCard', () => {
  it('a document with no excerpt but an AI summary shows the summary as paper under a type chip', () => {
    const card = buildItemCard(
      base({
        title: 'Related Gartner Research_ Hype Cycle for Agentic AI_842058_ndx.pdf',
        fileKey: 'lite-spaces/assets/x.pdf',
        metadata: { ai_summary: 'Gartner positions agentic AI at the peak of inflated expectations.' },
      }),
      false
    );
    const paper = card.querySelector('.spaces-card-excerpt-summary');
    expect(paper?.textContent).toContain('peak of inflated expectations');
    expect(card.querySelector('.spaces-card-type-chip')?.textContent).toBe('PDF');
    expect(card.querySelector('.spaces-card-title')?.textContent).toBe(
      'Related Gartner Research Hype Cycle for Agentic AI 842058 ndx'
    );
  });

  it('a keyless document with a known filename shows its type badge, not a bare glyph', () => {
    const card = buildItemCard(
      base({ title: 'frame shell CMMHnGQr', excerpt: 'import{t as e}from"./x.js";var t=1;function n(e){return t}', metadata: { filename: 'frame-shell-CMMHnGQr.js' } }),
      false
    );
    expect(card.querySelector('.spaces-card-filecard-ext')?.textContent).toBe('JS');
    expect(card.querySelector('.spaces-card-excerpt')).toBeNull();
  });

  it('a raw-HTML excerpt never renders as paper', () => {
    const card = buildItemCard(
      base({ title: 'saved resource.html', excerpt: '<!DOCTYPE html>\n<!-- saved from url=(0253)https://x -->' }),
      false
    );
    expect(card.querySelector('.spaces-card-excerpt')).toBeNull();
  });

  it('a playbook with long prose keeps its PLAYBOOK head and clamps the prose', () => {
    const card = buildItemCard(
      base({ kind: 'playbook', title: 'Release 3', excerpt: 'This note outlines the scope. '.repeat(40) }),
      false
    );
    const preview = card.querySelector('.spaces-card-preview-playbook');
    expect(preview?.querySelector('.spaces-card-playbook-label')?.textContent).toBe('PLAYBOOK');
    expect(preview?.querySelector('.spaces-card-excerpt')).not.toBeNull();
  });
});

describe('CSS: text stays inside the tile', () => {
  const block = (selector: string): string => {
    const start = css.indexOf(`\n${selector} {`);
    expect(start, `${selector} block missing`).toBeGreaterThan(-1);
    return css.slice(start, css.indexOf('}', start));
  };

  it('playbook previews anchor to the top — never centred', () => {
    const rules = [...css.matchAll(/\.spaces-card-preview-playbook \{[^}]*\}/g)].map((m) => m[0]);
    expect(rules.length).toBeGreaterThan(0);
    for (const r of rules) expect(r).not.toMatch(/justify-content:\s*center/);
    expect(rules.some((r) => /justify-content:\s*flex-start/.test(r))).toBe(true);
  });

  it('playbook prose is clamped with the fade, like document paper', () => {
    expect(block('.spaces-card-preview-playbook .spaces-card-excerpt')).toMatch(/-webkit-line-clamp:\s*6/);
    expect(block('.spaces-card-preview-playbook .spaces-card-excerpt')).toMatch(/mask-image/);
  });

  it('titles take two lines and filenames may break anywhere', () => {
    const title = block('.spaces-card-title');
    expect(title).toMatch(/-webkit-line-clamp:\s*2/);
    expect(title).toMatch(/overflow-wrap:\s*anywhere/);
    expect(title).not.toMatch(/white-space:\s*nowrap/);
  });

  it('excerpts wrap long tokens; the grid gains a column at laptop widths', () => {
    expect(block('.spaces-card-excerpt')).toMatch(/overflow-wrap:\s*anywhere/);
    expect(block('.spaces-card-grid')).toMatch(/minmax\(228px, 1fr\)/);
  });
});
