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
  agentTileBody,
  buildItemCard,
  isMediaTileKind,
  looksLikeYaml,
  humanizeTileTitle,
  looksLikeCode,
  looksLikeMarkup,
  stripMarkdownForExcerpt,
  stripMarkupForExcerpt,
  stripSummaryBoilerplate,
  tileExcerptText,
  tileKindLabel,
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

describe('agent tile body (a skill added to a Space)', () => {
  it('drops a leading repeat of the title and reads prose as prose', () => {
    expect(agentTileBody('50/50 Risk Analyst A Claude skill that reviews a plan.', '50/50 Risk Analyst')).toBe(
      'A Claude skill that reviews a plan.'
    );
    expect(agentTileBody('50/50 Risk Analyst — reviews a plan.', '50/50 Risk Analyst')).toBe('reviews a plan.');
    expect(agentTileBody('Something else entirely.', '50/50 Risk Analyst')).toBe('Something else entirely.');
    expect(agentTileBody('50/50 Risk Analyst', '50/50 Risk Analyst')).toBeNull();
    expect(looksLikeYaml('name: risk-analyst description: reviews plans channels: claude-code')).toBe(true);
    expect(looksLikeYaml('A Claude skill that reviews a plan and returns the two most likely ways it fails.')).toBe(false);
  });

  it('renders: SKILL chip, no title echo, prose face', () => {
    const card = buildItemCard(
      base({
        kind: 'agent',
        title: '50/50 Risk Analyst',
        agentType: 'tool',
        agentEndpoints: [{ kind: 'skill', url: 'https://skills.example/x', channels: [] }],
        excerpt: '# 50/50 Risk Analyst\n\nA Claude skill that reviews a plan and returns the two most likely ways it fails.',
      }),
      false
    );
    expect(card.querySelector('.spaces-card-agent-endpoint-skill')?.textContent).toBe('SKILL');
    const body = card.querySelector('.spaces-card-agent-okf');
    expect(body?.textContent?.startsWith('A Claude skill')).toBe(true);
    expect(body?.classList.contains('is-prose')).toBe(true);
  });
});

