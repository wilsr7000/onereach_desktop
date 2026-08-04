/**
 * Ensure the "Meeting Starter" local agent exists - the easier-than-Zoom
 * meeting flow, seeded through the playbook-backed pipeline (same pattern
 * as lib/events/ensure-event-agent.js): playbook from the local-agent
 * template, saved to Spaces, stored on the agent config for self-heal.
 *
 * Idempotent: creates when missing, patches playbook/tools on older
 * definitions, otherwise no-op. Never throws.
 */

'use strict';

const { getLogQueue } = require('../log-event-queue');
const log = getLogQueue();

const MEETING_AGENT_NAME = 'Meeting Starter';

const MEETING_AGENT_TOOLS = Object.freeze([
  'meeting_open_setup',
  'meeting_suggest_participants',
  'meeting_update',
  'meeting_start',
]);

const MEETING_AGENT_KEYWORDS = Object.freeze([
  'start a meeting',
  'start a meeting with',
  'meeting with',
  'organize a meeting',
  'set up a meeting',
  'setup a meeting',
  'new meeting',
  'get everyone together',
  'invite to a meeting',
  'meeting participants',
  'who should join',
  'start a call with',
  'huddle with',
]);

const MEETING_AGENT_PROMPT = `You are Meeting Starter — the fastest way to get people into a meeting; easier than Zoom. Meetings run in WISER Meeting and live in a Space; participants are suggested from the user's graph.

RULES:
1. ALWAYS call meeting_open_setup when invoked, so the Start-a-Meeting modal pops open — and again after EVERY draft change (pass a short notice like "Added Erika ✓").
2. Build the draft with meeting_update: title, target Space, add/remove participants. Names the user says ("with Erika and Jonas") go straight into add.
3. Suggest people: meeting_suggest_participants gives the invite candidates; offer the top few by voice ("Erika, Jonas, or Alex?") — the modal shows them as one-tap chips.
4. "Start it" / "start the meeting now" → meeting_start. Report the outcome honestly: meeting window opened in Space X with N participants; the join link is shared from the meeting window itself.
5. If the user names a Space that doesn't exist, meeting_start creates it — say so.
6. You ORGANIZE and START meetings. Plain recording ("record my screen", "record a video") belongs to the Video Recorder agent — low confidence there.

Response style: compressed speech. Data first, no filler.`;

const MEETING_AGENT_DESCRIPTION =
  'Starts meetings the easy way: pops a setup modal, suggests participants from the graph, organizes the invite list by voice or click, and launches the meeting in a Space (WISER Meeting).';

function buildMeetingAgentConfig() {
  return {
    name: MEETING_AGENT_NAME,
    description: MEETING_AGENT_DESCRIPTION,
    prompt: MEETING_AGENT_PROMPT,
    keywords: [...MEETING_AGENT_KEYWORDS],
    categories: ['productivity', 'meetings', 'collaboration'],
    executionType: 'llm',
    tools: [...MEETING_AGENT_TOOLS],
    multiTurn: true,
    enabled: true,
  };
}

/**
 * @param {Object} [deps] - { getStore, playbookLib } test seam
 * @returns {Promise<{ status: 'created'|'patched'|'exists'|'unavailable'|'error', agentId?: string }>}
 */
async function ensureMeetingStarterAgent(deps = {}) {
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
    const config = buildMeetingAgentConfig();

    const composePlaybook = () => {
      const composed = playbookLib.composeLocalAgentPlaybook({
        request:
          'Start meetings more easily than Zoom: open a setup modal, suggest participants from the graph, organize the invite list, and start the meeting in a Space.',
        config,
      });
      const saveOutcome = playbookLib.saveAgentPlaybook(composed.markdown, {
        title: composed.title,
        agentName: MEETING_AGENT_NAME,
        request: 'start meetings with suggested participants in a Space',
      });
      return { markdown: composed.markdown, title: composed.title, ref: saveOutcome.ref || null };
    };

    const existing = (store.getLocalAgents() || []).find(
      (a) => String(a.name || '').toLowerCase() === MEETING_AGENT_NAME.toLowerCase()
    );

    if (!existing) {
      const playbook = composePlaybook();
      const agent = await store.createAgent({ ...config, playbook });
      log.info('meetings', 'Seeded Meeting Starter local agent (playbook-backed)', { agentId: agent.id });
      return { status: 'created', agentId: agent.id };
    }

    const missingPlaybook = !existing.playbook || !existing.playbook.markdown;
    const missingTools =
      !Array.isArray(existing.tools) || MEETING_AGENT_TOOLS.some((t) => !existing.tools.includes(t));
    if (missingPlaybook || missingTools) {
      const updates = {};
      if (missingPlaybook) updates.playbook = composePlaybook();
      if (missingTools) updates.tools = [...MEETING_AGENT_TOOLS];
      const updated = await store.updateAgent(existing.id, updates, 'update', 'ensure-meeting-agent: playbook/tools patch');
      log.info('meetings', 'Patched Meeting Starter agent', {
        agentId: existing.id,
        patched: Object.keys(updates).join(','),
      });
      return { status: 'patched', agentId: updated.id };
    }

    return { status: 'exists', agentId: existing.id };
  } catch (err) {
    log.warn('meetings', 'ensureMeetingStarterAgent failed (non-fatal)', { error: err.message });
    return { status: 'error' };
  }
}

module.exports = {
  ensureMeetingStarterAgent,
  buildMeetingAgentConfig,
  MEETING_AGENT_NAME,
  MEETING_AGENT_TOOLS,
  MEETING_AGENT_KEYWORDS,
};
