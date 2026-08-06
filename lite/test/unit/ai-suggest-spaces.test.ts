/**
 * "Which Spaces does this belong in?" — the AI shortlist behind the
 * multi-space picker.
 *
 * The safety property that matters most: a suggestion can only ever
 * name a Space that was PASSED IN. Everything the model returns is
 * filtered against the real candidate list, so an invented id or an
 * echoed name can never surface as a clickable Space in the UI.
 */

import { describe, it, expect } from 'vitest';
import {
  buildSuggestSpacesUserContent,
  parseSuggestSpacesResult,
  validateSuggestSpacesShape,
  callClaudeSuggestSpaces,
  SUGGEST_SPACES_SYSTEM_PROMPT,
  MAX_SUGGESTIONS,
  type SuggestSpaceCandidate,
} from '../../ai/suggest-spaces.js';

const CANDIDATES: SuggestSpaceCandidate[] = [
  { id: 'sp-eng', name: 'Engineering', description: 'Platform + infra work' },
  { id: 'sp-design', name: 'Design system refresh', description: 'Component library' },
  { id: 'sp-hiring', name: 'Hiring' },
];

const ITEM = { title: 'Button component audit', kind: 'document', text: 'Reviewing button variants' };

describe('buildSuggestSpacesUserContent', () => {
  it('includes the item and every candidate id + name + description', () => {
    const out = buildSuggestSpacesUserContent(ITEM, CANDIDATES);
    expect(out).toContain('Button component audit');
    expect(out).toContain('id=sp-design');
    expect(out).toContain('Design system refresh');
    expect(out).toContain('Component library');
    // A description-less Space still appears (name only).
    expect(out).toContain('id=sp-hiring');
  });

  it('truncates very long item text rather than sending everything', () => {
    const out = buildSuggestSpacesUserContent(
      { title: 'Big', text: 'x'.repeat(10_000) },
      CANDIDATES
    );
    expect(out).toContain('…');
    expect(out.length).toBeLessThan(9_000);
  });
});

describe('the system prompt states the rules the UI relies on', () => {
  it('forbids invented ids and permits an empty list', () => {
    expect(SUGGEST_SPACES_SYSTEM_PROMPT).toContain('Never invent an id');
    expect(SUGGEST_SPACES_SYSTEM_PROMPT).toContain('EMPTY list');
  });
});

describe('validateSuggestSpacesShape', () => {
  it('keeps valid suggestions in order', () => {
    const r = validateSuggestSpacesShape(
      {
        suggestions: [
          { spaceId: 'sp-design', reason: 'Audits button variants in the component library' },
          { spaceId: 'sp-eng', reason: 'Implementation lives in the platform repo' },
        ],
      },
      CANDIDATES
    );
    expect(r.suggestions.map((s) => s.spaceId)).toEqual(['sp-design', 'sp-eng']);
  });

  it('DROPS a hallucinated space id (the critical guard)', () => {
    const r = validateSuggestSpacesShape(
      {
        suggestions: [
          { spaceId: 'sp-does-not-exist', reason: 'invented' },
          { spaceId: 'sp-eng', reason: 'real' },
        ],
      },
      CANDIDATES
    );
    expect(r.suggestions).toHaveLength(1);
    expect(r.suggestions[0]?.spaceId).toBe('sp-eng');
  });

  it('drops a NAME echoed where an id belongs', () => {
    const r = validateSuggestSpacesShape(
      { suggestions: [{ spaceId: 'Engineering', reason: 'used the name' }] },
      CANDIDATES
    );
    expect(r.suggestions).toEqual([]);
  });

  it('de-duplicates repeated ids and caps the count', () => {
    const many = Array.from({ length: 10 }, () => ({ spaceId: 'sp-eng', reason: 'dupe' }));
    expect(validateSuggestSpacesShape({ suggestions: many }, CANDIDATES).suggestions).toHaveLength(1);

    const spread = [
      { spaceId: 'sp-eng', reason: 'a' },
      { spaceId: 'sp-design', reason: 'b' },
      { spaceId: 'sp-hiring', reason: 'c' },
    ];
    expect(
      validateSuggestSpacesShape({ suggestions: spread }, CANDIDATES).suggestions.length
    ).toBeLessThanOrEqual(MAX_SUGGESTIONS);
  });

  it('collapses whitespace and truncates a runaway reason', () => {
    const r = validateSuggestSpacesShape(
      { suggestions: [{ spaceId: 'sp-eng', reason: `line one\n\n   line two ${'z'.repeat(500)}` }] },
      CANDIDATES
    );
    const reason = r.suggestions[0]?.reason ?? '';
    expect(reason).not.toContain('\n');
    expect(reason.length).toBeLessThanOrEqual(140);
  });

  it('returns an empty list for junk rather than throwing', () => {
    expect(validateSuggestSpacesShape(null, CANDIDATES).suggestions).toEqual([]);
    expect(validateSuggestSpacesShape([], CANDIDATES).suggestions).toEqual([]);
    expect(validateSuggestSpacesShape({ suggestions: 'nope' }, CANDIDATES).suggestions).toEqual([]);
    expect(validateSuggestSpacesShape({ suggestions: [1, 'x', null] }, CANDIDATES).suggestions).toEqual([]);
  });
});

describe('parseSuggestSpacesResult', () => {
  it('parses a fenced JSON block', () => {
    const raw = '```json\n{"suggestions":[{"spaceId":"sp-eng","reason":"infra work"}]}\n```';
    expect(parseSuggestSpacesResult(raw, CANDIDATES).suggestions[0]?.spaceId).toBe('sp-eng');
  });

  it('treats an empty response as "no suggestions", not an error', () => {
    expect(parseSuggestSpacesResult('', CANDIDATES).suggestions).toEqual([]);
  });

  it('throws a structured AiError on non-JSON', () => {
    expect(() => parseSuggestSpacesResult('I think Engineering!', CANDIDATES)).toThrow();
  });
});

describe('callClaudeSuggestSpaces', () => {
  it('sends the schema + system prompt and returns filtered suggestions', async () => {
    let seen: Record<string, unknown> | null = null;
    const result = await callClaudeSuggestSpaces(ITEM, CANDIDATES, {
      model: 'claude-test',
      createMessage: async (params) => {
        seen = params as unknown as Record<string, unknown>;
        return {
          content: [
            { type: 'text', text: '{"suggestions":[{"spaceId":"sp-design","reason":"component work"}]}' },
          ],
        } as never;
      },
    });
    expect(result.suggestions[0]).toEqual({ spaceId: 'sp-design', reason: 'component work' });
    expect(seen?.['system']).toBe(SUGGEST_SPACES_SYSTEM_PROMPT);
    expect(seen?.['model']).toBe('claude-test');
    expect(JSON.stringify(seen?.['output_config'])).toContain('json_schema');
  });

  it('a refusal yields an empty shortlist, never a thrown error', async () => {
    const result = await callClaudeSuggestSpaces(ITEM, CANDIDATES, {
      model: 'claude-test',
      createMessage: async () => ({ stop_reason: 'refusal', content: [] }) as never,
    });
    expect(result.suggestions).toEqual([]);
  });
});
