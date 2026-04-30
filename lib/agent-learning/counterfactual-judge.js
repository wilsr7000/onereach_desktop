/**
 * Counterfactual Judge -- LLM-as-judge for arbitration outcomes
 *
 * Asks a sample of settled tasks: "given the user's question, the
 * winning agent's reasoning, the winner's actual answer, and the
 * runner-up's reasoning -- would the runner-up have answered better,
 * worse, or about the same?"
 *
 * The signal feeds the Phase 4 overlap tuner. The tuner needs an
 * outcome label that says "did we pick the right agent" for tuning
 * suppression constants. The reflector says "was the answer good";
 * user negative-feedback says "was the answer wrong". Neither tells us
 * "would a different agent have done better." That's what this judge
 * is for.
 *
 * Cost posture (read this before changing anything):
 *
 *   - Sample-rated. Default 10% of decisions with >= 2 bidders.
 *   - Hard timeout 15s per LLM call.
 *   - Skipped entirely when the daily learning budget slice is
 *     exhausted (the wiring layer injects the budget check).
 *   - Coalesced by taskId so a duplicate emit can't double-charge.
 *   - Fast profile + 300 max tokens.
 *
 * Why the signal weighting in the Phase 4 tuner is `userFeedback >
 * reflector > counterfactual` and not the reverse: this judge IS an
 * LLM, and LLMs have systematic biases. We use it where the other two
 * signals are silent (the user didn't push back; the reflector graded
 * the actual winner well but didn't see the runner-up). It's a
 * tiebreaker, not a primary signal.
 *
 * Emits `learning:counterfactual-judgment` on the exchange bus with
 * { taskId, judgment, confidence, runnerUpAgentId, winnerAgentId, at }.
 * The decision-recorder consumes this and joins onto the
 * arbitration-decisions Space item.
 */

'use strict';

const { getLogQueue } = require('../log-event-queue');

const DEFAULT_SAMPLE_RATE = 0.1;
const MAX_REASONING_CHARS = 800;
const MAX_ANSWER_CHARS = 1500;
const MAX_TASK_CHARS = 500;
const JUDGMENT_BUDGET_MS = 15000;
const VALID_JUDGMENTS = new Set(['runner-up-better', 'same', 'winner-better']);

class CounterfactualJudge {
  constructor(opts = {}) {
    this._log = opts.log || getLogQueue();
    this._ai = opts.ai || null;
    this._sampleRate = typeof opts.sampleRate === 'number' ? opts.sampleRate : DEFAULT_SAMPLE_RATE;
    // Optional: () => Promise<{ allowed: boolean, ... }> | { allowed: boolean }.
    // Wiring layer (lib/agent-learning/index.js) injects a budget-slice
    // check so we don't burn the entire daily learning budget on
    // counterfactuals. Absent in tests / CLI.
    this._checkBudget = typeof opts.checkBudget === 'function' ? opts.checkBudget : null;
    // RNG injection so tests can make sample decisions deterministic.
    this._random = typeof opts.random === 'function' ? opts.random : Math.random;
    this._inflight = new Map(); // taskId -> promise (coalesce duplicates)
    this._recent = [];
    this._maxRecent = opts.maxRecent || 100;
  }

  _setAi(ai) { this._ai = ai; }

  /**
   * Decide whether to judge this settled task. Returns false when:
   *   - Only one bidder (no counterfactual)
   *   - No winner answer to compare against
   *   - Sample-rate filtered us out
   *   - Daily budget slice exhausted (async caller responsibility)
   *
   * Note: sample-rate is checked synchronously here. The budget gate
   * is async and lives in `judge()` because it does I/O. Callers that
   * want to short-circuit cheaply can call `shouldJudge()` first.
   */
  shouldJudge({ task, bids, winnerAgentId, winnerAnswer }) {
    if (!task || !Array.isArray(bids)) return false;
    if (bids.length < 2) return false;
    if (!winnerAgentId) return false;
    if (typeof winnerAnswer !== 'string' || winnerAnswer.length < 3) return false;
    if (this._random() > this._sampleRate) return false;
    return true;
  }

  /**
   * Pick the runner-up bid (highest non-winning confidence). Returns
   * null when no eligible runner-up exists (e.g. only one bid, or all
   * non-winners have empty reasoning text -- an empty reasoning means
   * we can't meaningfully ask the LLM "would they have done better").
   */
  _pickRunnerUp(bids, winnerAgentId) {
    const others = (bids || [])
      .filter((b) => b && b.agentId && b.agentId !== winnerAgentId)
      .filter((b) => typeof b.reasoning === 'string' && b.reasoning.trim().length > 0)
      .sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
    return others[0] || null;
  }

