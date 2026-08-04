/**
 * Agent Playbook - the LOCAL AGENT TEMPLATE and its lifecycle.
 *
 * Every agent build (system-offered via capability-gap/self-heal, or ad-hoc
 * "build me an agent") now produces a PLAYBOOK first, and the local agent is
 * generated FROM the playbook -- the playbook is the durable spec, the agent
 * is the artifact. This mirrors the plan->generate pipeline but makes the
 * intermediate spec a first-class, user-visible document that:
 *
 *   - is saved to the "Agent Playbooks" space in Spaces
 *   - is opened in WISER Playbooks (as a new playbook) at build time
 *   - is stored on the agent config (`playbook.markdown` + `playbook.ref`)
 *     so rebuilds and self-heal regenerate from the SPEC, not from a lossy
 *     one-line description
 *
 * Pure composition + deps-injectable side effects (Spaces save, WISER open):
 * vitest CJS mocks don't reliably intercept requires here, so every function
 * that touches a singleton accepts a deps override.
 */

'use strict';

const { getLogQueue } = require('./log-event-queue');
const log = getLogQueue();

// The canonical section order of the local agent template. Tests and the
// generator both key off these headings; keep them stable.
const LOCAL_AGENT_TEMPLATE_SECTIONS = Object.freeze([
  'Goal',
  'Voice Triggers',
  'Behavior',
  'Tools & Data',
  'LLM Prompt',
  'UI / Modal',
  'Verification',
  'Maintenance & Self-Heal',
]);

/**
 * Compose a local-agent playbook (Markdown) from a build request.
 * Deterministic -- never throws, never calls an LLM. The plan (when the
 * Claude Code planning stage produced one) enriches the sections.
 *
 * @param {Object} input
 * @param {string} input.request      - the user's original request
 * @param {Object} [input.plan]       - planAgent output (understanding, features, approach, suggestedName)
 * @param {Object} [input.assessment] - feasibility assessment (effort, reasoning, requiredIntegrations)
 * @param {Object} [input.config]     - known agent config (name, keywords, tools, prompt) when pre-decided
 * @returns {{ markdown: string, title: string, agentName: string }}
 */
function composeLocalAgentPlaybook({ request = '', plan = null, assessment = null, config = null } = {}) {
  const agentName =
    (config && config.name) ||
    (plan && plan.suggestedName) ||
    'New Local Agent';
  const title = `Local Agent Playbook: ${agentName}`;

  const keywords = (config && config.keywords) || [];
  const tools = (config && config.tools) || [];
  const features = (plan && Array.isArray(plan.features) && plan.features) || [];
  const integrations = (assessment && assessment.requiredIntegrations) || [];

  const lines = [
    `# ${title}`,
    '',
    `> Template: local-agent v1 | Request: "${request.slice(0, 300)}"`,
    '',
    '## Goal',
    (plan && plan.understanding) || `Build a local voice-orb agent that handles: ${request}`,
    '',
    '## Voice Triggers',
    keywords.length
      ? keywords.map((k) => `- "${k}"`).join('\n')
      : '- Derive trigger keywords from the request; the unified LLM bidder does the rest.',
    '',
    '## Behavior',
    features.length
      ? features.map((f, i) => `${i + 1}. ${f}`).join('\n')
      : `1. Fulfill the request end-to-end in one turn where possible.\n2. Ask a follow-up (needsInput) only when a required detail is missing.`,
    '',
    '## Tools & Data',
    [
      tools.length ? `Tools: ${tools.join(', ')}` : 'Tools: none (pure LLM agent).',
      integrations.length ? `Integrations: ${integrations.join(', ')}` : null,
      (plan && plan.approach) ? `Approach: ${plan.approach}` : null,
    ].filter(Boolean).join('\n'),
    '',
    '## LLM Prompt',
    (config && config.prompt)
      ? '```\n' + config.prompt + '\n```'
      : 'Draft a system prompt that states the agent role, the tools it must call, and the response style (compressed speech for voice).',
    '',
    '## UI / Modal',
    'If the agent has a visual surface, open it with displayMode: modal and explicit panel sizes; voice answers must still stand alone.',
    '',
    '## Verification',
    [
      '1. Post-build self-test: execute the original request through the built agent (live-tested / config-pending-restart / failed).',
      '2. Voice test: say a trigger phrase and confirm the auction routes here.',
      '3. If the agent has UI, confirm the modal opens.',
    ].join('\n'),
    '',
    '## Maintenance & Self-Heal',
    [
      '- This playbook is the rebuild spec: self-heal rebuilds regenerate the agent FROM this document.',
      '- Feature-adds update this playbook first, then the agent.',
      `- Broken-agent events (agent:contract-violation / agent:hot-connect-refused) trigger a proactive rebuild offer.`,
    ].join('\n'),
    '',
  ];

  return { markdown: lines.join('\n'), title, agentName };
}

