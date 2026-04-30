/**
 * Transcript Reviewer (Phase 3 of self-learning arbitration)
 *
 * Daily cron that reads `arbitration-decisions` items over the last
 * windowDays (default 7), runs an LLM analysis on the corpus, and
 * emits a transcripts-review Space item per run with:
 *
 *   findings:      patterns the LLM noticed
 *   proposedRules: routing rule changes the LLM recommends
 *
 * Proposed rules are queued for user review via the existing
 * `userQueue.addReviewItem` mechanism. Once the user accepts a rule,
 * it is added to the `learned-arbitration-rules` store and the
 * master orchestrator starts applying it on every decision.
 *
 * Queue management (the "user attention is finite" guardrail):
 *
 *   - maxProposalsPerCycle (default 3): the LLM may emit any number
 *     of proposals; we queue at most N. Excess proposals are still
 *     written to the transcripts-review Space item with queued=false
 *     so the operator can audit what wasn't surfaced.
 *   - proposalStalenessDays (default 30): on each cycle, any proposal
 *     queued more than this many days ago without a user decision is
 *     auto-rejected with reason 'stale'. The reviewer can re-propose
 *     if the pattern still holds.
 *
 * Cost posture:
 *   - Daily cadence (configurable). Off-hours.
 *   - One LLM call per run. fast profile, 1500 max tokens.
 *   - Gated on the transcriptReview slice of dailyBudget.
 *
 * @file lib/agent-learning/transcript-reviewer.js
 */

'use strict';

const { getLogQueue } = require('../log-event-queue');

const DEFAULT_WINDOW_DAYS = 7;
const DEFAULT_MAX_PROPOSALS_PER_CYCLE = 3;
const DEFAULT_STALENESS_DAYS = 30;
const DEFAULT_MAX_DECISIONS_TO_REVIEW = 200;
const DEFAULT_MIN_DECISIONS_TO_RUN = 10;
const REVIEW_BUDGET_MS = 60_000;

const TRANSCRIPTS_SPACE_ID = 'transcripts-review';
const TRANSCRIPTS_SPACE_NAME = 'Transcripts Review';
const TRANSCRIPTS_TAG = 'transcripts-review';

const ARBITRATION_SPACE_ID = 'arbitration-decisions';

class TranscriptReviewer {
  constructor(opts = {}) {
    this._log = opts.log || getLogQueue();
    this._ai = opts.ai || null;
    this._spacesAPI = opts.spacesAPI || null;
    this._userQueue = opts.userQueue || null;
    this._rulesStore = opts.rulesStore || null;
    this._checkBudget = typeof opts.checkBudget === 'function' ? opts.checkBudget : null;

    this._windowDays = typeof opts.windowDays === 'number' ? opts.windowDays : DEFAULT_WINDOW_DAYS;
    this._maxProposalsPerCycle = typeof opts.maxProposalsPerCycle === 'number'
      ? opts.maxProposalsPerCycle
      : DEFAULT_MAX_PROPOSALS_PER_CYCLE;
    this._proposalStalenessDays = typeof opts.proposalStalenessDays === 'number'
      ? opts.proposalStalenessDays
      : DEFAULT_STALENESS_DAYS;
    this._maxDecisions = typeof opts.maxDecisions === 'number'
      ? opts.maxDecisions
      : DEFAULT_MAX_DECISIONS_TO_REVIEW;
    this._minDecisions = typeof opts.minDecisions === 'number'
      ? opts.minDecisions
      : DEFAULT_MIN_DECISIONS_TO_RUN;
  }

  _getSpacesAPI() {
    if (this._spacesAPI) return this._spacesAPI;
    try {
      const { getSpacesAPI } = require('../../spaces-api');
      this._spacesAPI = getSpacesAPI();
    } catch (_e) {
      this._spacesAPI = null;
    }
    return this._spacesAPI;
  }

  /**
   * Ensure the transcripts-review Space exists. Idempotent.
   */
  async ensureTranscriptsSpace() {
    try {
      const api = this._getSpacesAPI();
      if (!api) return false;
      const storage = api.storage || api._storage;
      if (!storage) return false;

      const exists = (storage.index?.spaces || []).find((s) => s.id === TRANSCRIPTS_SPACE_ID);
      if (exists) return true;
      storage.createSpace({
        id: TRANSCRIPTS_SPACE_ID,
        name: TRANSCRIPTS_SPACE_NAME,
        icon: '◇',
        color: '#a855f7',
        isSystem: true,
      });
      this._log.info('agent-learning', '[TranscriptReviewer] Created transcripts-review space');
      return true;
    } catch (err) {
      this._log.warn('agent-learning', '[TranscriptReviewer] ensureSpace failed', { error: err.message });
      return false;
    }
  }

