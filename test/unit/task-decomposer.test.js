/**
 * Task Decomposer - Unit Tests
 *
 * Covers each pure primitive + the factory's full behavior with a
 * mock `ai` port, plus the legacy-equivalence guards.
 *
 * Run:  npx vitest run test/unit/task-decomposer.test.js
 */

import { describe, it, expect, vi } from 'vitest';

const {
  shouldSkipDecomposition,
  buildDecompositionPrompt,
  parseDecompositionResult,
  createTaskDecomposer,
  DEFAULT_MIN_WORDS,
  DEFAULT_ORCHESTRATOR_PHRASES,
} = require('../../lib/hud-core/task-decomposer');

// ============================================================
// shouldSkipDecomposition
// ============================================================

describe('shouldSkipDecomposition', () => {
  it('skips empty / non-string', () => {
    expect(shouldSkipDecomposition('').skip).toBe(true);
    expect(shouldSkipDecomposition(null).skip).toBe(true);
    expect(shouldSkipDecomposition(undefined).skip).toBe(true);
    expect(shouldSkipDecomposition(42).skip).toBe(true);
  });

  it('skips below-min-words (<8 default)', () => {
    const r = shouldSkipDecomposition('play some jazz tunes please');
    expect(r.skip).toBe(true);
    expect(r.reason).toMatch(/below-min-words:\d+/);
  });

  it('proceeds on 8+ words', () => {
    const r = shouldSkipDecomposition(
      'play some jazz and check my calendar for tomorrow'
    );
    expect(r.skip).toBe(false);
    expect(r.reason).toBeNull();
  });

  it('respects custom minWords', () => {
    const r = shouldSkipDecomposition('play jazz now', { minWords: 2 });
    expect(r.skip).toBe(false);
  });

  it('skips all default orchestrator phrases', () => {
    // Each sample embeds an unambiguous phrase (some phrases are
    // substrings of others -- "brief" is contained in "briefing" --
    // so the first-list-match semantics means the shorter phrase
    // wins on those. That matches the inline pre-extraction code.
    const samples = [
      { content: 'please run my brief for today with weather and traffic', expected: 'brief' },
      { content: 'please run my briefing for today with weather traffic and calendar', expected: 'brief' }, // substring wins
      { content: 'please run my morning report for today with weather and traffic', expected: 'morning report' },
      { content: 'please run my daily update for today with weather and traffic', expected: 'daily update' },
      { content: 'please run my daily rundown for today with weather and traffic', expected: 'daily rundown' },
      { content: 'please catch me up on what happened this morning with weather and traffic', expected: 'catch me up' },
      { content: "what's happening today in my calendar weather traffic schedule thanks", expected: "what's happening today" },
      { content: 'please help me start my day with weather traffic calendar and email', expected: 'start my day' },
    ];
    for (const { content, expected } of samples) {
      const r = shouldSkipDecomposition(content);
      expect(r.skip).toBe(true);
      expect(r.reason).toBe(`orchestrator-phrase:${expected}`);
    }
  });

  it('every DEFAULT_ORCHESTRATOR_PHRASES entry is individually matchable', () => {
    // Guarantee each phrase can skip at least ONE utterance (even
    // if some utterances match an earlier shorter phrase first).
    for (const phrase of DEFAULT_ORCHESTRATOR_PHRASES) {
      // Build content containing only this phrase, no other phrase
      // as a substring.
      const content = `please handle this request ${phrase} thoroughly today thanks`;
      const r = shouldSkipDecomposition(content);
      expect(r.skip).toBe(true);
    }
  });

  it('phrase matching is case-insensitive', () => {
    const r = shouldSkipDecomposition(
      'Please run my MORNING REPORT for me this morning thanks'
    );
    expect(r.skip).toBe(true);
    expect(r.reason).toContain('morning report');
  });

  it('custom orchestratorPhrases override defaults', () => {
    const r = shouldSkipDecomposition(
      'schedule a meeting about the quarterly briefing for next Tuesday',
      { orchestratorPhrases: ['quarterly briefing'] }
    );
    expect(r.skip).toBe(true);
    expect(r.reason).toBe('orchestrator-phrase:quarterly briefing');
  });

  it('DEFAULT_MIN_WORDS matches desktop (8)', () => {
    expect(DEFAULT_MIN_WORDS).toBe(8);
  });
});

