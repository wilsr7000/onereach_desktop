/**
 * Agent Self-Heal - broken-agent detection -> proactive rebuild offer.
 *
 * The middleware and hot-connect guards already detect broken agents loudly
 * (error-level `agent:contract-violation` / `agent:hot-connect-refused`
 * events on the central log queue), but detection alone leaves the user with
 * a dead asset and a log entry they will never read. This module closes the
 * loop: when a broken agent surfaces, the orb proactively offers to rebuild
 * it through the SAME builder-consent flow as the capability-gap path, so a
 * spoken "yes" routes straight to agent-builder-agent with the broken
 * agent's stored definition as the build spec.
 *
 * Pure decisions live here (unit-testable without the bridge); the bridge
 * wires the side effects (log-queue subscription, handleNeedsInput) via the
 * deps object passed to createSelfHealNotifier.
 */

'use strict';

const BROKEN_AGENT_EVENTS = new Set([
  'agent:contract-violation',
  'agent:hot-connect-refused',
]);

/**
 * Recognize a central-log entry that names a broken agent.
 *
 * @param {Object} entry - log-event-queue entry ({ level, data, ... })
 * @returns {{ broken: boolean, event?: string, agentId?: string|null, agentName?: string|null }}
 */
function isBrokenAgentEvent(entry) {
  if (!entry || typeof entry !== 'object') return { broken: false };
  if (entry.level !== 'error') return { broken: false };
  const data = entry.data;
  if (!data || !BROKEN_AGENT_EVENTS.has(data.event)) return { broken: false };
  return {
    broken: true,
    event: data.event,
    agentId: data.agentId || null,
    agentName: data.agentName || null,
  };
}

/**
 * Pure decision: should this broken-agent event become a rebuild offer?
 *
 * @param {Object} f
 * @param {string|null} f.agentId
 * @param {string|null} f.agentName
 * @param {boolean} f.hasStoredDefinition - agent-store has a definition to rebuild from
 * @param {boolean} f.alreadyOffered      - an offer for this agent already ran this session
 * @param {boolean} f.busy                - another agent is mid-conversation awaiting input
 * @returns {{ offer: boolean, reason: string }}
 */
function shouldOfferRebuild(f = {}) {
  if (!f.agentId && !f.agentName) {
    return { offer: false, reason: 'unidentified-agent' };
  }
  if (f.alreadyOffered) {
    return { offer: false, reason: 'already-offered-this-session' };
  }
  // Don't hijack an in-flight conversation: routePendingInput would swallow
  // the user's next utterance for whichever pending agent got there first
  // (the exact hijack the gap-recheck path had to clear manually).
  if (f.busy) {
    return { offer: false, reason: 'pending-input-busy' };
  }
  // Built-in agents are code, not store artifacts -- a contract violation
  // there is a programming bug, not something the builder can rebuild.
  if (!f.hasStoredDefinition) {
    return { offer: false, reason: 'no-stored-definition' };
  }
  return { offer: true, reason: 'broken-agent' };
}

/**
 * Compose the build request the agent-builder will feed to
 * buildAgentWithClaudeCode when the user consents. Embeds the broken
 * agent's stored definition so the rebuild reproduces intent, not just name.
 *
 * @param {Object} def - stored agent definition from agent-store
 * @returns {string}
 */
function composeRebuildRequest(def = {}) {
  const parts = [
    `Rebuild the existing agent "${def.name || 'unnamed agent'}" so it works again.`,
  ];
  if (def.description) parts.push(`What it does: ${def.description}`);
  if (def.prompt) parts.push(`Current prompt/instructions: ${def.prompt}`);
  if (Array.isArray(def.keywords) && def.keywords.length) {
    parts.push(`Trigger keywords: ${def.keywords.join(', ')}`);
  }
  if (def.executionType) parts.push(`Execution type: ${def.executionType}`);
  // Playbook-backed agents rebuild from their SPEC: the playbook (composed
  // from the local-agent template at build time) is the authoritative
  // description of what this agent must do.
  if (def.playbook && def.playbook.markdown) {
    parts.push(`Its playbook (authoritative spec — rebuild to satisfy this):\n${def.playbook.markdown}`);
  }
  parts.push('Keep the same purpose and behavior; produce a working, testable agent.');
  return parts.join('\n');
}

