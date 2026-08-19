/**
 * Playbook Q&A — the corpus agent.
 *
 * Quality is a different verb from retrieval, and the failure this
 * pins is the tempting one: answering "which playbooks are well
 * written?" with retrieval machinery. That machinery judges subject
 * matter, orders candidates by keyword, and stops after the first N
 * that pass — so it would return a confident ranking computed from an
 * arbitrary slice. These tests hold the line: score EVERYTHING, rank
 * after, cache by content hash so verdicts are stable.
 *
 * All deps injected; the LLM is a fake.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../lib/log-event-queue', () => ({
  getLogQueue: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

const qa = require('../../lib/playbook-qa');

const PLAYBOOKS = [
  { id: 'pb-good', spaceId: 'ops', title: 'Deploy Runbook', content: '# Deploy\n1. Build\n2. Notarize' },
  { id: 'pb-mid', spaceId: 'ops', title: 'Onboarding', content: 'Align stakeholders and iterate.' },
  { id: 'pb-bad', spaceId: 'ops', title: 'Draft', content: 'TODO write this' },
];

/** Fake search whose deterministic tier lists the corpus. */
function fakeSearch(rows = PLAYBOOKS) {
  return {
    searchPlaybooks: vi.fn(async () => rows),
    agenticSearchPlaybooks: vi.fn(async (q) => ({
      query: q,
      matches: [{ id: 'pb-good', title: 'Deploy Runbook', spaceId: 'ops', confidence: 0.9, reason: 'covers deploys' }],
      evaluated: 3,
      totalCandidates: 3,
    })),
  };
}

/** Fake LLM scoring by id, so ranking is predictable. */
function fakeAi(scoreById) {
  return {
    json: vi.fn(async (prompt) => {
      const id = Object.keys(scoreById).find((k) => prompt.includes(scoreById[k].title));
      const s = id ? scoreById[id].s : 0.5;
      return {
        dimensions: { anchored: s, verifiable: s, brevity: s, purpose: s, complete: s },
        reason: `scored ${s}`,
        weakest: 'brevity',
      };
    }),
  };
}

const SCORES = {
  'pb-good': { title: 'Deploy Runbook', s: 0.9 },
  'pb-mid': { title: 'Onboarding', s: 0.6 },
  'pb-bad': { title: 'Draft', s: 0.2 },
};

/**
 * Every caller must establish access — the default resolver fails
 * closed, so a test that omits this correctly gets an empty answer.
 * The fixtures all live in space 'ops'.
 */
const ALLOW_OPS = { visibleSpaceIds: async () => new Set(['ops']) };

function deps(overrides = {}) {
  return {
    playbookSearch: fakeSearch(),
    ai: fakeAi(SCORES),
    verdictStore: qa.createMemoryVerdictStore(),
    access: ALLOW_OPS,
    ...overrides,
  };
}

describe('classifyQuestion — routing without a model round-trip', () => {
  it('routes craft questions to quality', () => {
    for (const q of [
      'which playbooks are really well written?',
      'show me the worst ones',
      'is this playbook any good',
      'which need work',
    ]) {
      expect(qa.classifyQuestion(q), q).toBe('quality');
    }
  });

  it('routes topic questions to retrieval', () => {
    for (const q of [
      'which playbook covers enterprise onboarding?',
      'the deploy runbook',
      'how do I notarize a build',
    ]) {
      expect(qa.classifyQuestion(q), q).toBe('retrieval');
    }
  });
});

describe('scoring', () => {
  it('weights the rubric rather than averaging it flat', () => {
    const perfect = {};
    for (const d of qa.QUALITY_RUBRIC) perfect[d.id] = 1;
    expect(qa.scoreOf(perfect)).toBe(1);
    // verifiable carries more weight than complete, so failing it costs more
    const failVerifiable = { ...perfect, verifiable: 0 };
    const failComplete = { ...perfect, complete: 0 };
    expect(qa.scoreOf(failVerifiable)).toBeLessThan(qa.scoreOf(failComplete));
  });

  it('clamps nonsense from the model instead of trusting it', () => {
    expect(qa.scoreOf({ anchored: 5, verifiable: -2, brevity: 'x', purpose: null, complete: 1 }))
      .toBeGreaterThanOrEqual(0);
    expect(qa.scoreOf({ anchored: 5, verifiable: 5, brevity: 5, purpose: 5, complete: 5 })).toBe(1);
  });
});