describe('untitled playbooks', () => {
  it('never wear their riff deep-link as a title', () => {
    const card = buildItemCard(
      base({ id: '8b0a8281-29f5-416b-987e-9aa69577464b', kind: 'playbook', title: '', fileKey: 'https://files.example/riff/index.html?open=8b0a8281-29f5' }),
      false
    );
    const title = card.querySelector('.spaces-card-title')?.textContent ?? '';
    expect(title.startsWith('Playbook · ')).toBe(true);
    expect(title).not.toContain('?open=');
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

// ---------------------------------------------------------------------------
// The paper card (2026-09-06, user: "why are asset tiles in Spaces still
// so ugly"). One shape for every kind: the title first in the system
// face, the asset's own words in the knowledge face, kind and date
// pinned to the foot. Colour is data — the amber playbook star, the
// violet agent mark — never decoration, so the old violet playbook
// pills, black shadows and tinted playbook paper are retired.
// ---------------------------------------------------------------------------
describe('tile kind labels', () => {
  it('a file is called what it is, never "Other"', () => {
    expect(tileKindLabel({ kind: 'other', title: 'Q3 numbers.xlsx' })).toBe('Spreadsheet');
    expect(tileKindLabel({ kind: 'document', title: 'Hype Cycle.pdf' })).toBe('PDF');
    expect(tileKindLabel({ kind: 'other', title: 'deck.pptx' })).toBe('Presentation');
    expect(tileKindLabel({ kind: 'other', title: 'blob' })).toBe('File');
  });

  it('the stored filename wins over a humanized title', () => {
    expect(
      tileKindLabel({ kind: 'document', title: 'frame shell CMMHnGQr', metadata: { filename: 'frame-shell-CMMHnGQr.js' } })
    ).toBe('Code');
  });

  it('kinds with a name of their own keep it', () => {
    expect(tileKindLabel({ kind: 'playbook', title: 'Plan.pdf' })).toMatch(/^playbook$/i);
    expect(tileKindLabel({ kind: 'agent', title: 'Risk Analyst' })).toMatch(/^agent$/i);
  });
});

describe('summary boilerplate', () => {
  it('drops the "could not be extracted" apology and keeps the rest', () => {
    const s =
      'A Gartner research note on agentic AI. The file contents could not be extracted, so details are inferred from the filename only.';
    expect(stripSummaryBoilerplate(s)).toBe('A Gartner research note on agentic AI.');
  });

  it('a summary that is only apology stays as it was — better than an empty tile', () => {
    const s = 'The file could not be read.';
    expect(stripSummaryBoilerplate(s)).toBe(s);
  });

  it('reaches the tile through tileSummaryText', () => {
    expect(tileSummaryText(base({ metadata: { ai_summary: 'Meeting notes. Details are inferred from the filename.' } }))).toBe(
      'Meeting notes.'
    );
  });
});

describe('markdown in excerpts', () => {
  it('single-underscore italics unwrap; snake_case identifiers survive', () => {
    expect(stripMarkdownForExcerpt('_Meeting completed — no analysis yet._ Next: thread_id and received_at.')).toBe(
      'Meeting completed — no analysis yet. Next: thread_id and received_at.'
    );
  });
});

describe('buildItemCard: the paper card', () => {
  const byAgent = { kind: 'Agent', name: 'Scout' };

  it('a text tile keeps its badges beside the title, not over the words', () => {
    const card = buildItemCard(base({ excerpt: 'Prose about a thing.', producedBy: byAgent }), false);
    expect(card.classList.contains('spaces-card-media')).toBe(false);
    expect(card.querySelector('.spaces-card-title-row .spaces-card-badges')).not.toBeNull();
    expect(card.querySelector('.spaces-card-preview .spaces-card-badges')).toBeNull();
  });

  it('a picture leads with itself and wears its badges in a corner', () => {
    if (typeof IntersectionObserver === 'undefined') {
      (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      };
    }
    expect(isMediaTileKind('image')).toBe(true);
    expect(isMediaTileKind('document')).toBe(false);
    const card = buildItemCard(
      base({ kind: 'image', title: 'photo.png', fileKey: 'lite-spaces/assets/photo.png', producedBy: byAgent }),
      false
    );
    expect(card.classList.contains('spaces-card-media')).toBe(true);
    expect(card.querySelector('.spaces-card-preview .spaces-card-badges')).not.toBeNull();
    expect(card.querySelector('.spaces-card-title-row .spaces-card-badges')).toBeNull();
  });

  it('the footer calls a file what it is', () => {
    const card = buildItemCard(base({ kind: 'other', title: 'Q3 numbers.xlsx', fileKey: 'lite-spaces/assets/q3.xlsx' }), false);
    expect(card.querySelector('.spaces-card-kind')?.textContent).toBe('Spreadsheet');
  });
});

describe('CSS: the paper card', () => {
  const v3 = css.slice(css.indexOf('ASSET TILE v3'));
  const rule = (selector: string): string => {
    const start = v3.indexOf(`\n${selector} {`);
    expect(start, `${selector} missing from the v3 block`).toBeGreaterThan(-1);
    return v3.slice(start, v3.indexOf('}', start));
  };

  it('the v3 block exists and comes after every older tile rule', () => {
    expect(v3.length).toBeGreaterThan(0);
    // The block must be the LAST word on these selectors: an older rule
    // written later in the file would win again by source order.
    expect(css.lastIndexOf('\n.spaces-card {')).toBeGreaterThan(css.indexOf('ASSET TILE v3'));
  });

  it('a card at rest is paper with a hairline, no shadow, no lift', () => {
    const card = rule('.spaces-card');
    expect(card).toMatch(/background:\s*var\(--or-bg-surface\)/);
    expect(card).toMatch(/border:\s*1px solid rgba\(var\(--or-ink-rgb\)/);
    expect(card).toMatch(/box-shadow:\s*none/);
  });

  it('the title leads in the system face; the excerpt reads in the knowledge face', () => {
    expect(rule('.spaces-card-title')).toMatch(/font-family:\s*var\(--or-font-sans\)/);
    expect(rule('.spaces-card-title-row')).toMatch(/order:\s*1/);
    expect(rule('.spaces-card .spaces-card-preview')).toMatch(/order:\s*2/);
    expect(v3).toMatch(/\.spaces-card-excerpt[^{]*\{[^}]*font-family:\s*var\(--or-font-display\)/);
  });

  it('the footer is pinned to the foot and the old paper-playbook tint is gone', () => {
    expect(rule('.spaces-card-meta-row')).toMatch(/margin-top:\s*auto/);
    // The old rule painted playbooks on a tinted, shadowed card at
    // (0,2,0); the retire rules answer at the same weight, so they are
    // grouped by state rather than by property.
    expect(v3).toMatch(/\.spaces-card\.spaces-card-playbook,\n[^{]*\{[^}]*background:\s*var\(--or-bg-surface\)/);
    expect(rule('.spaces-card.spaces-card-playbook')).toMatch(/box-shadow:\s*none/);
    expect(v3).toMatch(/\.spaces-card\.spaces-card-playbook \.spaces-card-playbook-pill,\n[^{]*\{[^}]*background:\s*transparent/);
  });

  it('the hexagon stays off the tile', () => {
    expect(rule('.spaces-card .spaces-hex-logo')).toMatch(/display:\s*none/);
  });
});
