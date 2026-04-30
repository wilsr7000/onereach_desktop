/**
 * Handoff Phrases (Phase 2 / multi-voice transitions)
 *
 * Generates a short bridge phrase when one agent finishes and a
 * different agent is about to speak. In multi-voice mode (the
 * personalityCapChew flag OFF), the user is about to hear a voice
 * change; a brief "one sec" in the OUTGOING voice softens the cut so
 * it does not feel like being handed between strangers.
 *
 * When the personalityCapChew flag is ON, all agents use the same
 * Cap Chew voice. There is no perceptible handoff to bridge, so this
 * module returns null -- the caller skips the bridge speak().
 *
 * The handoff phrase itself is deliberately minimal:
 *   - Short: 3-6 words so the bridge doesn't eat into the answer.
 *   - Generic enough that the outgoing agent isn't pretending to know
 *     what the incoming agent is about to say.
 *   - Variety-seeded via an injectable RNG for deterministic tests.
 *
 * USAGE (caller-supplied context):
 *
 *   const phrase = buildHandoffPhrase({
 *     fromAgentId: 'time-agent',
 *     toAgentId:   'calendar-query-agent',
 *     fromAgent:   { name: 'Time Agent' },
 *     toAgent:     { name: 'Calendar Agent' },
 *     rng:         Math.random,
 *   });
 *   if (phrase) {
 *     await voiceSpeaker.speak(phrase, { voice: getAgentVoice(fromAgentId) });
 *   }
 *   // then the incoming agent speaks its own result in its own voice
 */

'use strict';

// Pool of neutral bridge phrases -- outgoing-voice vibe.
// Kept short so the transition is perceptible but not obtrusive.
const HANDOFF_PHRASES = Object.freeze([
  'one sec',
  'passing you over',
  'hold on, bringing in help',
  'handing this over',
  'bringing in the right agent',
]);

// Pool used when we can name the incoming agent. Template slot is
// replaced with the agent's short name.
const NAMED_HANDOFF_TEMPLATES = Object.freeze([
  'passing you to {name}',
  'letting {name} take this',
  'handing off to {name}',
  '{name}, take it from here',
]);

/**
 * @param {object} input
 * @param {string} input.fromAgentId      - agent that just finished (or null)
 * @param {string} input.toAgentId        - agent about to speak
 * @param {object} [input.fromAgent]      - agent record, may have .name
 * @param {object} [input.toAgent]        - agent record, may have .name
 * @param {() => number} [input.rng=Math.random]
 * @param {boolean} [input.useName=true]  - if toAgent.name is available, prefer named template
 * @returns {string|null} phrase, or null when no handoff bridge is needed
 */
function buildHandoffPhrase(input = {}) {
  const { fromAgentId = null, toAgentId = null, fromAgent = null, toAgent = null } = input;
  const rng = typeof input.rng === 'function' ? input.rng : Math.random;
  const useName = input.useName !== false;

  // No bridge when there is no prior speaker or when the same agent
  // continues; just skip naturally.
  if (!fromAgentId || !toAgentId) return null;
  if (fromAgentId === toAgentId) return null;

  // The app now ships single Cap Chew voice across every agent, so
  // there is no voice change to bridge. The function returns null by
  // design. Restoring multi-voice handoffs = revert this early exit
  // (keep the named + un-named pools below intact) and re-introduce
  // a flag if needed.
  return null;
  /* eslint-disable no-unreachable */

  // Prefer named template when we have a display name we can speak.
  const incomingName = _shortAgentName(toAgent) || _shortAgentName({ id: toAgentId });
  if (useName && incomingName) {
    const template = NAMED_HANDOFF_TEMPLATES[_pick(rng, NAMED_HANDOFF_TEMPLATES.length)];
    return template.replace('{name}', incomingName);
  }

  return HANDOFF_PHRASES[_pick(rng, HANDOFF_PHRASES.length)];
  /* eslint-enable no-unreachable */
}

/**
 * Whether a handoff bridge would fire for these inputs. Handy for
 * orchestrators that want to "speak a bridge" without calling the
 * phrase generator twice.
 */
function hasHandoff(input = {}) {
  return buildHandoffPhrase(input) !== null;
}

/**
 * Clean up an agent's display name so it speaks well in a short
 * phrase. "Calendar Query Agent" -> "calendar". If we cannot recover
 * a friendly name, return null so the caller falls back to the
 * un-named pool.
 */
function _shortAgentName(agent) {
  if (!agent) return null;
  const raw = (agent.name || agent.id || '').toString();
  if (!raw) return null;
  // Drop a trailing " Agent" or "-agent", collapse whitespace, lowercase.
  let name = raw.replace(/\s*agent\s*$/i, '').replace(/-+agent$/i, '').replace(/-+/g, ' ').trim();
  // Special cases that read weird when shortened.
  if (/^calendar\s+(query|create|edit|delete)$/i.test(name)) name = 'calendar';
  if (/^smalltalk$/i.test(name)) name = null;
  if (!name) return null;
  return name.toLowerCase();
}

function _pick(rng, len) {
  return Math.floor(rng() * len) % len;
}

module.exports = {
  HANDOFF_PHRASES,
  NAMED_HANDOFF_TEMPLATES,
  buildHandoffPhrase,
  hasHandoff,
};
