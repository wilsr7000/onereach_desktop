/**
 * Auto-Heal - the agent FIXES ITSELF with Claude Code (UC-05 / UC-08).
 *
 * Where the consent-based self-heal loop (self-heal.js) ASKS before
 * rebuilding a structurally broken agent, auto-heal acts on BEHAVIORAL
 * evidence without asking: an agent that keeps failing at execution or
 * keeps returning low-graded answers is rebuilt in place from its playbook
 * via the Claude Code builder, re-verified, announced, and the original
 * request is retried — up to 3 attempts per agent per session (the cap
 * lives in agent-health-tracker).
 *
 * Only STORE agents heal (built-ins are code; their failures are bugs for
 * the app-issue pipeline, not rebuild targets).
 *
 * All side effects deps-injected; decisions unit-tested.
 */

'use strict';

const { composeRebuildRequest } = require('./self-heal');

/**
 * Attempt one automatic heal of an agent.
 *
 * @param {Object} p
 * @param {string} p.agentId
 * @param {string} [p.agentName]
 * @param {string} p.reason - 'failure-streak' | 'quality-streak'
 * @param {string|null} [p.originalRequest] - last failing task content (retried on success)
 * @param {Object} deps
 * @param {Object}   deps.tracker      - AgentHealthTracker
 * @param {Function} deps.getAgentDef  - (agentId) => stored definition | null
 * @param {Function} deps.builder      - buildAgentWithClaudeCode
 * @param {Function} deps.speak        - async (text) => void  (best-effort announce)
 * @param {Function} [deps.resubmit]   - async (text, meta) => void  (retry original request)
 * @param {Object}   deps.log
 * @returns {Promise<{ healed: boolean, reason: string, attempt?: number, verifiedMode?: string, retried?: boolean }>}
 */
async function attemptAutoHeal(p, deps) {
  const { agentId, agentName, reason, originalRequest } = p;
  const { tracker, getAgentDef, builder, speak, resubmit, log } = deps;

  const def = getAgentDef(agentId);
  if (!def) {
    // Built-in or unknown: auto-heal cannot rebuild code agents.
    return { healed: false, reason: 'not-a-store-agent' };
  }

  const attempt = tracker.beginHealAttempt(agentId);
  if (attempt === null) {
    log.warn('auto-heal', 'Heal attempts exhausted — giving up honestly', {
      event: 'auto-heal:exhausted',
      agentId,
      agentName: def.name || agentName,
    });
    try {
      await speak(
        `I've tried fixing your ${def.name || 'agent'} three times and it's still not right. I'll stop retrying — you can say "rebuild it" to try again, or we can redesign it together.`
      );
    } catch (_e) { /* announce is best-effort */ }
    return { healed: false, reason: 'attempts-exhausted' };
  }

  log.warn('auto-heal', `Auto-healing agent (attempt ${attempt}/3)`, {
    event: 'auto-heal:attempt',
    agentId,
    agentName: def.name || agentName,
    trigger: reason,
    attempt,
  });

  let build;
  try {
    build = await builder(composeRebuildRequest(def), {
      updateAgentId: agentId,
      skipBudgetCheck: false,
    });
  } catch (err) {
    log.error('auto-heal', 'Auto-heal build threw', {
      event: 'auto-heal:failed',
      agentId,
      attempt,
      error: err.message,
    });
    return { healed: false, reason: 'rebuild-threw', attempt };
  }

  const verifiedMode = (build && build.verified && build.verified.mode) || 'failed';

  if (!build || !build.success) {
    log.error('auto-heal', 'Auto-heal rebuild failed verification', {
      event: 'auto-heal:failed',
      agentId,
      attempt,
      verifiedMode,
      error: (build && build.error) || 'unknown',
    });
    return { healed: false, reason: 'rebuild-failed', attempt, verifiedMode };
  }

  // Announce honestly per verification outcome.
  const name = def.name || agentName || 'agent';
  const trigger = reason === 'quality-streak' ? 'kept giving weak answers' : 'kept failing';
  try {
    if (verifiedMode === 'live-tested') {
      await speak(`Heads up — your ${name} agent ${trigger}, so I rebuilt and tested it. It's working now.`);
    } else {
      await speak(
        `Heads up — your ${name} agent ${trigger}, so I rebuilt it. It comes online after the next restart.`
      );
    }
  } catch (_e) { /* announce is best-effort */ }

  // Retry the original request once, on a LIVE fix only.
  let retried = false;
  if (verifiedMode === 'live-tested' && originalRequest && typeof resubmit === 'function') {
    try {
      await resubmit(originalRequest, { retriedAfterHeal: true, healedAgentId: agentId });
      retried = true;
    } catch (err) {
      log.warn('auto-heal', 'Post-heal retry failed to submit', { agentId, error: err.message });
    }
  }

  log.info('auto-heal', 'Auto-heal succeeded', {
    event: 'auto-heal:healed',
    agentId,
    agentName: name,
    attempt,
    verifiedMode,
    retried,
  });

  return { healed: true, reason, attempt, verifiedMode, retried };
}

module.exports = { attemptAutoHeal };