/**
 * Save a playbook to the "Agent Playbooks" space in Spaces.
 * Best-effort: returns { saved: false, error } instead of throwing, because
 * a build must not die on a storage hiccup (the markdown still rides on the
 * agent config).
 *
 * @param {string} markdown
 * @param {Object} meta - { title, agentName, request }
 * @param {Object} [deps] - { getSpacesStorage } test seam
 * @returns {{ saved: boolean, ref: {itemId: string|null, spaceId: string}|null, error?: string }}
 */
const AGENT_PLAYBOOKS_SPACE_ID = 'agent-playbooks';

function saveAgentPlaybook(markdown, meta = {}, deps = {}) {
  try {
    const storage = deps.getSpacesStorage
      ? deps.getSpacesStorage()
      : (() => {
          const { getSpacesAPI } = require('../spaces-api');
          const spacesApi = getSpacesAPI();
          return spacesApi.storage || spacesApi._storage || null;
        })();

    if (!storage) {
      return { saved: false, ref: null, error: 'Spaces storage unavailable' };
    }

    const spaces = storage.index?.spaces || [];
    if (!spaces.find((s) => s.id === AGENT_PLAYBOOKS_SPACE_ID)) {
      storage.createSpace({
        id: AGENT_PLAYBOOKS_SPACE_ID,
        name: 'Agent Playbooks',
        icon: '▶',
        color: '#8b5cf6',
        isSystem: true,
      });
    }

    const item = storage.addItem({
      type: 'text',
      content: markdown,
      spaceId: AGENT_PLAYBOOKS_SPACE_ID,
      timestamp: Date.now(),
      metadata: {
        title: meta.title || 'Local Agent Playbook',
        itemType: 'agent-playbook',
        agentName: meta.agentName || null,
        request: meta.request || null,
      },
    });

    log.info('agent-playbook', 'Saved local-agent playbook to Spaces', {
      title: meta.title,
      itemId: item?.id || null,
    });

    return { saved: true, ref: { itemId: item?.id || null, spaceId: AGENT_PLAYBOOKS_SPACE_ID } };
  } catch (err) {
    log.warn('agent-playbook', 'Could not save playbook to Spaces', { error: err.message });
    return { saved: false, ref: null, error: err.message };
  }
}

/**
 * Open WISER Playbooks with this playbook prefilled as a NEW playbook
 * (deep-link ?prompt=...&autoSubmit=true). Best-effort, never throws.
 *
 * @param {string} markdown
 * @param {Object} [deps] - { getWebTools, openWebTool } test seam
 * @returns {boolean} true when the tool was opened
 */
function openPlaybookInWiser(markdown, deps = {}) {
  try {
    const getWebTools =
      deps.getWebTools ||
      (() => (global.moduleManager ? global.moduleManager.getWebTools() : []));
    const openWebTool =
      deps.openWebTool ||
      ((toolId, opts) => global.moduleManager && global.moduleManager.openWebTool(toolId, opts));

    const tools = getWebTools() || [];
    const toolInfo = tools.find((t) => /playbook/i.test(t.name));
    if (!toolInfo) return false;

    const params = new URLSearchParams();
    params.set('prompt', markdown);
    params.set('autoSubmit', 'true');
    openWebTool(toolInfo.id, { url: `${toolInfo.url}?${params.toString()}` });
    log.info('agent-playbook', 'Opened playbook in WISER Playbooks', { tool: toolInfo.name });
    return true;
  } catch (err) {
    log.warn('agent-playbook', 'Could not open WISER Playbooks', { error: err.message });
    return false;
  }
}

module.exports = {
  LOCAL_AGENT_TEMPLATE_SECTIONS,
  AGENT_PLAYBOOKS_SPACE_ID,
  composeLocalAgentPlaybook,
  saveAgentPlaybook,
  openPlaybookInWiser,
};
