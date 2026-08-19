/**
 * ADR-072 — agent-enabled journey maps (Planning).
 *
 * Ported from the main app's WISER template, where journeys lived in an
 * in-memory Map that never persisted. These tests pin the two things
 * that make Lite's version real: the sanitizer (models are not trusted)
 * and the markdown serializer (whose phase grammar the existing journey
 * tile parses for its stage flow).
 */

// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import {
  sanitizeJourneyDraft,
  journeyToMarkdown,
  journeyDescription,
  JOURNEY_SYSTEM_PROMPT,
  buildSpaceAssetDigest,
  sanitizeJourneySuggestions,
  extractJsonObject,
} from '../../spaces/journey.js';
import { buildJourneyPreview } from '../../spaces/spaces.js';

const tp = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  action: 'Searches the docs',
  emotion: 'Overwhelmed',
  thought: 'This is taking too long',
  agentOpportunity: 'Pre-filter and summarise the results',
  delegationConfidence: 'High',
  ...over,
});

const draftOf = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  title: 'Admin onboarding',
  journey: 'A new admin setting up their first agent',
  phases: [{ name: 'Discovery', touchpoints: [tp()] }],
  ...over,
});

describe('sanitizeJourneyDraft — the model is not trusted', () => {
  it('keeps a well-formed draft intact', () => {
    const out = sanitizeJourneyDraft(draftOf());
    expect(out.title).toBe('Admin onboarding');
    expect(out.phases).toHaveLength(1);
    expect(out.phases[0]?.touchpoints[0]?.delegationConfidence).toBe('High');
  });

  it('drops touchpoints with no action, and phases left empty by that', () => {
    const out = sanitizeJourneyDraft({
      phases: [
        { name: 'Ghost', touchpoints: [{ emotion: 'Sad' }] },
        { name: 'Real', touchpoints: [tp(), { thought: 'no action' }] },
      ],
    });
    expect(out.phases.map((p) => p.name)).toEqual(['Real']);
    expect(out.phases[0]?.touchpoints).toHaveLength(1);
  });

  it('drops unnamed phases and caps runaway output', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      name: `P${i}`,
      touchpoints: Array.from({ length: 30 }, () => tp()),
    }));
    const out = sanitizeJourneyDraft({ phases: [{ touchpoints: [tp()] }, ...many] });
    expect(out.phases.length).toBeLessThanOrEqual(8);
    expect(out.phases[0]?.touchpoints.length).toBeLessThanOrEqual(6);
  });

  it('normalises confidence, defaulting the unknown to Medium (never a false High)', () => {
    const out = sanitizeJourneyDraft({
      phases: [
        {
          name: 'P',
          touchpoints: [
            tp({ delegationConfidence: 'high' }),
            tp({ delegationConfidence: 'wildly confident' }),
            tp({ delegationConfidence: undefined }),
            tp({ delegationConfidence: 'LOW' }),
          ],
        },
      ],
    });
    expect(out.phases[0]?.touchpoints.map((t) => t.delegationConfidence)).toEqual([
      'High',
      'Medium',
      'Medium',
      'Low',
    ]);
  });

  it('never throws on junk, and reports emptiness honestly', () => {
    for (const junk of [null, undefined, 42, 'nope', {}, { phases: 'no' }]) {
      const out = sanitizeJourneyDraft(junk);
      expect(out.phases).toEqual([]);
      expect(out.title.length).toBeGreaterThan(0);
    }
  });

  it('truncates overlong fields rather than rejecting the draft', () => {
    const out = sanitizeJourneyDraft({
      title: 'T'.repeat(500),
      phases: [{ name: 'N'.repeat(200), touchpoints: [tp({ action: 'A'.repeat(500) })] }],
    });
    expect(out.title.length).toBe(120);
    expect(out.phases[0]?.name.length).toBe(60);
    expect(out.phases[0]?.touchpoints[0]?.action.length).toBe(200);
  });
});

describe('journeyToMarkdown', () => {
  it('emits phase headings in the grammar the journey TILE already parses', () => {
    const md = journeyToMarkdown(
      sanitizeJourneyDraft({
        phases: [
          { name: 'Discovery', touchpoints: [tp()] },
          { name: 'Decision', touchpoints: [tp({ action: 'Compares options' })] },
        ],
      })
    );
    // `## N. Name` is what parsePlaybookSteps understands — the tile's
    // stage flow comes for free.
    expect(md).toContain('## 1. Discovery');
    expect(md).toContain('## 2. Decision');
  });

  it('carries the moment, the feeling and the agent hand-off', () => {
    const md = journeyToMarkdown(sanitizeJourneyDraft(draftOf()));
    expect(md).toContain('**Searches the docs**');
    expect(md).toContain('Overwhelmed');
    expect(md).toContain('This is taking too long');
    expect(md).toContain('Pre-filter and summarise the results');
    expect(md).toContain('High confidence');
  });

  it('ranks the delegation summary by confidence — the product of the exercise', () => {
    const md = journeyToMarkdown(
      sanitizeJourneyDraft({
        phases: [
          {
            name: 'P',
            touchpoints: [
              tp({ agentOpportunity: 'risky one', delegationConfidence: 'Low' }),
              tp({ agentOpportunity: 'safe one', delegationConfidence: 'High' }),
            ],
          },
        ],
      })
    );
    const section = md.slice(md.indexOf('## Delegation points'));
    expect(section.indexOf('safe one')).toBeLessThan(section.indexOf('risky one'));
  });

  it('omits the delegation section when nothing can be delegated', () => {
    const md = journeyToMarkdown(
      sanitizeJourneyDraft({
        phases: [{ name: 'P', touchpoints: [tp({ agentOpportunity: '' })] }],
      })
    );
    expect(md).not.toContain('## Delegation points');
  });
});

