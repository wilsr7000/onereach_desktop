/**
 * Known Agent Issues Registry
 *
 * Adapted from the cranky-boyd known-issues.js pattern in podscan.
 * Each entry is { id, title, detect(ctx), fix(ctx) }.
 *
 * Simple known fixes (like timeout adjustment) are applied instantly
 * without burning LLM calls. Complex issues return fix: null to
 * escalate to the improvement engine.
 *
 * Context shape passed to detect/fix:
 *   {
 *     agent,              // full agent object from agent-store
 *     interactions,       // recent interaction array
 *     failureRate,        // 0-1
 *     rephraseRate,       // 0-1
 *     uiSpecRate,         // 0-1
 *     routingAccuracy,    // 0-1
 *     avgResponseTimeMs,
 *     memoryWrites,       // number of memory writes observed
 *   }
 */

'use strict';

const KNOWN_AGENT_ISSUES = [
  {
    id: 'KAI-001',
    title: 'Agent timeout -- execution takes too long',
    detect: (ctx) => {
      if (ctx.failureRate < 0.3 || ctx.interactions.length < 3) return false;
      const timeouts = ctx.interactions.filter(
        (i) => i.error && /timed?\s*out/i.test(i.error)
      );
      return timeouts.length >= 2;
    },
    fix: (ctx) => {
      const current = ctx.agent.estimatedExecutionMs || 5000;
      const next = Math.min(current * 2, 60000);
      if (next === current) return null;
      return {
        patch: { estimatedExecutionMs: next },
        description: `Doubled execution timeout from ${current}ms to ${next}ms`,
      };
    },
  },

  {
    id: 'KAI-002',
    title: 'Agent description too similar to another agent -- routing confusion',
    detect: (ctx) => ctx.routingAccuracy < 0.6 && ctx.interactions.length >= 5,
    fix: null,
  },

  {
    id: 'KAI-003',
    title: 'Agent returns empty or generic message',
    detect: (ctx) => {
      if (ctx.interactions.length < 5) return false;
      const empty = ctx.interactions.filter(
        (i) => !i.message || i.message === 'Done' || i.message === 'All done'
      );
      return empty.length >= 3;
    },
    fix: null,
  },

  {
    id: 'KAI-004',
    title: 'Agent has memory enabled but never writes to it',
    detect: (ctx) =>
      ctx.agent.memory?.enabled &&
      ctx.memoryWrites === 0 &&
      ctx.interactions.length >= 10,
    fix: null,
  },

  {
    id: 'KAI-005',
    title: 'Agent returns plain text when rich UI would be better',
    detect: (ctx) => {
      if (ctx.uiSpecRate > 0 || ctx.interactions.length < 5) return false;
      return ctx.interactions.some(
        (i) => i.success && i.message && i.message.length > 100
      );
    },
    fix: null,
  },

  {
    id: 'KAI-006',
    title: 'Agent has high failure rate with rate-limit errors',
    detect: (ctx) => {
      if (ctx.interactions.length < 3) return false;
      const rateLimits = ctx.interactions.filter(
        (i) => i.error && /rate.?limit|too many requests/i.test(i.error)
      );
      return rateLimits.length >= 2;
    },
    fix: (ctx) => {
      const current = ctx.agent.estimatedExecutionMs || 5000;
      return {
        patch: { estimatedExecutionMs: Math.min(current + 5000, 60000) },
        description: 'Increased timeout to accommodate rate-limit retry delays',
      };
    },
  },
];

// Learned issues discovered at runtime. These are patterns the system
// identified through the evaluator and feedback loop that recur across
// agents. They persist in memory for the session and can be serialized.
const _learnedIssues = [];
let _learnedIdCounter = 0;

/**
 * Run all known-issue checks (static + learned) against an agent context.
 * Returns array of { id, title, matched, fix } objects.
 */
function runKnownIssueChecks(ctx) {
  const results = [];
  const allIssues = [...KNOWN_AGENT_ISSUES, ..._learnedIssues];

  for (const issue of allIssues) {
    let matched = false;
    try {
      matched = typeof issue.detect === 'function' && issue.detect(ctx);
    } catch (_) {
      continue;
    }
    if (!matched) continue;

    let fixResult = null;
    if (typeof issue.fix === 'function') {
      try {
        fixResult = issue.fix(ctx);
      } catch (_) {
        fixResult = null;
      }
    }

    results.push({
      id: issue.id,
      title: issue.title,
      matched: true,
      fix: fixResult,
      needsEscalation: issue.fix === null || fixResult === null,
      learned: issue._learned || false,
    });
  }
  return results;
}

/**
 * Learn a new issue pattern from a successful improvement.
 *
 * When the feedback loop confirms an improvement was effective, the
 * system can generalize the failure pattern into a reusable detector.
 * This is how the registry grows automatically.
 *
 * @param {object} params
 * @param {string} params.title - Human-readable description
 * @param {string} params.errorPattern - Regex string to match in error messages
 * @param {string} params.improvementType - What fixed it ('prompt'|'routing'|etc.)
 * @param {number} [params.minFailureRate] - Minimum failure rate to trigger (default 0.3)
 * @param {number} [params.minOccurrences] - Minimum matching errors (default 2)
 */
function learnIssuePattern(params) {
  const { title, errorPattern, improvementType, minFailureRate = 0.3, minOccurrences = 2 } = params;

  if (!errorPattern || !title) return null;

  const existingIds = new Set([
    ...KNOWN_AGENT_ISSUES.map((i) => i.id),
    ..._learnedIssues.map((i) => i.id),
  ]);

  // Deduplicate: don't add if a very similar pattern already exists
  const patternLower = errorPattern.toLowerCase();
  const isDuplicate = _learnedIssues.some((i) =>
    i._errorPattern && i._errorPattern.toLowerCase() === patternLower
  );
  if (isDuplicate) return null;

  _learnedIdCounter++;
  const id = `KAI-L${String(_learnedIdCounter).padStart(3, '0')}`;

  let regex;
  try {
    regex = new RegExp(errorPattern, 'i');
  } catch (_) {
    return null;
  }

  const issue = {
    id,
    title,
    _learned: true,
    _errorPattern: errorPattern,
    _improvementType: improvementType,
    _learnedAt: Date.now(),
    detect: (ctx) => {
      if (ctx.failureRate < minFailureRate || ctx.interactions.length < 3) return false;
      const matches = ctx.interactions.filter(
        (i) => i.error && regex.test(i.error)
      );
      return matches.length >= minOccurrences;
    },
    fix: null, // learned issues always escalate to improvement engine
  };

  _learnedIssues.push(issue);

  return id;
}

/**
 * Get all learned issues (for inspection/serialization).
 */
function getLearnedIssues() {
  return _learnedIssues.map((i) => ({
    id: i.id,
    title: i.title,
    errorPattern: i._errorPattern,
    improvementType: i._improvementType,
    learnedAt: i._learnedAt,
  }));
}

/**
 * Clear learned issues (for testing).
 */
function clearLearnedIssues() {
  _learnedIssues.length = 0;
  _learnedIdCounter = 0;
}

module.exports = {
  KNOWN_AGENT_ISSUES,
  runKnownIssueChecks,
  learnIssuePattern,
  getLearnedIssues,
  clearLearnedIssues,
};