/**
 * The spoken/displayed proactive offer.
 * @param {string} agentName
 * @returns {string}
 */
function composeOfferPrompt(agentName) {
  return (
    `Heads up — your "${agentName}" agent is broken and can't handle requests right now. ` +
    `Want me to rebuild it? I'll test it before telling you it's fixed.`
  );
}

/**
 * Build the pendingBuild context the agent-builder's consent handler expects
 * (same shape as its own feasibility offers), tagged with `rebuild` so the
 * build updates the broken agent in place instead of creating a duplicate.
 */
function buildRebuildPendingBuild(def, event) {
  return {
    originalRequest: composeRebuildRequest(def),
    assessment: {
      effort: 'easy',
      reasoning: 'Rebuild of an existing agent from its stored definition.',
      requiredIntegrations: [],
      missingAccess: [],
      estimatedCostPerUse: '~$0.05',
      similarAgent: null,
      alternativeSuggestion: null,
      spokenResponse: null,
    },
    buildMethod: 'claude-code',
    rebuild: {
      agentId: def.id || null,
      agentName: def.name || null,
      brokenEvent: event,
    },
  };
}

/**
 * Wire the self-heal notifier.
 *
 * @param {Object} deps
 * @param {Function} deps.subscribe    - (handler) => unsubscribe; delivers error-level log entries
 * @param {Function} deps.getAgentDef  - (agentId, agentName) => stored definition | null
 * @param {Function} deps.isBusy       - () => boolean; true when pending input exists
 * @param {Function} deps.offerRebuild - async ({ agentId, agentName, prompt, pendingBuild })
 * @param {Object}   deps.log          - log queue (info/warn)
 * @returns {{ stop: Function, handleEntry: Function, offeredAgents: Set<string> }}
 */
function createSelfHealNotifier(deps) {
  const { subscribe, getAgentDef, isBusy, offerRebuild, log } = deps;
  const offeredAgents = new Set();

  async function handleEntry(entry) {
    const ev = isBrokenAgentEvent(entry);
    if (!ev.broken) return { offered: false, reason: 'not-broken-agent-event' };

    const key = ev.agentId || ev.agentName;
    const def = getAgentDef(ev.agentId, ev.agentName) || null;
    const decision = shouldOfferRebuild({
      agentId: ev.agentId,
      agentName: ev.agentName,
      hasStoredDefinition: !!def,
      alreadyOffered: offeredAgents.has(key),
      busy: isBusy(),
    });

    if (!decision.offer) {
      // Deliberately NOT marked as offered on 'pending-input-busy': a later
      // re-registration of the same broken agent can retry once the user is
      // free. All other skips are terminal for the session.
      if (log && decision.reason !== 'already-offered-this-session') {
        log.info('self-heal', 'Broken agent detected, rebuild offer skipped', {
          agentId: ev.agentId,
          agentName: ev.agentName,
          event: ev.event,
          reason: decision.reason,
        });
      }
      return { offered: false, reason: decision.reason };
    }

    offeredAgents.add(key);
    const agentName = def.name || ev.agentName || 'custom';
    const offer = {
      agentId: ev.agentId,
      agentName,
      prompt: composeOfferPrompt(agentName),
      pendingBuild: buildRebuildPendingBuild(def, ev.event),
    };

    await offerRebuild(offer);
    if (log) {
      log.info('self-heal', 'Proactive rebuild offer surfaced', {
        agentId: ev.agentId,
        agentName,
        event: ev.event,
      });
    }
    return { offered: true, reason: decision.reason };
  }

  const unsubscribe = subscribe((entry) => {
    // Fire-and-forget: the log queue must never block or crash on us.
    Promise.resolve(handleEntry(entry)).catch((err) => {
      if (log) log.warn('self-heal', 'Rebuild offer failed', { error: err.message });
    });
  });

  return {
    stop: () => {
      try {
        if (typeof unsubscribe === 'function') unsubscribe();
      } catch (_e) { /* best effort */ }
    },
    handleEntry, // exposed for deterministic tests
    offeredAgents,
  };
}

module.exports = {
  BROKEN_AGENT_EVENTS,
  isBrokenAgentEvent,
  shouldOfferRebuild,
  composeRebuildRequest,
  composeOfferPrompt,
  buildRebuildPendingBuild,
  createSelfHealNotifier,
};