describe('journeyDescription', () => {
  it('summarises shape so the tile reads usefully unopened', () => {
    const d = journeyDescription(
      sanitizeJourneyDraft({
        journey: 'A new admin',
        phases: [
          { name: 'A', touchpoints: [tp(), tp()] },
          { name: 'B', touchpoints: [tp({ agentOpportunity: '' })] },
        ],
      })
    );
    expect(d).toContain('A new admin');
    expect(d).toContain('2 phases');
    expect(d).toContain('3 touchpoints');
    expect(d).toContain('2 agent hand-offs'); // the empty opportunity is not counted
  });
});

describe('buildJourneyPreview (renderer)', () => {
  it('renders phases, touchpoints and confidence chips', () => {
    const el = buildJourneyPreview({
      title: 'T',
      journey: 'A new admin',
      phases: [
        {
          name: 'Discovery',
          touchpoints: [
            {
              action: 'Searches the docs',
              emotion: 'Overwhelmed',
              thought: 'Too slow',
              agentOpportunity: 'Summarise results',
              delegationConfidence: 'High',
            },
          ],
        },
      ],
    });
    expect(el.querySelector('.spaces-journey-phase-name')?.textContent).toBe('1. Discovery');
    expect(el.querySelector('.spaces-journey-action')?.textContent).toBe('Searches the docs');
    const chip = el.querySelector('.spaces-journey-confidence');
    expect(chip?.textContent).toBe('High');
    expect(chip?.className).toContain('conf-high');
  });
});

describe('the WISER prompt contract', () => {
  it('demands JSON, bounds the shape, and insists every touchpoint carries an agent opportunity', () => {
    expect(JOURNEY_SYSTEM_PROMPT).toContain('Return ONLY a JSON object');
    expect(JOURNEY_SYSTEM_PROMPT).toContain('3–6 phases');
    expect(JOURNEY_SYSTEM_PROMPT).toContain('MUST carry a real agentOpportunity');
    expect(JOURNEY_SYSTEM_PROMPT).toContain('delegationConfidence');
  });
});

describe('asset-grounded suggestions (2026-08-18)', () => {
  it('buildSpaceAssetDigest caps count, line length, and total size', () => {
    const many = Array.from({ length: 60 }, (_, i) => ({
      title: `Asset number ${i} with a fairly long descriptive title`,
      kind: 'document',
      gist: 'g'.repeat(500),
    }));
    const digest = buildSpaceAssetDigest(many);
    const lines = digest.split('\n');
    expect(lines.length).toBeLessThanOrEqual(24);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(160);
    expect(digest.length).toBeLessThanOrEqual(4000);
    // Empty input → empty digest (suggest short-circuits, no AI call).
    expect(buildSpaceAssetDigest([])).toBe('');
  });

  it('sanitizeJourneySuggestions enforces caps and drops subject-less ideas', () => {
    const got = sanitizeJourneySuggestions({
      objectives: ['  Grow activation  ', '', 'Grow activation', 'B', 'C', 'D', 'E'],
      ideas: [
        { title: 'T', subject: 'a new user activating', why: 'w' },
        { title: 'No subject', subject: '', why: 'dropped' },
        { subject: 's'.repeat(400), why: 'y'.repeat(400) },
        { title: 'x', subject: 'b', why: '' },
        { title: 'x', subject: 'c', why: '' },
        { title: 'x', subject: 'd', why: '' },
      ],
    });
    expect(got.objectives.length).toBeLessThanOrEqual(4);
    expect(got.objectives[0]).toBe('Grow activation'); // trimmed, deduped
    expect(got.ideas.length).toBeLessThanOrEqual(4);
    for (const idea of got.ideas) {
      expect(idea.subject.length).toBeGreaterThan(0);
      expect(idea.subject.length).toBeLessThanOrEqual(160);
      expect(idea.why.length).toBeLessThanOrEqual(140);
    }
    // Garbage in → empty out, never a throw.
    expect(sanitizeJourneySuggestions(null)).toEqual({ objectives: [], ideas: [] });
    expect(sanitizeJourneySuggestions('nope')).toEqual({ objectives: [], ideas: [] });
  });

  it('extractJsonObject salvages fenced and prose-wrapped replies', () => {
    const obj = { title: 'X', phases: [] };
    const clean = JSON.stringify(obj);
    expect(extractJsonObject(clean)).toEqual(obj);
    expect(extractJsonObject('```json\n' + clean + '\n```')).toEqual(obj);
    expect(extractJsonObject('Sure! Here is the map:\n' + clean + '\nHope that helps.')).toEqual(obj);
    // Nothing parseable → null (caller retries the model once).
    expect(extractJsonObject('I could not produce the JSON, sorry.')).toBeNull();
    expect(extractJsonObject('{broken')).toBeNull();
  });
});