describe('verdict cache — stable answers, incremental cost', () => {
  it('re-judges nothing when the content is unchanged', async () => {
    const d = deps();
    const pb = PLAYBOOKS[0];
    const first = await qa.evaluateQuality(pb, {}, d);
    const second = await qa.evaluateQuality(pb, {}, d);
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(second.score).toBe(first.score);
    expect(d.ai.json).toHaveBeenCalledTimes(1);
  });

  it('re-judges when the content changes — the hash is the key', async () => {
    const d = deps();
    await qa.evaluateQuality(PLAYBOOKS[0], {}, d);
    await qa.evaluateQuality({ ...PLAYBOOKS[0], content: 'rewritten' }, {}, d);
    expect(d.ai.json).toHaveBeenCalledTimes(2);
  });

  it('refresh: true forces a re-judge', async () => {
    const d = deps();
    await qa.evaluateQuality(PLAYBOOKS[0], {}, d);
    const again = await qa.evaluateQuality(PLAYBOOKS[0], { refresh: true }, d);
    expect(again.cached).toBe(false);
    expect(d.ai.json).toHaveBeenCalledTimes(2);
  });

  it('the rubric version is part of the key, so a standard change invalidates', () => {
    const a = qa.verdictKey('same text');
    expect(a.startsWith(`v${qa.RUBRIC_VERSION}:`)).toBe(true);
    expect(qa.verdictKey('other text')).not.toBe(a);
  });
});

describe('assessCorpus — score everything, THEN rank', () => {
  it('evaluates every candidate and ranks by score', async () => {
    const d = deps();
    const out = await qa.assessCorpus({}, d);
    expect(out.evaluated).toBe(3);
    expect(out.totalCandidates).toBe(3);
    expect(out.ranked.map((r) => r.id)).toEqual(['pb-good', 'pb-mid', 'pb-bad']);
  });

  it('limit truncates the RESULT, never the evaluation', async () => {
    const d = deps();
    const out = await qa.assessCorpus({ limit: 1 }, d);
    expect(out.ranked).toHaveLength(1);
    // still judged all three — "the best one" is unknowable otherwise
    expect(out.evaluated).toBe(3);
    expect(d.ai.json).toHaveBeenCalledTimes(3);
  });

  it('a failed evaluation is SKIPPED, never scored zero', async () => {
    const ai = {
      json: vi.fn(async (prompt) => {
        if (prompt.includes('Onboarding')) throw new Error('LLM down');
        return { dimensions: { anchored: 1, verifiable: 1, brevity: 1, purpose: 1, complete: 1 } };
      }),
    };
    const out = await qa.assessCorpus({}, deps({ ai }));
    expect(out.evaluated).toBe(2);
    expect(out.skipped).toBe(1);
    // the failure must not appear as a bottom-ranked playbook
    expect(out.ranked.find((r) => r.id === 'pb-mid')).toBeUndefined();
  });

  it('reports cache hits so a caller can see the sweep was incremental', async () => {
    const d = deps();
    await qa.assessCorpus({}, d);
    const second = await qa.assessCorpus({}, d);
    expect(second.fromCache).toBe(3);
    expect(d.ai.json).toHaveBeenCalledTimes(3);
  });
});

describe('answerPlaybookQuestion — the agent entry point', () => {
  it('answers a quality question with a ranking and a readable summary', async () => {
    const out = await qa.answerPlaybookQuestion('which playbooks are well written?', {}, deps());
    expect(out.mode).toBe('quality');
    expect(out.results[0].id).toBe('pb-good');
    expect(out.results[0].dimensions).toBeDefined();
    expect(out.answer).toContain('Assessed 3 playbooks');
    expect(out.answer).toContain('Deploy Runbook');
    expect(out.rubricVersion).toBe(qa.RUBRIC_VERSION);
  });

  it('answers a topic question through retrieval, not the rubric', async () => {
    const d = deps();
    const out = await qa.answerPlaybookQuestion('which playbook covers deploys?', {}, d);
    expect(out.mode).toBe('retrieval');
    expect(d.playbookSearch.agenticSearchPlaybooks).toHaveBeenCalled();
    expect(d.ai.json).not.toHaveBeenCalled(); // no quality sweep
    expect(out.results[0].confidence).toBe(0.9);
  });

  it('an explicit mode overrides the heuristic', async () => {
    const d = deps();
    const out = await qa.answerPlaybookQuestion('the deploy runbook', { mode: 'quality' }, d);
    expect(out.mode).toBe('quality');
    expect(d.playbookSearch.agenticSearchPlaybooks).not.toHaveBeenCalled();
  });

  it('an empty question asks for one instead of sweeping the corpus', async () => {
    const d = deps();
    const out = await qa.answerPlaybookQuestion('   ', {}, d);
    expect(out.mode).toBe('none');
    expect(out.results).toEqual([]);
    expect(d.ai.json).not.toHaveBeenCalled();
  });

  it('says it could not check rather than reporting nothing is good', async () => {
    const ai = { json: vi.fn(async () => { throw new Error('LLM down'); }) };
    const out = await qa.answerPlaybookQuestion('which are well written?', {}, deps({ ai }));
    expect(out.evaluated).toBe(0);
    expect(out.answer).toMatch(/could be assessed|evaluations failed/i);
    expect(out.answer).not.toMatch(/0 scored 0\.8/);
  });
});

