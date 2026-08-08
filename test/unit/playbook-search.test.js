/**
 * lib/playbook-search.js — playbook search, both tiers.
 *
 * Tier 1 (deterministic): routes through the canonical SpacesAPI.search with
 * content scoring ON, filters to playbooks with the REAL isPlaybook heuristic
 * (imported from playbook-executor — no drifting copy).
 *
 * Tier 2 (agentic): walks playbooks ONE BY ONE, resolving each against the
 * natural-language query via the LLM. We assert the walk order (keyword-ranked
 * first, then the rest), strict sequentiality, early-stop caps, and that a
 * failing evaluation skips the item instead of sinking the search.
 *
 * All deps are injected (spacesAPI / ai fakes); isPlaybook is the real one.
 *
 * Run:  npx vitest run test/unit/playbook-search.test.js
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../lib/log-event-queue', () => ({
  getLogQueue: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

const { searchPlaybooks, agenticSearchPlaybooks } = require('../../lib/playbook-search');
const { isPlaybook } = require('../../lib/playbook-executor');

// ── Fixtures ───────────────────────────────────────────────────────────────

const PLAYBOOKS = [
  {
    id: 'pb-deploy',
    spaceId: 'ops',
    type: 'text',
    timestamp: 3000,
    metadata: { title: 'Deploy Runbook' },
    tags: ['playbook'],
    content: '## Steps\n1. Build the release\n2. Notarize\n3. Push to GitHub feed',
  },
  {
    id: 'pb-onboard',
    spaceId: 'sales',
    type: 'text',
    timestamp: 2000,
    metadata: { title: 'Customer Onboarding Playbook' },
    tags: [],
    content: '## Steps\n1. Kickoff call\n2. Provision the enterprise tenant\n3. Training session',
  },
  {
    id: 'pb-incident',
    spaceId: 'ops',
    type: 'text',
    timestamp: 1000,
    metadata: { title: 'Sev1 Response' },
    tags: ['playbook'],
    content: '## Phases\n1. **Triage** the alert\n2. **Mitigate** user impact\n3. Postmortem',
  },
];

const NON_PLAYBOOKS = [
  { id: 'note-1', spaceId: 'ops', type: 'text', timestamp: 500, metadata: { title: 'Lunch notes' }, tags: [], content: 'pizza friday' },
  { id: 'vid-1', spaceId: 'ops', type: 'file', timestamp: 400, metadata: { title: 'recording' }, tags: [], content: '' },
];

const ALL_ITEMS = [...PLAYBOOKS, ...NON_PLAYBOOKS];

// A fake SpacesAPI: search() does naive substring scoring over title+content
// (stands in for the canonical scorer), storage.getAllItems() returns all.
function fakeSpacesAPI(items = ALL_ITEMS) {
  const calls = { search: [], itemsGet: [] };
  return {
    calls,
    storage: { getAllItems: () => items },
    items: {
      get: async (spaceId, id) => {
        calls.itemsGet.push(id);
        return items.find((i) => i.id === id) || null;
      },
    },
    search: async (query, options) => {
      calls.search.push({ query, options });
      const q = query.toLowerCase();
      return items
        .map((i) => {
          let score = 0;
          const title = (i.metadata?.title || '').toLowerCase();
          if (title.includes(q)) score += 10;
          if (options.searchContent && (i.content || '').toLowerCase().includes(q)) score += 5;
          return score > 0
            ? { ...i, _search: { score, matches: [{ field: title.includes(q) ? 'title' : 'content' }], highlights: {} } }
            : null;
        })
        .filter(Boolean)
        .sort((a, b) => b._search.score - a._search.score)
        .slice(0, options.limit || 100);
    },
  };
}

const realDeps = (spacesAPI, ai) => ({ spacesAPI, isPlaybook, ai });

// ── Tier 1: deterministic ──────────────────────────────────────────────────

describe('searchPlaybooks (deterministic tier)', () => {
  it('finds a playbook by CONTENT that its title never mentions', async () => {
    const api = fakeSpacesAPI();
    // "notarize" appears only in pb-deploy's body; its title says "Runbook".
    const results = await searchPlaybooks('notarize', {}, realDeps(api));
    expect(results.map((r) => r.id)).toEqual(['pb-deploy']);
    // And the canonical search was asked for content scoring explicitly.
    expect(api.calls.search[0].options.searchContent).toBe(true);
  });

  it('filters non-playbooks out even when they match the query', async () => {
    const api = fakeSpacesAPI();
    // "pizza" matches note-1, which is not a playbook.
    const results = await searchPlaybooks('pizza', {}, realDeps(api));
    expect(results).toEqual([]);
  });

  it('empty query lists every playbook (and only playbooks), newest first', async () => {
    const api = fakeSpacesAPI();
    const results = await searchPlaybooks('', {}, realDeps(api));
    expect(results.map((r) => r.id)).toEqual(['pb-deploy', 'pb-onboard', 'pb-incident']);
    expect(results.every((r) => r.score === null)).toBe(true);
  });

  it('scopes to a space when asked', async () => {
    const api = fakeSpacesAPI();
    const results = await searchPlaybooks('', { spaceId: 'ops' }, realDeps(api));
    expect(results.map((r) => r.id)).toEqual(['pb-deploy', 'pb-incident']);
  });

  it('shapes rows with title, preview, score and matches', async () => {
    const api = fakeSpacesAPI();
    const [row] = await searchPlaybooks('onboarding', {}, realDeps(api));
    expect(row.id).toBe('pb-onboard');
    expect(row.title).toBe('Customer Onboarding Playbook');
    expect(row.preview).toContain('Kickoff call');
    expect(row.score).toBeGreaterThan(0);
    expect(row.matches.length).toBeGreaterThan(0);
  });
});

// ── Tier 2: agentic ────────────────────────────────────────────────────────

describe('agenticSearchPlaybooks (one-by-one prompt resolution)', () => {
  it('walks playbooks one by one — keyword hits first, then the rest — and returns LLM matches with reasons', async () => {
    const api = fakeSpacesAPI();
    const evaluatedTitles = [];
    let inFlight = 0;
    const ai = {
      json: vi.fn(async (prompt) => {
        inFlight++;
        expect(inFlight).toBe(1); // strictly sequential — never concurrent
        await new Promise((r) => {
          setTimeout(r, 2);
        });
        inFlight--;
        const title = /Playbook title: (.*)/.exec(prompt)[1];
        evaluatedTitles.push(title);
        // The LLM recognizes the incident playbook as the on-call match even
        // though the query shares no keywords with it.
        if (title === 'Sev1 Response') {
          return { match: true, confidence: 0.9, reason: 'On-call incident handling steps', matchedSections: ['Triage'] };
        }
        return { match: false, confidence: 0.1, reason: 'unrelated' };
      }),
    };

    const out = await agenticSearchPlaybooks(
      'what do I follow when I get paged at night',
      {},
      realDeps(api, ai)
    );

    // No keyword hits for this query -> the walk still covered all playbooks.
    expect(evaluatedTitles.length).toBe(3);
    expect(out.evaluated).toBe(3);
    expect(out.matches).toHaveLength(1);
    expect(out.matches[0].id).toBe('pb-incident');
    expect(out.matches[0].confidence).toBe(0.9);
    expect(out.matches[0].reason).toMatch(/incident/i);
    expect(out.matches[0].matchedSections).toEqual(['Triage']);
  });

  it('evaluates keyword-ranked candidates before the rest', async () => {
    const api = fakeSpacesAPI();
    const order = [];
    const ai = {
      json: vi.fn(async (prompt) => {
        order.push(/Playbook title: (.*)/.exec(prompt)[1]);
        return { match: false, confidence: 0 };
      }),
    };
    await agenticSearchPlaybooks('onboarding', {}, realDeps(api, ai));
    // 'onboarding' keyword-matches pb-onboard -> it must be examined FIRST.
    expect(order[0]).toBe('Customer Onboarding Playbook');
    expect(order.length).toBe(3);
  });

  it('stops after stopAfter matches (early exit)', async () => {
    const api = fakeSpacesAPI();
    const ai = { json: vi.fn(async () => ({ match: true, confidence: 0.8, reason: 'yes' })) };
    const out = await agenticSearchPlaybooks('steps', { stopAfter: 1 }, realDeps(api, ai));
    expect(out.matches).toHaveLength(1);
    expect(out.stoppedEarly).toBe(true);
    expect(ai.json).toHaveBeenCalledTimes(1);
  });

  it('respects maxEvaluations as a hard cap', async () => {
    const api = fakeSpacesAPI();
    const ai = { json: vi.fn(async () => ({ match: false, confidence: 0 })) };
    const out = await agenticSearchPlaybooks('anything at all', { maxEvaluations: 2 }, realDeps(api, ai));
    expect(ai.json).toHaveBeenCalledTimes(2);
    expect(out.evaluated).toBe(2);
    expect(out.stoppedEarly).toBe(true);
  });

  it('a failing evaluation skips that playbook and continues the walk', async () => {
    const api = fakeSpacesAPI();
    let call = 0;
    const ai = {
      json: vi.fn(async () => {
        call++;
        if (call === 1) throw new Error('LLM hiccup');
        return { match: true, confidence: 0.7, reason: 'works' };
      }),
    };
    const out = await agenticSearchPlaybooks('steps', { stopAfter: 5 }, realDeps(api, ai));
    expect(out.evaluated).toBe(3);
    expect(out.matches.length).toBe(2); // items 2 and 3 still matched
  });

  it('streams progress: evaluating for each item, match on hits', async () => {
    const api = fakeSpacesAPI();
    const ai = { json: vi.fn(async () => ({ match: true, confidence: 0.6, reason: 'ok' })) };
    const events = [];
    await agenticSearchPlaybooks(
      'steps',
      { stopAfter: 2, onProgress: (p) => events.push(p.phase + ':' + (p.title || '')) },
      realDeps(api, ai)
    );
    expect(events.filter((e) => e.startsWith('evaluating:')).length).toBe(2);
    expect(events.filter((e) => e.startsWith('match:')).length).toBe(2);
  });

  it('uses the fast profile and the playbook-search budget feature by default', async () => {
    const api = fakeSpacesAPI();
    const ai = { json: vi.fn(async () => ({ match: false })) };
    await agenticSearchPlaybooks('x steps x', { maxEvaluations: 1 }, realDeps(api, ai));
    const [, opts] = ai.json.mock.calls[0];
    expect(opts.profile).toBe('fast');
    expect(opts.feature).toBe('playbook-search');
  });

  it('ranks final matches by confidence, not evaluation order', async () => {
    const api = fakeSpacesAPI();
    const confidences = [0.3, 0.95, 0.6];
    let i = 0;
    const ai = { json: vi.fn(async () => ({ match: true, confidence: confidences[i++], reason: 'r' })) };
    const out = await agenticSearchPlaybooks('steps', {}, realDeps(api, ai));
    expect(out.matches.map((m) => m.confidence)).toEqual([0.95, 0.6, 0.3]);
  });

  it('empty query returns an empty result without touching the LLM', async () => {
    const api = fakeSpacesAPI();
    const ai = { json: vi.fn() };
    const out = await agenticSearchPlaybooks('   ', {}, realDeps(api, ai));
    expect(out.matches).toEqual([]);
    expect(ai.json).not.toHaveBeenCalled();
  });
});
