/**
 * Task Decomposer (HUD Core)
 *
 * Detect when a user request is genuinely multiple independent tasks
 * ("play some jazz and check my calendar") and split it so the HUD
 * can fan each piece out to its own agent. Extracted from the
 * inline `decomposeIfNeeded()` function in
 * `src/voice-task-sdk/exchange-bridge.js`.
 *
 * Three pure pieces + one LLM-backed composition:
 *
 *   1. shouldSkipDecomposition(content, opts)
 *      - Cheap local guards: too short (<8 words) or matches one of
 *        the orchestrator fast-path phrases ("daily brief", "morning
 *        report", "catch me up"...). When skip fires we save the
 *        LLM call entirely.
 *
 *   2. buildDecompositionPrompt(content)
 *      - Canonical LLM prompt. Lives here so every consumer produces
 *        the same instruction set.
 *
 *   3. parseDecompositionResult(parsed)
 *      - Validates the LLM's JSON output: need isComposite=true AND
 *        subtasks array with more than one element. Any other shape
 *        collapses to "single task".
 *
 *   4. createTaskDecomposer({ ai, minWords?, orchestratorPhrases? })
 *      - Stitches the three above with an injected `ai` port.
 *        Returns { decomposeIfNeeded(content) -> Promise<{isComposite, subtasks}> }
 *        Works identically whether the ai is a real LLM, a mock, or
 *        null (always returns single-task).
 *
 * ai port contract:
 *   { json(prompt, options?): Promise<object> }
 * The consumer's adapter must return already-parsed JSON.
 */

'use strict';

// ============================================================
// Constants
// ============================================================

/**
 * Requests with fewer words than this don't plausibly contain
 * multiple independent tasks. Skip the LLM call to save cost.
 */
const DEFAULT_MIN_WORDS = 8;

/**
 * Phrases that identify a request as belonging to an
 * orchestrator agent (daily-brief-agent, etc.). The
 * orchestrator itself does the multi-source aggregation
 * internally, so the HUD should NOT decompose these.
 */
const DEFAULT_ORCHESTRATOR_PHRASES = Object.freeze([
  'brief',
  'briefing',
  'morning report',
  'daily update',
  'daily rundown',
  'catch me up',
  "what's happening today",
  'start my day',
]);

// ============================================================
// Pure primitives
// ============================================================

/**
 * Decide whether the local guards should short-circuit before any
 * LLM call. Returns a decision + reason for observability.
 *
 * @param {string} content
 * @param {object} [opts]
 * @param {number} [opts.minWords]
 * @param {string[]} [opts.orchestratorPhrases]
 * @returns {{ skip: boolean, reason: string | null }}
 */
function shouldSkipDecomposition(content, opts = {}) {
  if (typeof content !== 'string' || !content) {
    return { skip: true, reason: 'empty-or-non-string' };
  }
  const minWords =
    typeof opts.minWords === 'number' ? opts.minWords : DEFAULT_MIN_WORDS;
  const orchestratorPhrases = Array.isArray(opts.orchestratorPhrases)
    ? opts.orchestratorPhrases
    : DEFAULT_ORCHESTRATOR_PHRASES;

  const wordCount = content.trim().split(/\s+/).length;
  if (wordCount < minWords) {
    return { skip: true, reason: `below-min-words:${wordCount}` };
  }

  const lower = content.toLowerCase();
  for (const phrase of orchestratorPhrases) {
    if (typeof phrase === 'string' && lower.includes(phrase)) {
      return { skip: true, reason: `orchestrator-phrase:${phrase}` };
    }
  }

  return { skip: false, reason: null };
}

/**
 * Build the canonical decomposition prompt.
 * @param {string} content
 * @returns {string}
 */
function buildDecompositionPrompt(content) {
  const safe = typeof content === 'string' ? content : '';
  return `Analyze whether this user request contains MULTIPLE INDEPENDENT tasks that should be handled separately by different agents.

User request: "${safe}"

Rules:
- Only decompose if there are genuinely SEPARATE tasks (e.g. "play music and check my calendar")
- Do NOT decompose a single complex task (e.g. "schedule a meeting with John tomorrow at 3pm" is ONE task)
- Do NOT decompose if the parts depend on each other (e.g. "check if I'm free and then schedule" is sequential, not parallel)
- Do NOT decompose daily briefs, morning updates, or "catch me up" requests -- these are handled by a dedicated orchestrator that internally gathers weather, calendar, email, etc.
- Most requests are NOT composite -- err on the side of returning isComposite: false

Respond with JSON only:
{
  "isComposite": true/false,
  "subtasks": ["subtask 1 text", "subtask 2 text"],
  "reasoning": "Brief explanation"
}`;
}

