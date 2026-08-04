/**
 * Ensure the "Event Manager" local agent exists - the manage-events voice
 * agent, seeded through the SAME playbook-backed pipeline user builds take:
 * its playbook is composed from the local-agent template, saved to Spaces,
 * and stored on the agent config so self-heal rebuilds regenerate from the
 * spec.
 *
 * The agent is a LOCAL (store) agent on purpose: it exercises the whole
 * self-healing surface (hot-wrap, contract validation, rebuild offers) that
 * built-in JS agents bypass -- it is the designated self-heal test target.
 *
 * Idempotent: creates when missing; patches playbook/tools onto an existing
 * definition that predates them; otherwise a no-op.
 */

'use strict';

const { getLogQueue } = require('../log-event-queue');
const log = getLogQueue();

const EVENT_AGENT_NAME = 'Event Manager';

const EVENT_AGENT_TOOLS = Object.freeze([
  'events_open_app',
  'events_add',
  'events_next',
  'events_delete',
  'get_current_time',
]);

const EVENT_AGENT_KEYWORDS = Object.freeze([
  'appointment',
  'appointments',
  'my events',
  'events app',
  'add event',
  'add an event',
  'recurring event',
  'schedule an event',
  "what's next",
  'whats next',
  'what is next',
  'manage events',
  'open my events',
  'upcoming events',
]);

const EVENT_AGENT_PROMPT = `You are Event Manager, the voice agent for the user's personal events and appointments (one-off and recurring). Events live in the shared OneReach graph — the watch reads the same data.

RULES:
1. ALWAYS call get_current_time first when the request involves a date or "what's next" — you must resolve relative times ("tomorrow 3pm", "next Tuesday") into absolute ISO datetimes yourself before calling events_add.
2. ALWAYS call events_open_app so the Manage Events app pops open in a modal — on plain "open my events" calls, and again AFTER any events_add or events_delete (pass a short notice like "Added: Dentist ✓") so the app reflects the change.
3. Adding: events_add with title, ISO startsAt, recurrence (none|daily|weekly|monthly) and byDay weekday numbers (0=Sunday) for weekly events. "every weekday" = byDay [1,2,3,4,5].
4. "What's next" / "what's coming up": events_next, then answer with the soonest occurrence(s) in compressed speech ("Dentist tomorrow at 3 PM, then standup Monday at 9:30").
5. If the user gives an event with no time, ask ONE follow-up question for the time.
6. This agent is NOT the user's work calendar (Google Calendar has its own agents) — it manages the personal events list in the events app only.

Response style: compressed speech. Data first, no filler.`;

const EVENT_AGENT_DESCRIPTION =
  'Manages personal events and appointments (one-off and recurring) in the Manage Events app: opens the app in a modal, adds events, answers "what\'s next". Shared graph store, watch-ready.';

/**
 * Build the full agent config (without id/type/version -- store owns those).
 */
function buildEventAgentConfig() {
  return {
    name: EVENT_AGENT_NAME,
    description: EVENT_AGENT_DESCRIPTION,
    prompt: EVENT_AGENT_PROMPT,
    keywords: [...EVENT_AGENT_KEYWORDS],
    categories: ['productivity', 'events', 'scheduling'],
    executionType: 'llm',
    tools: [...EVENT_AGENT_TOOLS],
    multiTurn: true,
    enabled: true,
  };
}

/**
 * Ensure the agent exists with a playbook. Never throws.
 *
 * @param {Object} [deps] - { getStore, playbookLib } test seam
 * @returns {Promise<{ status: 'created'|'patched'|'exists'|'unavailable'|'error', agentId?: string }>}
 */
async function ensureEventManagerAgent(deps = {}) {
  try {
    const store = deps.getStore
      ? deps.getStore()
      : (() => {
          const { getAgentStore } = require('../../src/voice-task-sdk/agent-store');
          return getAgentStore();
        })();
    if (!store) return { status: 'unavailable' };
    if (typeof store.init === 'function') await store.init();

    const playbookLib = deps.playbookLib || require('../agent-playbook');

    const existing = (store.getLocalAgents() || []).find(
      (a) => String(a.name || '').toLowerCase() === EVENT_AGENT_NAME.toLowerCase()
    );

    // Compose the playbook from the SAME local-agent template all builds use.
    const config = buildEventAgentConfig();
    const composePlaybook = () => {
      const composed = playbookLib.composeLocalAgentPlaybook({
        request: 'Manage my appointments and events: open the events app in a modal, add one-off and recurring events, and answer "what\'s next".',
        config,
      });
      const saveOutcome = playbookLib.saveAgentPlaybook(composed.markdown, {
        title: composed.title,
        agentName: EVENT_AGENT_NAME,
        request: 'manage events / appointments (voice + modal app + watch)',
      });
      return { markdown: composed.markdown, title: composed.title, ref: saveOutcome.ref || null };
    };

    if (!existing) {
      const playbook = composePlaybook();
      const agent = await store.createAgent({ ...config, playbook });
      log.info('events', 'Seeded Event Manager local agent (playbook-backed)', { agentId: agent.id });
      return { status: 'created', agentId: agent.id };
    }

    // Patch older definitions missing the playbook or the tool bindings.
    const missingPlaybook = !existing.playbook || !existing.playbook.markdown;
    const missingTools =
      !Array.isArray(existing.tools) ||
      EVENT_AGENT_TOOLS.some((t) => !existing.tools.includes(t));
    if (missingPlaybook || missingTools) {
      const updates = {};
      if (missingPlaybook) updates.playbook = composePlaybook();
      if (missingTools) updates.tools = [...EVENT_AGENT_TOOLS];
      const updated = await store.updateAgent(existing.id, updates, 'update', 'ensure-event-agent: playbook/tools patch');
      log.info('events', 'Patched Event Manager agent', {
        agentId: existing.id,
        patched: Object.keys(updates).join(','),
      });
      return { status: 'patched', agentId: updated.id };
    }

    return { status: 'exists', agentId: existing.id };
  } catch (err) {
    log.warn('events', 'ensureEventManagerAgent failed (non-fatal)', { error: err.message });
    return { status: 'error' };
  }
}

module.exports = {
  ensureEventManagerAgent,
  buildEventAgentConfig,
  EVENT_AGENT_NAME,
  EVENT_AGENT_TOOLS,
  EVENT_AGENT_KEYWORDS,
};