// ── Permissions ────────────────────────────────────────────────────────────
//
// A corpus agent is an exfiltration surface: one question can return
// titles, previews and critiques of every playbook on the graph. These
// pin the posture — filter BEFORE reading, and fail CLOSED.

const MIXED = [
  { id: 'pb-open', spaceId: 'open-space', title: 'Deploy Runbook', content: '# Deploy\n1. Build' },
  { id: 'pb-secret', spaceId: 'locked-space', title: 'Layoff Plan', content: 'confidential' },
];

function accessDeps(access, rows = MIXED) {
  return {
    playbookSearch: {
      searchPlaybooks: vi.fn(async () => rows),
      agenticSearchPlaybooks: vi.fn(async () => ({
        matches: rows.map((r) => ({ ...r, confidence: 0.9, reason: 'match' })),
        evaluated: rows.length,
        totalCandidates: rows.length,
      })),
    },
    ai: fakeAi(SCORES),
    verdictStore: qa.createMemoryVerdictStore(),
    access,
  };
}

const OPEN_ONLY = { visibleSpaceIds: vi.fn(async () => new Set(['open-space'])) };
const UNDETERMINED = { visibleSpaceIds: vi.fn(async () => null) };

describe('permissions — filter before reading, fail closed', () => {
  it('never EVALUATES a playbook the viewer cannot see', async () => {
    const d = accessDeps(OPEN_ONLY);
    const out = await qa.answerPlaybookQuestion('which are well written?', {}, d);
    expect(out.results.map((r) => r.id)).toEqual(['pb-open']);
    expect(out.withheld).toBe(1);
    // The restricted playbook was never sent to the model or cached.
    const prompts = d.ai.json.mock.calls.map((c) => c[0]).join('\n');
    expect(prompts).not.toContain('Layoff Plan');
    expect(prompts).not.toContain('confidential');
  });

  it('fails CLOSED when access cannot be determined — answers about nothing', async () => {
    const d = accessDeps(UNDETERMINED);
    const out = await qa.answerPlaybookQuestion('which are well written?', {}, d);
    expect(out.results).toEqual([]);
    expect(out.accessUndetermined).toBe(true);
    expect(d.ai.json).not.toHaveBeenCalled();
    expect(out.answer).toMatch(/could not be established/i);
  });

  it('says WHY it is empty rather than implying the corpus is bad', async () => {
    const d = accessDeps({ visibleSpaceIds: vi.fn(async () => new Set()) });
    const out = await qa.answerPlaybookQuestion('which are well written?', {}, d);
    expect(out.answer).toMatch(/outside your access/i);
    expect(out.answer).not.toMatch(/0 scored/);
  });

  it('gates RETRIEVAL too — a match leaks a title and a reason', async () => {
    const d = accessDeps(OPEN_ONLY);
    const out = await qa.answerPlaybookQuestion('which playbook covers deploys?', {}, d);
    expect(out.mode).toBe('retrieval');
    expect(out.results.map((r) => r.id)).toEqual(['pb-open']);
    expect(JSON.stringify(out)).not.toContain('Layoff Plan');
  });

  it('retrieval fails closed as well', async () => {
    const out = await qa.answerPlaybookQuestion('the deploy runbook', {}, accessDeps(UNDETERMINED));
    expect(out.results).toEqual([]);
    expect(out.answer).toMatch(/could not be established/i);
  });

  it('a row with no spaceId is dropped — unplaceable cannot be shown allowed', async () => {
    const rows = [{ id: 'pb-orphan', title: 'Orphan', content: 'x' }];
    const out = await qa.answerPlaybookQuestion(
      'which are well written?',
      {},
      accessDeps(OPEN_ONLY, rows)
    );
    expect(out.results).toEqual([]);
    expect(out.withheld).toBe(1);
  });

  it('the viewer is passed to the resolver, not assumed', async () => {
    const d = accessDeps(OPEN_ONLY);
    await qa.answerPlaybookQuestion('which are well written?', { viewer: { id: 'robb@onereach.com' } }, d);
    expect(OPEN_ONLY.visibleSpaceIds).toHaveBeenCalledWith({ id: 'robb@onereach.com' });
  });

  it('filterByAccess is fail-closed on a resolver that throws shape', async () => {
    const out = await qa.filterByAccess(MIXED, null, {
      access: { visibleSpaceIds: async () => undefined },
    });
    expect(out.visible).toEqual([]);
    expect(out.undetermined).toBe(true);
  });
});