/**
 * Validate and coerce an LLM decomposition response. Any shape
 * other than "isComposite=true AND subtasks array with >1 string
 * entries" collapses to single-task.
 *
 * @param {any} parsed
 * @returns {{ isComposite: boolean, subtasks: string[], reasoning?: string }}
 */
function parseDecompositionResult(parsed) {
  if (!parsed || typeof parsed !== 'object') {
    return { isComposite: false, subtasks: [] };
  }
  const isComposite = Boolean(parsed.isComposite);
  if (!isComposite) {
    return { isComposite: false, subtasks: [] };
  }
  const raw = Array.isArray(parsed.subtasks) ? parsed.subtasks : [];
  const subtasks = raw.filter((s) => typeof s === 'string' && s.trim().length > 0);
  if (subtasks.length <= 1) {
    return { isComposite: false, subtasks: [] };
  }
  const reasoning = typeof parsed.reasoning === 'string' ? parsed.reasoning : undefined;
  return reasoning !== undefined
    ? { isComposite: true, subtasks, reasoning }
    : { isComposite: true, subtasks };
}

// ============================================================
// Factory
// ============================================================

/**
 * @typedef {object} AiPort
 * @property {(prompt: string, options?: object) => Promise<object>} json
 *   Must return already-parsed JSON. Consumers that have a
 *   text-returning LLM adapter should wrap it:
 *     const ai = { json: async (p, o) => JSON.parse(
 *       (await rawAi.call(p, { ...o, jsonMode: true })).content
 *     ) };
 */

/**
 * @typedef {object} TaskDecomposer
 * @property {(content: string) => Promise<{
 *   isComposite: boolean,
 *   subtasks: string[],
 *   reasoning?: string,
 *   skipped?: string,
 * }>} decomposeIfNeeded
 *   - skipped is set when the local guards short-circuited before
 *     the LLM call.
 */

/**
 * Build a task decomposer wired to an `ai` port.
 *
 * When `ai` is absent or its `json` method is missing, the
 * decomposer degrades to a deterministic "always single-task"
 * behaviour so host-less consumers still get a usable interface.
 *
 * @param {object} [deps]
 * @param {AiPort} [deps.ai]
 * @param {number} [deps.minWords]
 * @param {string[]} [deps.orchestratorPhrases]
 * @param {{ info:Function, warn:Function, error:Function }} [deps.log]
 * @param {object} [deps.aiOptions]
 *   Options forwarded to ai.json. Defaults mirror the desktop app:
 *   { profile: 'fast', temperature: 0.1, maxTokens: 200, feature: 'task-decomposer' }
 * @returns {TaskDecomposer}
 */
function createTaskDecomposer(deps = {}) {
  const ai = deps.ai || null;
  const log = deps.log || { info: () => {}, warn: () => {}, error: () => {} };
  const minWords = deps.minWords;
  const orchestratorPhrases = deps.orchestratorPhrases;
  const aiOptions = deps.aiOptions || {
    profile: 'fast',
    temperature: 0.1,
    maxTokens: 200,
    feature: 'task-decomposer',
  };

  async function decomposeIfNeeded(content) {
    const skip = shouldSkipDecomposition(content, {
      minWords,
      orchestratorPhrases,
    });
    if (skip.skip) {
      return { isComposite: false, subtasks: [], skipped: skip.reason };
    }

    if (!ai || typeof ai.json !== 'function') {
      return { isComposite: false, subtasks: [], skipped: 'no-ai-port' };
    }

    try {
      const prompt = buildDecompositionPrompt(content);
      const parsed = await ai.json(prompt, aiOptions);
      const result = parseDecompositionResult(parsed);
      if (result.isComposite) {
        log.info('hud-core', '[TaskDecomposer] decomposed', {
          subtaskCount: result.subtasks.length,
          reasoning: result.reasoning,
        });
      }
      return result;
    } catch (err) {
      log.warn('hud-core', '[TaskDecomposer] LLM failed, treating as single task', {
        error: err && err.message,
      });
      return { isComposite: false, subtasks: [] };
    }
  }

  return { decomposeIfNeeded };
}

module.exports = {
  shouldSkipDecomposition,
  buildDecompositionPrompt,
  parseDecompositionResult,
  createTaskDecomposer,
  DEFAULT_MIN_WORDS,
  DEFAULT_ORCHESTRATOR_PHRASES,
};