// ============================================================
// buildDecompositionPrompt
// ============================================================

describe('buildDecompositionPrompt', () => {
  it('embeds the user content exactly', () => {
    const p = buildDecompositionPrompt('play music and check calendar');
    expect(p).toContain('"play music and check calendar"');
  });

  it('includes the JSON-only rule', () => {
    const p = buildDecompositionPrompt('anything');
    expect(p).toMatch(/Respond with JSON only/i);
    expect(p).toContain('"isComposite"');
    expect(p).toContain('"subtasks"');
    expect(p).toContain('"reasoning"');
  });

  it('mentions all four canonical rules', () => {
    const p = buildDecompositionPrompt('x');
    expect(p).toMatch(/genuinely SEPARATE tasks/i);
    expect(p).toMatch(/single complex task/i);
    expect(p).toMatch(/depend on each other/i);
    expect(p).toMatch(/daily briefs/i);
  });

  it('tolerates non-string input', () => {
    expect(() => buildDecompositionPrompt(null)).not.toThrow();
    expect(buildDecompositionPrompt(null)).toContain('""');
  });
});

// ============================================================
// parseDecompositionResult
// ============================================================

describe('parseDecompositionResult', () => {
  it('accepts canonical valid shape', () => {
    const r = parseDecompositionResult({
      isComposite: true,
      subtasks: ['play jazz', 'check calendar'],
      reasoning: 'two domains',
    });
    expect(r.isComposite).toBe(true);
    expect(r.subtasks).toEqual(['play jazz', 'check calendar']);
    expect(r.reasoning).toBe('two domains');
  });

  it('collapses to single-task when isComposite=false', () => {
    expect(
      parseDecompositionResult({
        isComposite: false,
        subtasks: ['a', 'b', 'c'],
      })
    ).toEqual({ isComposite: false, subtasks: [] });
  });

  it('collapses to single-task when subtasks has 0 or 1 items', () => {
    expect(
      parseDecompositionResult({ isComposite: true, subtasks: [] })
    ).toEqual({ isComposite: false, subtasks: [] });
    expect(
      parseDecompositionResult({ isComposite: true, subtasks: ['solo'] })
    ).toEqual({ isComposite: false, subtasks: [] });
  });

  it('filters non-string / empty subtasks before the count check', () => {
    const r = parseDecompositionResult({
      isComposite: true,
      subtasks: ['play jazz', '', null, 42, 'check calendar'],
    });
    expect(r.isComposite).toBe(true);
    expect(r.subtasks).toEqual(['play jazz', 'check calendar']);
  });

  it('tolerates non-object / null input', () => {
    expect(parseDecompositionResult(null)).toEqual({
      isComposite: false,
      subtasks: [],
    });
    expect(parseDecompositionResult('json string')).toEqual({
      isComposite: false,
      subtasks: [],
    });
    expect(parseDecompositionResult(undefined)).toEqual({
      isComposite: false,
      subtasks: [],
    });
  });

  it('omits reasoning when not a string', () => {
    const r = parseDecompositionResult({
      isComposite: true,
      subtasks: ['a', 'b'],
      reasoning: 42,
    });
    expect(r.reasoning).toBeUndefined();
  });
});

// ============================================================
// createTaskDecomposer
// ============================================================

