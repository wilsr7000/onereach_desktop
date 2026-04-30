/**
 * Stakes Classifier (Phase 1 / calibratedConfirmation)
 *
 * Pure function that labels a task as 'low' | 'medium' | 'high' stakes
 * so the confirmation policy can decide how insistently to confirm.
 *
 * Resolution order (first source that yields a value wins):
 *   1. Agent-declared stakes -- `agent.stakes` set to one of the labels.
 *      This is an opt-in field new agents can adopt; existing agents
 *      simply omit it.
 *   2. Regex pattern match over the task content (and action / params).
 *      Catches destructive verbs ("delete", "cancel", "send to X"),
 *      money movement, and bulk operations.
 *   3. 'low' -- safe default. Most voice tasks are reversible.
 *
 * The heuristic is intentionally conservative: we only escalate to
 * 'high' when the pattern is unambiguous. Ambiguous cases bias down
 * to 'medium' so the policy still prompts confirmation when the
 * winner bid is shaky, but does not harass the user on every command.
 *
 * USAGE:
 *   const stakes = classifyStakes({
 *     task:  { content: 'delete all my emails', action: 'email.delete' },
 *     agent: { id: 'email-agent', stakes: 'high' }  // optional
 *   });
 */

'use strict';

const STAKES = Object.freeze({
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
});

const VALID_STAKES = new Set(Object.values(STAKES));

// -- Pattern tables ----------------------------------------------------
// Tested against the lowercased task content. We keep patterns short
// and English-only; extending to other languages is future work that
// would hook the same classifier.

const HIGH_STAKES_PATTERNS = [
  // Destructive verbs on "all" / "everything"
  /\b(delete|remove|erase|wipe|purge|clear)\b.*\b(all|every|everything)\b/,
  /\b(all|every|everything)\b.*\b(delete|remove|erase|wipe|purge|clear)\b/,

  // Unrecoverable actions (explicit verbs)
  /\b(wipe|purge|factory reset|destroy|nuke)\b/,

  // Money movement
  /\b(purchase|buy|pay|transfer|wire|send money|charge)\b/,

  // Broadcast / external send
  /\b(send|email|text|message|call|dial)\b.+\b(everyone|the team|all contacts|group)\b/,

  // Publish publicly
  /\b(post|publish|tweet|share)\b.*\b(public(ly)?|to twitter|to facebook|to linkedin)\b/,

  // Cancel recurring / subscriptions
  /\bcancel\b.*\b(subscription|membership|account|service)\b/,

  // Unsubscribe from a meaningful source
  /\bunsubscribe\b/,
];

const MEDIUM_STAKES_PATTERNS = [
  // Creating persistent state (calendar, notes, tickets)
  /\b(schedule|book|create|add|set up)\b.*\b(meeting|event|appointment|reservation|reminder|task|ticket)\b/,

  // Single-recipient send
  /\b(send|email|text|message)\b\s+[a-z]/,

  // Targeted deletion (single item, reversible often)
  /\b(delete|remove|cancel)\b\s+(the|this|that|my)\b/,

  // Record / save persistent artefacts
  /\b(record|save|export|upload)\b/,

  // Launch something costly (browser automations, long flows)
  /\b(run|start|launch)\b.*\b(flow|automation|browser|agent|script|playbook)\b/,

  // Settings / preferences changes
  /\b(change|update|set)\b.*\b(preference|setting|default|password)\b/,
];

/**
 * @param {object} input
 * @param {object} input.task            - { content, action?, params? }
 * @param {object} [input.agent]         - winning agent, may have { stakes, executionType }
 * @returns {'low'|'medium'|'high'}
 */
function classifyStakes(input = {}) {
  const { task = {}, agent = null } = input;

  // 1. Agent declaration wins if valid.
  if (agent && VALID_STAKES.has(agent.stakes)) {
    return agent.stakes;
  }

  const content = _normalizeContent(task);
  if (!content) {
    return STAKES.LOW;
  }

  // 2. Pattern matching. High wins over medium on tie.
  for (const rx of HIGH_STAKES_PATTERNS) {
    if (rx.test(content)) return STAKES.HIGH;
  }
  for (const rx of MEDIUM_STAKES_PATTERNS) {
    if (rx.test(content)) return STAKES.MEDIUM;
  }

  // 3. If the agent is declared as 'action' executionType but we
  // matched no pattern, bias to 'low'. Action types like play/pause
  // are intentionally unobtrusive.
  return STAKES.LOW;
}

/**
 * Returns the list of compiled patterns so tests and debugging tools
 * can inspect or extend them. Mutating the returned array does not
 * affect classification.
 */
function getPatterns() {
  return {
    high: HIGH_STAKES_PATTERNS.map((rx) => rx.source),
    medium: MEDIUM_STAKES_PATTERNS.map((rx) => rx.source),
  };
}

function _normalizeContent(task) {
  const parts = [];
  if (task.content) parts.push(String(task.content));
  if (task.action) parts.push(String(task.action));
  if (task.params && typeof task.params === 'object') {
    // Flatten string params only. Complex objects are ignored to
    // keep this classifier cheap and deterministic.
    for (const v of Object.values(task.params)) {
      if (typeof v === 'string') parts.push(v);
    }
  }
  return parts.join(' ').toLowerCase().trim();
}

module.exports = {
  classifyStakes,
  getPatterns,
  STAKES,
};
