/**
 * Agent System Feature Flags
 *
 * Centralized on/off switches for the multi-phase agent-system upgrade
 * (see `.cursor/plans/agent-system-upgrade-phases_*`). All flags default
 * to OFF so importing this module never alters baseline behavior. Each
 * phase lands code behind its own flag, which is promoted to default-on
 * only after its acceptance tests pass.
 *
 * Resolution order, first match wins:
 *   1. Environment variable  AGENT_SYS_<UPPER_SNAKE>  ("1" or "true" = on)
 *      Used by tests and developer one-off overrides.
 *   2. global.settingsManager.get('agentSystemFlags')[name]
 *      Used by the running Electron app (user/dev settings).
 *   3. DEFAULT_FLAGS[name]
 *      The hard-coded off default.
 *
 * The mirror umbrella flag `agentSysV2` turns every flag on at once; use
 * it for end-to-end dogfooding, not for deciding individual behavior at
 * runtime. Call sites should check their specific flag so partial roll-
 * outs work.
 *
 * USAGE:
 *   const { isAgentFlagEnabled } = require('./agent-system-flags');
 *   if (isAgentFlagEnabled('councilMode')) { ... }
 *
 *   // tests:
 *   process.env.AGENT_SYS_COUNCIL_MODE = '1';
 */

'use strict';

/**
 * All known agent-system flags. Keep authoritative so typos fail loudly.
 * Order mirrors the phases in the upgrade plan.
 */
const DEFAULT_FLAGS = Object.freeze({
  // Umbrella -- turns every phase flag on at once. Dogfooding only.
  agentSysV2: false,

  // Phase 0 -- typed Task contract + task-store consolidation
  typedTaskContract: false,

  // Phase 1 -- wire EvaluationConsolidator into the main auction via task.variant
  councilMode: false,

  // Phase 2 -- consume learned weights in unified-bidder.selectWinner
  learnedWeights: false,

  // Phase 3 -- role/space-based voter pool + auto variant selector
  roleBasedVoterPool: false,
  variantSelector: false,

  // Phase 4 -- per-criterion agent expertise + bid-time clarification
  perCriterionBidding: false,
  bidTimeClarification: false,

  // Phase 5 -- probeUntilAdequate multi-turn elicitation loop
  adequacyLoop: false,

  // Phase 6 -- HTTP Gateway + SSE shell for flow extraction
  httpGateway: false,
});

/**
 * camelCase -> UPPER_SNAKE for env var lookup.
 * e.g. councilMode -> COUNCIL_MODE
 * @param {string} name
 * @returns {string}
 */
function _toEnvSuffix(name) {
  return name.replace(/([A-Z])/g, '_$1').toUpperCase();
}

/**
 * Read settingsManager without throwing during early boot.
 * @returns {Object|null}
 */
function _readSettingsFlags() {
  try {
    if (global.settingsManager && typeof global.settingsManager.get === 'function') {
      return global.settingsManager.get('agentSystemFlags') || {};
    }
  } catch (_err) {
    // settingsManager may be missing in tests or during early boot
  }
  return null;
}

/**
 * @param {string} name - Flag name from DEFAULT_FLAGS
 * @returns {boolean}
 */
function isAgentFlagEnabled(name) {
  if (!(name in DEFAULT_FLAGS)) {
    return false;
  }

  // Env var first -- highest precedence, used by tests
  const envValue = process.env[`AGENT_SYS_${_toEnvSuffix(name)}`];
  if (envValue === '1' || envValue === 'true') return true;
  if (envValue === '0' || envValue === 'false') return false;

  const flags = _readSettingsFlags();
  if (flags && Object.prototype.hasOwnProperty.call(flags, name)) {
    return Boolean(flags[name]);
  }

  // Umbrella flag turns everything on -- checked after per-flag settings
  // so a user who sets `councilMode: false` with `agentSysV2: true` still
  // gets explicit opt-out on council.
  if (name !== 'agentSysV2') {
    const umbrellaEnv = process.env.AGENT_SYS_AGENT_SYS_V2;
    if (umbrellaEnv === '1' || umbrellaEnv === 'true') return true;
    if (flags && flags.agentSysV2 === true) return true;
  }

  return DEFAULT_FLAGS[name];
}

/**
 * Persist a flag via settingsManager. No-op if settingsManager is
 * unavailable (e.g. Node-only test process).
 *
 * @param {string} name
 * @param {boolean} value
 * @returns {boolean} true if persisted
 */
function setAgentFlag(name, value) {
  if (!(name in DEFAULT_FLAGS)) {
    throw new Error(`Unknown agent-system flag: ${name}`);
  }
  if (!global.settingsManager || typeof global.settingsManager.set !== 'function') {
    return false;
  }
  try {
    const flags = global.settingsManager.get('agentSystemFlags') || {};
    flags[name] = Boolean(value);
    global.settingsManager.set('agentSystemFlags', flags);
    return true;
  } catch (_err) {
    return false;
  }
}

/**
 * Snapshot of every known flag's current effective value.
 * @returns {Record<string, boolean>}
 */
function getAllAgentFlags() {
  const out = {};
  for (const name of Object.keys(DEFAULT_FLAGS)) {
    out[name] = isAgentFlagEnabled(name);
  }
  return out;
}

/**
 * List known flag names.
 * @returns {string[]}
 */
function getAgentFlagNames() {
  return Object.keys(DEFAULT_FLAGS);
}

module.exports = {
  DEFAULT_FLAGS,
  isAgentFlagEnabled,
  setAgentFlag,
  getAllAgentFlags,
  getAgentFlagNames,
};