describe('createTaskDecomposer', () => {
  it('without ai port -> always single-task with skipped=no-ai-port', async () => {
    const d = createTaskDecomposer();
    const r = await d.decomposeIfNeeded(
      'play music and check calendar please right now okay'
    );
    expect(r.isComposite).toBe(false);
    expect(r.subtasks).toEqual([]);
    expect(r.skipped).toBe('no-ai-port');
  });

  it('short input is skipped before any ai call', async () => {
    const ai = { json: vi.fn() };
    const d = createTaskDecomposer({ ai });
    const r = await d.decomposeIfNeeded('play jazz');
    expect(r.isComposite).toBe(false);
    expect(r.skipped).toMatch(/below-min-words/);
    expect(ai.json).not.toHaveBeenCalled();
  });

  it('orchestrator phrase is skipped before any ai call', async () => {
    const ai = { json: vi.fn() };
    const d = createTaskDecomposer({ ai });
    const r = await d.decomposeIfNeeded(
      'please give me my morning report and also my schedule'
    );
    expect(r.isComposite).toBe(false);
    expect(r.skipped).toMatch(/orchestrator-phrase/);
    expect(ai.json).not.toHaveBeenCalled();
  });

  it('happy path: calls ai.json and returns the parsed decomposition', async () => {
    const ai = {
      json: vi.fn().mockResolvedValue({
        isComposite: true,
        subtasks: ['play jazz', 'check calendar'],
        reasoning: 'two domains',
      }),
    };
    const d = createTaskDecomposer({ ai });
    const r = await d.decomposeIfNeeded(
      'play some jazz music and check my calendar for tomorrow'
    );
    expect(ai.json).toHaveBeenCalledTimes(1);
    expect(r.isComposite).toBe(true);
    expect(r.subtasks).toEqual(['play jazz', 'check calendar']);
  });

  it('forwards aiOptions to ai.json', async () => {
    const ai = { json: vi.fn().mockResolvedValue({ isComposite: false }) };
    const d = createTaskDecomposer({
      ai,
      aiOptions: { profile: 'slow', temperature: 0.2, maxTokens: 100, feature: 'custom' },
    });
    await d.decomposeIfNeeded(
      'decompose this task into parts and tell me how to proceed'
    );
    const [, opts] = ai.json.mock.calls[0];
    expect(opts).toEqual({ profile: 'slow', temperature: 0.2, maxTokens: 100, feature: 'custom' });
  });

  it('LLM throw -> collapses to single task, does not propagate', async () => {
    const ai = { json: vi.fn().mockRejectedValue(new Error('network down')) };
    const d = createTaskDecomposer({ ai });
    const r = await d.decomposeIfNeeded(
      'play some jazz music and check my calendar for tomorrow'
    );
    expect(r.isComposite).toBe(false);
    expect(r.subtasks).toEqual([]);
  });

  it('LLM returns nonsense -> collapses to single task', async () => {
    const ai = { json: vi.fn().mockResolvedValue('not an object') };
    const d = createTaskDecomposer({ ai });
    const r = await d.decomposeIfNeeded(
      'play jazz music and then check my calendar for tomorrow'
    );
    expect(r.isComposite).toBe(false);
  });

  it('log port receives info on success + warn on LLM failure', async () => {
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const ai = {
      json: vi.fn().mockResolvedValueOnce({
        isComposite: true,
        subtasks: ['a', 'b'],
        reasoning: 'two',
      }),
    };
    const d = createTaskDecomposer({ ai, log });
    await d.decomposeIfNeeded(
      'play some jazz music and check my calendar for tomorrow'
    );
    expect(log.info).toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();

    ai.json.mockRejectedValueOnce(new Error('x'));
    await d.decomposeIfNeeded(
      'do one thing and also do another completely separate task'
    );
    expect(log.warn).toHaveBeenCalled();
  });
});

// ============================================================
// Legacy equivalence
// ============================================================

describe('legacy equivalence to decomposeIfNeeded()', () => {
  // Reproduces the pre-extraction inline guards from exchange-bridge.js
  function legacyShouldSkip(content) {
    if (!content || typeof content !== 'string') return true;
    const wordCount = content.trim().split(/\s+/).length;
    if (wordCount < 8) return true;
    const lower = content.toLowerCase();
    const phrases = [
      'brief',
      'briefing',
      'morning report',
      'daily update',
      'daily rundown',
      'catch me up',
      "what's happening today",
      'start my day',
    ];
    return phrases.some((p) => lower.includes(p));
  }

  const cases = [
    '',
    null,
    'play jazz',
    'play some jazz and check calendar right now please thanks',
    'please give me my daily briefing about today including weather and traffic',
    'morning report please and thank you include my calendar for today',
    'schedule a meeting with John tomorrow at three oclock please',
    'what happens if I play music and also check the news together',
  ];
  for (const c of cases) {
    it(`legacy skip(${JSON.stringify(c)}) === extracted`, () => {
      const extracted = shouldSkipDecomposition(c).skip;
      expect(extracted).toBe(legacyShouldSkip(c));
    });
  }
});