  /**
   * Read arbitration-decision items in the rolling window. Each item's
   * content field is JSON; parse to extract structural metadata for the
   * LLM corpus.
   *
   * @returns {Array<{ taskId, content, bids, chosenWinner, decisionPath, executionMode, outcome, createdAt }>}
   */
  _readDecisions(now) {
    const api = this._getSpacesAPI();
    if (!api) return [];
    const storage = api.storage || api._storage;
    if (!storage) return [];
    const cutoff = (now || Date.now()) - this._windowDays * 24 * 60 * 60 * 1000;
    const items = (storage.index?.items || [])
      .filter((i) => i.spaceId === ARBITRATION_SPACE_ID)
      .filter((i) => typeof i.timestamp === 'number' && i.timestamp >= cutoff)
      .slice(-this._maxDecisions);

    const decisions = [];
    for (const item of items) {
      try {
        const decision = JSON.parse(item.content);
        if (decision && decision.taskId) decisions.push(decision);
      } catch (_e) {
        // Skip unparsable; the recorder always writes valid JSON, so
        // bad shapes here would mean external corruption.
      }
    }
    return decisions;
  }

  _buildPrompt(decisions) {
    // Serialise a structured summary of each decision -- the LLM
    // doesn't need raw user content (that may be redacted anyway), it
    // needs the bid pattern + outcome label.
    const summaries = decisions.map((d, i) => {
      const bidsLine = (d.bids || [])
        .map((b) => `${b.agentId}@${(b.confidence || 0).toFixed(2)}${b.won ? '*' : ''}`)
        .join(', ');
      const outcomeBits = [];
      if (typeof d.outcome?.success === 'boolean') outcomeBits.push(`success=${d.outcome.success}`);
      if (typeof d.outcome?.reflectorScore === 'number') {
        outcomeBits.push(`reflector=${d.outcome.reflectorScore.toFixed(2)}`);
      }
      if (d.outcome?.userFeedback) outcomeBits.push(`userFeedback=${d.outcome.userFeedback}`);
      if (d.outcome?.counterfactualJudgment) {
        outcomeBits.push(`counterfactual=${d.outcome.counterfactualJudgment}`);
      }
      const taskExcerpt = (d.content || '').slice(0, 80).replace(/\n/g, ' ');
      return `${i + 1}. "${taskExcerpt}" | bids: ${bidsLine} | won: ${d.chosenWinner} | path: ${d.decisionPath} | ${outcomeBits.join(', ')}`;
    });
    return `You are auditing a decentralised agent-routing system. The system runs an auction on every user task: agents bid with confidence + reasoning, an arbitration layer picks one or more winners, and outcome signals (LLM reflector, user feedback, counterfactual judge) tell us how it went.

Below is a sample of recent decisions. Find PATTERNS that suggest specific routing-rule changes. Be conservative: only propose a rule when a pattern has clear evidence (3+ supporting decisions). Do NOT propose rules to "see what happens"; the user will be reviewing each one.

DECISIONS (${decisions.length}):
${summaries.join('\n')}

Your output is JSON only:
{
  "windowDays": ${this._windowDays},
  "decisionsAnalyzed": ${decisions.length},
  "findings": [
    {
      "type": "redundant-bidders" | "over-confident-bidder" | "under-confident-bidder" | "wrong-routing",
      "severity": "low" | "medium" | "high",
      "description": "one-sentence pattern description",
      "evidence": ["taskId", "..."]
    }
  ],
  "proposedRules": [
    {
      "id": "stable id derived from rule semantics, e.g. shrink-cal-on-time-q",
      "type": "shrink" | "boost" | "suppress-pair" | "route-class",
      "target": "agentId" | ["agentA", "agentB"],
      "magnitude": 0.0-1.0,
      "conditions": {
        "taskClass": "time | calendar | weather | local-search | ...",
        "taskContentMatchesRegex": "(optional) regex string"
      },
      "rationale": "tie this rule to evidence taskIds in 1-2 sentences"
    }
  ]
}

If no clear patterns: emit empty arrays. Speculative rules are worse than no rules.`;
  }

  _normaliseFindings(raw) {
    if (!raw || typeof raw !== 'object') return { findings: [], proposedRules: [] };
    const findings = Array.isArray(raw.findings) ? raw.findings.slice(0, 20).filter((f) => f && typeof f === 'object') : [];
    const proposedRules = Array.isArray(raw.proposedRules)
      ? raw.proposedRules.slice(0, 50).filter((r) => r && typeof r === 'object' && r.id)
      : [];
    return { findings, proposedRules };
  }

