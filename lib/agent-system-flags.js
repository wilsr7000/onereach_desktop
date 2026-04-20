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
 * All known agent-system flags.
 *
 * As of v4.9.0 every flag defaults to TRUE: Agent System v2 is the
 * system. The flag mechanism survives only as a runtime opt-out in case
 * a deployment needs to disable a specific feature without a code
 * change. To disable:
 *
 *   settingsManager.set('agentSystemFlags', { councilMode: false });
 *
 * ...or via env:
 *
 *   AGENT_SYS_COUNCIL_MODE=0 npm start
 *
 * Keep the list authoritative so typos fail loudly.
 */
const DEFAULT_FLAGS = Object.freeze({
  // Umbrella -- retained for ergonomics (explicit `false` on a specific
  // phase still wins). Defaults true to match per-phase defaults.
  agentSysV2: true,

  // Phase 0 -- typed Task contract + task-store consolidation
  typedTaskContract: true,

  // Phase 1 -- EvaluationConsolidator wired into the main auction via task.variant
  councilMode: true,

  // Phase 2 -- consume learned weights in unified-bidder.selectWinner
  learnedWeights: true,

  // Phase 3 -- role/space-based voter pool + auto variant selector
  roleBasedVoterPool: true,
  variantSelector: true,

  // Phase 4 -- per-criterion agent expertise + bid-time clarification
  perCriterionBidding: true,
  bidTimeClarification: true,

  // Phase 5 -- probeUntilAdequate multi-turn elicitation loop
  adequacyLoop: true,

  // Phase 6 -- HTTP Gateway + SSE shell for flow extraction
  httpGateway: true,
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
 * Resolve a flag's effective value. Resolution order (first match wins):
 *
 *   1. Per-flag env var override (`AGENT_SYS_<NAME>=0|1`).
 *   2. Per-flag settings-manager override (`agentSystemFlags[name]`).
 *   3. Umbrella opt-out (`AGENT_SYS_AGENT_SYS_V2=0` or
 *      `agentSystemFlags.agentSysV2 === false`) -- kills EVERY phase
 *      flag except the umbrella itself. Useful as a single emergency
 *      switch to fall back to pre-v2 behavior.
 *   4. Per-flag default (all true in v4.9.0).
 *
 * @param {string} name
 * @returns {boolean}
 */
function isAgentFlagEnabled(name) {
  if (!(name in DEFAULT_FLAGS)) {
    return false;
  }

  // 1. Per-flag env var.
  const envValue = process.env[`AGENT_SYS_${_toEnvSuffix(name)}`];
  if (envValue === '1' || envValue === 'true') return true;
  if (envValue === '0' || envValue === 'false') return false;

  // 2. Per-flag settings.
  const flags = _readSettingsFlags();
  if (flags && Object.prototype.hasOwnProperty.call(flags, name)) {
    return Boolean(flags[name]);
  }

  // 3. Umbrella opt-out -- only applies to phase flags, not to
  //    `agentSysV2` itself (which resolves via its own default).
  if (name !== 'agentSysV2') {
    const umbrellaEnv = process.env.AGENT_SYS_AGENT_SYS_V2;
    if (umbrellaEnv === '0' || umbrellaEnv === 'false') return false;
    if (flags && flags.agentSysV2 === false) return false;
    // Umbrella-on is redundant with per-flag defaults in v4.9.0, but
    // honored for forward-compat when a future default might flip.
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