  /**
   * Run the LLM judge. Always returns; never throws. On any path that
   * skips (budget, sample, no runner-up, error) the return shape is
   * { skipped: true, reason }.
   *
   * @param {object} input
   * @param {object} input.task               { id, content }
   * @param {Array}  input.bids               full bid roster
   * @param {string} input.winnerAgentId
   * @param {string} input.winnerAnswer       the actual response shown to the user
   * @returns {Promise<object>}
   */
  async judge(input) {
    const taskId = input?.task?.id || `task_${Date.now()}`;
    if (this._inflight.has(taskId)) return this._inflight.get(taskId);

    const promise = (async () => {
      // Budget gate (async).
      if (this._checkBudget) {
        try {
          const b = await this._checkBudget();
          if (b && b.allowed === false) {
            return { taskId, skipped: true, reason: 'budget-exhausted' };
          }
        } catch (_e) {
          // Budget check failure shouldn't block; treat as allowed.
        }
      }

      const runnerUp = this._pickRunnerUp(input.bids, input.winnerAgentId);
      if (!runnerUp) {
        return { taskId, skipped: true, reason: 'no-runner-up' };
      }

      const winnerBid = (input.bids || []).find((b) => b && b.agentId === input.winnerAgentId) || null;
      const taskText = (input.task?.content || '').slice(0, MAX_TASK_CHARS);
      const winnerAnswer = (input.winnerAnswer || '').slice(0, MAX_ANSWER_CHARS);

      const prompt = this._buildPrompt({
        taskText,
        winnerAgentId: input.winnerAgentId,
        winnerReasoning: (winnerBid?.reasoning || '').slice(0, MAX_REASONING_CHARS),
        winnerAnswer,
        runnerUpAgentId: runnerUp.agentId,
        runnerUpReasoning: (runnerUp.reasoning || '').slice(0, MAX_REASONING_CHARS),
      });

      try {
        if (!this._ai) this._ai = require('../ai-service');
        const raceTimer = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('counterfactual timeout')), JUDGMENT_BUDGET_MS)
        );
        const raw = await Promise.race([
          this._ai.json(prompt, {
            profile: 'fast',
            maxTokens: 300,
            feature: 'agent-learning-counterfactual',
          }),
          raceTimer,
        ]);

        const judgment = this._normalizeJudgment(raw);
        if (!judgment) {
          return { taskId, skipped: true, reason: 'invalid-llm-output' };
        }

        const record = {
          taskId,
          winnerAgentId: input.winnerAgentId,
          runnerUpAgentId: runnerUp.agentId,
          judgment: judgment.judgment,
          confidence: judgment.confidence,
          rationale: judgment.rationale,
          at: Date.now(),
        };
        this._recent.push(record);
        if (this._recent.length > this._maxRecent) this._recent.shift();

        this._log.info('agent-learning', '[CounterfactualJudge] judged', {
          taskId,
          winner: input.winnerAgentId,
          runnerUp: runnerUp.agentId,
          judgment: judgment.judgment,
          confidence: Number(judgment.confidence.toFixed(2)),
        });

        return record;
      } catch (err) {
        this._log.warn('agent-learning', '[CounterfactualJudge] LLM failed', {
          taskId,
          error: err.message,
        });
        return { taskId, skipped: true, reason: 'llm-error', error: err.message };
      } finally {
        this._inflight.delete(taskId);
      }
    })();

    this._inflight.set(taskId, promise);
    return promise;
  }

  _buildPrompt(args) {
    return `You are auditing an agent-routing decision. The user asked a question and an arbitration system picked one of N agents to answer. Compare the chosen agent's answer against what a runner-up agent would plausibly have produced based on the runner-up's stated reasoning.

USER QUESTION:
${args.taskText}

CHOSEN AGENT (${args.winnerAgentId}):
  Reasoning at bid time: ${args.winnerReasoning || '(none)'}
  Actual answer to user: ${args.winnerAnswer}

RUNNER-UP AGENT (${args.runnerUpAgentId}):
  Reasoning at bid time: ${args.runnerUpReasoning}
  (Did not run; we only have its bid reasoning.)

Judge: would the runner-up plausibly have answered the user's question BETTER than the chosen agent did?

Important guardrails:
- "Better" means: more accurate, more relevant, more complete, or more appropriate in tone.
- If the chosen answer is clearly correct and on-topic, the runner-up almost certainly would NOT have done better -- reply "winner-better".
- If the chosen answer is wrong, off-topic, or vague, AND the runner-up's reasoning suggests it would have addressed the question directly, reply "runner-up-better".
- If you genuinely cannot tell from the runner-up's reasoning alone, reply "same" with low confidence -- don't speculate.
- Confidence: 0.0 to 1.0. Use 0.9+ only when the chosen answer is obviously wrong or obviously correct. Use <= 0.4 when you're unsure.

Output JSON only:
{
  "judgment": "runner-up-better" | "same" | "winner-better",
  "confidence": 0.0-1.0,
  "rationale": "one short sentence"
}`;
  }

  _normalizeJudgment(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const judgment = typeof raw.judgment === 'string' ? raw.judgment.trim() : null;
    if (!VALID_JUDGMENTS.has(judgment)) return null;
    let confidence = typeof raw.confidence === 'number' ? raw.confidence : parseFloat(raw.confidence);
    if (!Number.isFinite(confidence)) confidence = 0.5;
    confidence = Math.max(0, Math.min(1, confidence));
    const rationale = typeof raw.rationale === 'string' ? raw.rationale.slice(0, 240) : '';
    return { judgment, confidence, rationale };
  }

  /**
   * Rolling-window stats for observability.
   */
  getStats() {
    const counts = { 'runner-up-better': 0, 'same': 0, 'winner-better': 0 };
    let totalConf = 0;
    for (const r of this._recent) {
      if (counts[r.judgment] !== undefined) counts[r.judgment] += 1;
      totalConf += r.confidence || 0;
    }
    const total = this._recent.length;
    return {
      total,
      counts,
      avgConfidence: total > 0 ? totalConf / total : 0,
    };
  }

  _resetForTests() {
    this._inflight.clear();
    this._recent.length = 0;
  }
}

let _instance = null;
function getCounterfactualJudge(opts) {
  if (!_instance) _instance = new CounterfactualJudge(opts);
  return _instance;
}

function _resetSingletonForTests() {
  _instance = null;
}

module.exports = {
  CounterfactualJudge,
  getCounterfactualJudge,
  DEFAULT_SAMPLE_RATE,
  VALID_JUDGMENTS,
  _resetSingletonForTests,
};