  _scoreProposal(p) {
    // Severity * evidence. Used to pick top-N within the per-cycle cap.
    const severities = { low: 1, medium: 2, high: 3 };
    let evidenceCount = 0;
    if (Array.isArray(p.findings)) evidenceCount = p.findings.length;
    if (Array.isArray(p.evidence)) evidenceCount = p.evidence.length;
    const sev = severities[p.severity] || 1;
    return sev * Math.max(1, evidenceCount);
  }

  /**
   * Run one review cycle. Returns a summary of what happened.
   *
   * @param {object} [opts]
   * @param {number} [opts.now]   for deterministic tests
   * @returns {Promise<{
   *   ranAt: number,
   *   skipped?: boolean,
   *   reason?: string,
   *   decisionsAnalyzed: number,
   *   findings: Array,
   *   proposedRules: Array,
   *   queued: Array<{id: string, queued: boolean, reason?: string}>,
   *   stalePruned: number,
   *   spaceItemId?: string,
   * }>}
   */
  async runOnce(opts = {}) {
    const now = typeof opts.now === 'number' ? opts.now : Date.now();
    const ranAt = now;

    // 1. Stale-proposal sweep -- always run, regardless of budget
    //    (it doesn't call the LLM).
    const stalePruned = this._sweepStaleProposals(now);

    // 2. Budget gate.
    if (this._checkBudget) {
      try {
        const b = await this._checkBudget();
        if (b && b.allowed === false) {
          return { ranAt, skipped: true, reason: 'budget-exhausted', decisionsAnalyzed: 0,
                   findings: [], proposedRules: [], queued: [], stalePruned };
        }
      } catch (_e) { /* fail-open */ }
    }

    // 3. Read corpus.
    await this.ensureTranscriptsSpace();
    const decisions = this._readDecisions(now);
    if (decisions.length < this._minDecisions) {
      return { ranAt, skipped: true, reason: 'insufficient-data', decisionsAnalyzed: decisions.length,
               findings: [], proposedRules: [], queued: [], stalePruned };
    }

    // 4. LLM analysis.
    let raw;
    try {
      if (!this._ai) this._ai = require('../ai-service');
      const prompt = this._buildPrompt(decisions);
      const raceTimer = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('transcript-review timeout')), REVIEW_BUDGET_MS)
      );
      raw = await Promise.race([
        this._ai.json(prompt, {
          profile: 'fast',
          maxTokens: 1500,
          feature: 'agent-learning-transcriptReview',
        }),
        raceTimer,
      ]);
    } catch (err) {
      this._log.warn('agent-learning', '[TranscriptReviewer] LLM failed', { error: err.message });
      return { ranAt, skipped: true, reason: 'llm-error', decisionsAnalyzed: decisions.length,
               findings: [], proposedRules: [], queued: [], stalePruned, error: err.message };
    }

    const { findings, proposedRules } = this._normaliseFindings(raw);

    // 5. Pick the top-N proposals to queue; mark the rest queued=false.
    const ranked = [...proposedRules]
      .map((p, idx) => ({ p, idx, score: this._scoreProposal(p) }))
      .sort((a, b) => b.score - a.score);
    const topIds = new Set(ranked.slice(0, this._maxProposalsPerCycle).map((x) => x.p.id));
    const queued = proposedRules.map((p) => ({
      id: p.id,
      queued: topIds.has(p.id),
      reason: topIds.has(p.id) ? null : 'over-cap',
    }));

    // 6. Push the top proposals to the user-review queue.
    if (this._userQueue && typeof this._userQueue.addReviewItem === 'function') {
      for (const q of queued) {
        if (!q.queued) continue;
        const proposal = proposedRules.find((p) => p.id === q.id);
        if (!proposal) continue;
        try {
          this._userQueue.addReviewItem({
            text: this._buildReviewItemText(proposal),
            metadata: {
              type: 'arbitration-rule-proposal',
              proposal,
              proposedAt: ranAt,
            },
            agentId: 'agent-learning',
            agentName: 'Self-Learning System',
          });
        } catch (err) {
          this._log.warn('agent-learning', '[TranscriptReviewer] addReviewItem failed', {
            error: err.message,
            proposalId: q.id,
          });
        }
      }
    }

    // 7. Persist the run as a transcripts-review item.
    let spaceItemId = null;
    try {
      const api = this._getSpacesAPI();
      const storage = api?.storage || api?._storage;
      if (storage && typeof storage.addItem === 'function') {
        const payload = {
          type: 'transcripts-review',
          ranAt,
          windowDays: this._windowDays,
          decisionsAnalyzed: decisions.length,
          findings,
          proposedRules,
          queued,
          stalePruned,
        };
        const item = storage.addItem({
          type: 'text',
          content: JSON.stringify(payload),
          spaceId: TRANSCRIPTS_SPACE_ID,
          timestamp: ranAt,
          metadata: {
            title: `Review ${new Date(ranAt).toISOString().split('T')[0]} (${decisions.length} decisions)`,
            itemType: 'transcripts-review',
            decisionsAnalyzed: decisions.length,
            proposedCount: proposedRules.length,
            queuedCount: queued.filter((q) => q.queued).length,
          },
          tags: [TRANSCRIPTS_TAG],
        });
        spaceItemId = item?.id || null;
      }
    } catch (err) {
      this._log.warn('agent-learning', '[TranscriptReviewer] Persist failed', { error: err.message });
    }

    this._log.info('agent-learning', '[TranscriptReviewer] cycle complete', {
      decisionsAnalyzed: decisions.length,
      findings: findings.length,
      proposedRules: proposedRules.length,
      queued: queued.filter((q) => q.queued).length,
      stalePruned,
    });

    return {
      ranAt,
      decisionsAnalyzed: decisions.length,
      findings,
      proposedRules,
      queued,
      stalePruned,
      spaceItemId,
    };
  }

  _buildReviewItemText(proposal) {
    const target = Array.isArray(proposal.target) ? proposal.target.join(' + ') : proposal.target;
    return `Routing rule proposal: ${proposal.type} ${target} (magnitude=${proposal.magnitude}). ${proposal.rationale || ''}`;
  }

  /**
   * Sweep the user-review queue for arbitration-rule-proposal items
   * older than proposalStalenessDays without a user decision; mark
   * them rejected with reason 'stale' and remove from the queue. The
   * reviewer can re-propose next cycle if the pattern still holds.
   */
  _sweepStaleProposals(now) {
    if (!this._userQueue) return 0;
    const cutoff = now - this._proposalStalenessDays * 24 * 60 * 60 * 1000;
    let pruned = 0;
    try {
      const list =
        typeof this._userQueue.getAllItems === 'function'
          ? this._userQueue.getAllItems() || []
          : (typeof this._userQueue.getItems === 'function'
            ? this._userQueue.getItems() || []
            : []);
      for (const item of list) {
        if (item?.resolved) continue;
        if (item?.metadata?.type !== 'arbitration-rule-proposal') continue;
        const proposedAt = item.metadata.proposedAt || item.timestamp || 0;
        if (proposedAt >= cutoff) continue;
        if (typeof this._userQueue.removeItem === 'function') {
          this._userQueue.removeItem(item.id);
          pruned += 1;
        } else if (typeof this._userQueue.resolveItem === 'function') {
          this._userQueue.resolveItem(item.id);
          pruned += 1;
        }
      }
    } catch (err) {
      this._log.warn('agent-learning', '[TranscriptReviewer] Stale sweep failed', { error: err.message });
    }
    return pruned;
  }

  /**
   * Apply a user-accepted proposal: insert it into the rules store.
   * Returns the inserted rule, or null on rejection.
   */
  acceptProposal(proposal) {
    if (!this._rulesStore) {
      try {
        const { getLearnedArbitrationRules } = require('./learned-arbitration-rules');
        this._rulesStore = getLearnedArbitrationRules();
      } catch (_e) {
        return null;
      }
    }
    const rule = {
      ...proposal,
      acceptedAt: Date.now(),
      acceptedBy: 'user',
      sourceFindingId: proposal.id || null,
    };
    return this._rulesStore.addRule(rule);
  }
}

let _instance = null;
function getTranscriptReviewer(opts) {
  if (!_instance) _instance = new TranscriptReviewer(opts);
  return _instance;
}

function _resetSingletonForTests() {
  _instance = null;
}

module.exports = {
  TranscriptReviewer,
  getTranscriptReviewer,
  TRANSCRIPTS_SPACE_ID,
  TRANSCRIPTS_SPACE_NAME,
  TRANSCRIPTS_TAG,
  DEFAULT_WINDOW_DAYS,
  DEFAULT_MAX_PROPOSALS_PER_CYCLE,
  DEFAULT_STALENESS_DAYS,
  _resetSingletonForTests,
};
