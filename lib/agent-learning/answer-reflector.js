/**
 * Answer Reflector -- LLM-as-judge for agent outputs
 *
 * Runs asynchronously after every task settlement. For each completed
 * task it scores the agent's answer along four axes:
 *
 *   - grounded      Does the answer use information actually available to
 *                   the agent (search results, tool output, context)? Or
 *                   does it drift into fabrication?
 *   - relevant      Does the answer address the question asked? Or does
 *                   it answer a different question?
 *   - complete      Are there obvious gaps or missing steps? (vague non-
 *                   answers that sound reasonable but tell the user
 *                   nothing actionable score low on this.)
 *   - confident     Is the answer phrased with appropriate certainty
 *                   given the evidence? "Probably" vs "definitely".
 *
 * Each axis is 0.0 - 1.0. The overall score is a simple mean. A task
 * scoring < 0.55 gets flagged as a low-quality answer; the learning
 * loop uses this to:
 *   - Tag the interaction as a soft failure (for learning windows)
 *   - Emit `learning:low-quality-answer` for downstream consumers
 *     (including the slow-success tracker so persistent issues get
 *     surfaced to the user as build-an-agent suggestions)
 *
 * Design constraints:
 *   - Never block the user. All reflection is fire-and-forget after the
 *     answer is already in the user's ears.
 *   - Cost-conscious. Uses the `fast` profile with tight token limits
 *     and coalesces concurrent reflections of the same task.
 *   - Sampled. High-confidence agents (conformance > 0.9 on last N
 *     interactions) are sampled at a lower rate.
 *   - Pluggable. Agents can set `skipReflection: true` in their config
 *     if they have their own in-band quality check (e.g. Docs Agent).
 */

'use strict';

const { getLogQueue } = require('../log-event-queue');

const LOW_QUALITY_THRESHOLD = 0.55;
const DEFAULT_SAMPLE_RATE = 1.0;    // reflect on everything by default
const HIGH_CONF_SAMPLE_RATE = 0.25; // once an agent is proven, spot-check
const MAX_ANSWER_CHARS = 2000;      // trim long answers for the judge
const MAX_CONTEXT_CHARS = 4000;
const REFLECTION_BUDGET_MS = 15000; // hard cap on LLM call

class AnswerReflector {
  constructor(opts = {}) {
    this._log = getLogQueue();
    this._ai = opts.ai || null; // dependency-injected for tests
    this._sampleRate = opts.sampleRate ?? DEFAULT_SAMPLE_RATE;
    this._highConfSampleRate = opts.highConfSampleRate ?? HIGH_CONF_SAMPLE_RATE;
    this._lowQualityThreshold = opts.lowQualityThreshold ?? LOW_QUALITY_THRESHOLD;
    this._inflight = new Map(); // taskId -> promise (coalesce duplicates)
    this._recent = [];          // ring buffer of recent scores for stats
    this._maxRecent = opts.maxRecent || 100;
  }

  /** Dependency injection hook so tests can supply a mock AI service. */
  _setAi(ai) { this._ai = ai; }

  /**
   * Decide whether to reflect on this task. Returns false if we should
   * skip (sample-rate, opt-out, no answer to judge).
   */
  shouldReflect({ agent, result, userInput }) {
    if (!userInput || !result) return false;
    if (result?.success === false) return false; // agent itself said failed; no need
    if (result?.needsInput) return false;        // mid-conversation, not a final answer
    if (agent?.skipReflection === true) return false;

    // Nothing meaningful to judge
    const answer = result.message || result.output || '';
    if (!answer || answer.length < 3) return false;

    // Sample rate -- trusted agents get spot-checked
    const rate =
      agent?._trustedByReflection === true ? this._highConfSampleRate : this._sampleRate;
    if (Math.random() > rate) return false;
    return true;
  }

