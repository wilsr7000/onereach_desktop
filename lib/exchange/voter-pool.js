/**
 * Voter Pool
 *
 * Role/space-based filtering for the set of agents that get to bid on a
 * given task. Introduced in Phase 3 of the agent-system upgrade.
 *
 * Today, every enabled non-bidExcluded agent bids on every task (see
 * lib/hud-api.js:337 -- "Always null -- all agents bid"). That was
 * deliberate when agent specialization was thin, but it burns tokens
 * when tasks submitted into a specific space (e.g. 'meeting-agents')
 * pull in irrelevant bidders (e.g. sound-effects-agent).
 *
 * Policy (when the `roleBasedVoterPool` flag is on):
 *   - Agent declares `defaultSpaces: ['some-space']` => only bids on
 *     tasks where `task.spaceId` matches one of those spaces.
 *   - Agent has no `defaultSpaces` => always bids (it is a generalist).
 *   - If `task.spaceId` is not set, filter is a no-op.
 *
 * This is backward-compatible: nothing in the repo declares
 * `votesOnlyInSpace`; agents that already have `defaultSpaces` today
 * were authored expecting to live in that space. Letting generalists
 * stay generalist keeps the policy simple and avoids a new opt-in.
 *
 * Phase 3 also accepts an explicit caller-supplied override so the HUD
 * or a test can force-include a specific agent in the pool (used by
 * targetAgentId dispatch and future developer-tool selectors).
 */

'use strict';

/**
 * Compute whether a single agent is eligible to vote on a task.
 *
 * @param {Object} agent    - Agent registration object
 * @param {Object} [task]   - Task object (needs `spaceId` for filtering)
 * @returns {boolean}
 */
function isAgentEligible(agent, task) {
  if (!agent) return false;
  // Exchange-level exclusions always dominate. Agents marked
  // bidExcluded are internal (error-agent, meeting-monitor-agent) and
  // invoked programmatically rather than via auction.
  if (agent.bidExcluded) return false;

  const spaceId = task && task.spaceId;
  if (!spaceId) return true;

  const declared = Array.isArray(agent.defaultSpaces) ? agent.defaultSpaces : null;
  // Generalists (no declared defaultSpaces) bid on everything.
  if (!declared || declared.length === 0) return true;
  // Specialists bid only in their declared spaces.
  return declared.includes(spaceId);
}

/**
 * Filter a full agent list down to the voter pool for a task. Returns
 * a NEW array; never mutates the input.
 *
 * @param {Array}  agents - Full list of agents (built-in + remote)
 * @param {Object} [task] - Task with optional `spaceId`
 * @returns {Array}
 */
function filterEligibleAgents(agents, task) {
  if (!Array.isArray(agents) || agents.length === 0) return [];
  return agents.filter((a) => isAgentEligible(a, task));
}

/**
 * Build the `metadata.agentFilter` array that the exchange uses to
 * restrict bidding. Returns null when no filtering is needed so the
 * exchange can skip the filter code path entirely.
 *
 *   - If the caller supplied `targetAgentId`, that wins (direct dispatch).
 *   - If `spaceId` is set AND there are specialist agents registered,
 *     return the list of eligible agent ids.
 *   - Otherwise null.
 *
 * @param {Array}  agents - Full list of agents (built-in + remote)
 * @param {Object} task
 * @param {Object} [options]
 * @param {string} [options.targetAgentId]
 * @returns {string[]|null}
 */
function buildAgentFilter(agents, task, options = {}) {
  if (options.targetAgentId) {
    return [options.targetAgentId];
  }
  if (!task || !task.spaceId) return null;

  const eligible = filterEligibleAgents(agents, task);
  // If no agents were filtered out (everyone is a generalist or
  // everyone already belongs in this space), skip the filter so the
  // exchange doesn't pay the lookup cost.
  if (!Array.isArray(agents) || eligible.length === agents.length) {
    return null;
  }
  return eligible.map((a) => a.id || a.name).filter(Boolean);
}

module.exports = {
  isAgentEligible,
  filterEligibleAgents,
  buildAgentFilter,
};