  /**
   * Run the LLM-as-judge. Returns { scores, overall, lowQuality, issues }.
   * Errors resolve to { skipped: true, error } -- never throws.
   */
  async reflect({ agent, task, result, evidence }) {
    const taskId = task?.id || `task_${Date.now()}`;
    if (this._inflight.has(taskId)) return this._inflight.get(taskId);

    const promise = (async () => {
      const userInput = task?.content || '';
      const answer = (result?.message || result?.output || '').slice(0, MAX_ANSWER_CHARS);
      const evidenceText = this._formatEvidence(evidence).slice(0, MAX_CONTEXT_CHARS);

      const prompt = this._buildPrompt({
        userInput,
        answer,
        evidenceText,
        agentName: agent?.name || agent?.id || 'unknown',
      });

      try {
        if (!this._ai) {
          this._ai = require('../ai-service');
        }
        const raceTimer = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('reflection timeout')), REFLECTION_BUDGET_MS)
        );
        const judgment = await Promise.race([
          this._ai.json(prompt, {
            profile: 'fast',
            maxTokens: 400,
            feature: 'answer-reflector',
          }),
          raceTimer,
        ]);

        const scores = this._normalizeScores(judgment);
        const overall = this._computeOverall(scores);
        const lowQuality = overall < this._lowQualityThreshold;
        const issues = Array.isArray(judgment?.issues) ? judgment.issues.slice(0, 5) : [];

        const record = { taskId, agentId: agent?.id, scores, overall, lowQuality, issues };
        this._recent.push({ ...record, at: Date.now() });
        if (this._recent.length > this._maxRecent) this._recent.shift();

        this._log.info('agent-learning', 'Reflection complete', {
          agent: agent?.id,
          overall: Number(overall.toFixed(2)),
          lowQuality,
          issues: issues.length,
        });

        return record;
      } catch (err) {
        this._log.warn('agent-learning', 'Reflection failed', { error: err.message });
        return { taskId, skipped: true, error: err.message };
      } finally {
        this._inflight.delete(taskId);
      }
    })();

    this._inflight.set(taskId, promise);
    return promise;
  }

  /**
   * Get the reflector's rolling-window stats for observability. Agents
   * above 0.9 average over last 20 reflections are considered "trusted"
   * and get a reduced sample rate.
   */
  getStatsByAgent() {
    const byAgent = {};
    for (const r of this._recent) {
      if (!r.agentId || r.skipped) continue;
      if (!byAgent[r.agentId]) byAgent[r.agentId] = { count: 0, sum: 0, lowQuality: 0 };
      byAgent[r.agentId].count += 1;
      byAgent[r.agentId].sum += r.overall;
      if (r.lowQuality) byAgent[r.agentId].lowQuality += 1;
    }
    const out = {};
    for (const [id, s] of Object.entries(byAgent)) {
      out[id] = {
        count: s.count,
        avgOverall: s.count > 0 ? s.sum / s.count : 0,
        lowQualityRate: s.count > 0 ? s.lowQuality / s.count : 0,
      };
    }
    return out;
  }

  _buildPrompt({ userInput, answer, evidenceText, agentName }) {
    return `You are judging the quality of an agent's answer. Be strict but fair.

USER QUESTION:
${userInput}

AGENT (${agentName}) ANSWER:
${answer}

${evidenceText ? `EVIDENCE THE AGENT HAD AVAILABLE:\n${evidenceText}\n` : ''}

Score each axis from 0.0 (terrible) to 1.0 (excellent):
- grounded: does the answer actually use the evidence, or does it fabricate? If no evidence was provided, judge whether the claim is safe to assert. 1.0 = every claim backed by evidence or common knowledge; 0.0 = clearly hallucinated.
- relevant: does the answer address the user's actual question? 1.0 = directly answers it; 0.0 = answers a different question entirely.
- complete: is the answer actionable and sufficient? 1.0 = nothing obvious missing; 0.0 = vague non-answer or skips key steps.
- confident: is the level of certainty appropriate? 1.0 = certainty matches evidence; 0.5 = over- or under-confident; 0.0 = wildly wrong tone.

If the answer is a clarifying question (e.g. "what city are you in?") that is the correct response, score all axes 0.9+.

Output JSON only:
{
  "grounded": 0.0-1.0,
  "relevant": 0.0-1.0,
  "complete": 0.0-1.0,
  "confident": 0.0-1.0,
  "issues": ["short strings describing specific problems, if any"],
  "verdict": "one sentence summary"
}`;
  }

  _formatEvidence(evidence) {
    if (!evidence) return '';
    if (typeof evidence === 'string') return evidence;
    if (Array.isArray(evidence)) {
      // Assume array of search-result-like { title, snippet, url }
      return evidence
        .slice(0, 7)
        .map((e, i) => {
          if (typeof e === 'string') return `[${i + 1}] ${e}`;
          const title = e.title || '';
          const snippet = e.snippet || e.description || '';
          const url = e.url || e.link || '';
          return `[${i + 1}] ${title}\n    ${snippet}${url ? `\n    ${url}` : ''}`;
        })
        .join('\n');
    }
    try { return JSON.stringify(evidence).slice(0, MAX_CONTEXT_CHARS); }
    catch { return ''; }
  }

  _normalizeScores(j) {
    const clamp = (n) => {
      const x = typeof n === 'number' ? n : parseFloat(n);
      if (Number.isNaN(x)) return 0.5;
      return Math.max(0, Math.min(1, x));
    };
    return {
      grounded: clamp(j?.grounded),
      relevant: clamp(j?.relevant),
      complete: clamp(j?.complete),
      confident: clamp(j?.confident),
    };
  }

  _computeOverall(s) {
    return (s.grounded + s.relevant + s.complete + s.confident) / 4;
  }

  _resetForTests() {
    this._inflight.clear();
    this._recent.length = 0;
  }
}

let _instance = null;
function getAnswerReflector() {
  if (!_instance) _instance = new AnswerReflector();
  return _instance;
}

module.exports = {
  AnswerReflector,
  getAnswerReflector,
  LOW_QUALITY_THRESHOLD,
};
