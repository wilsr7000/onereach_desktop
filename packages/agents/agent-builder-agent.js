/**
 * Agent Builder Agent
 *
 * Conversational agent that helps users build new agents when the orb can't
 * handle a request. Participates in normal LLM bidding for "build me an agent"
 * requests, and also serves as the fallback when the exchange detects a
 * capability gap.
 *
 * Instead of a robotic "I can't do that" message, this agent has a real
 * conversation about feasibility, effort, required integrations, and then
 * offers to open WISER Playbooks to draft the agent.
 */

'use strict';

const BaseAgent = require('./base-agent');
const ai = require('../../lib/ai-service');
const { getLogQueue } = require('../../lib/log-event-queue');
const log = getLogQueue();

const SPACES_API = 'http://127.0.0.1:47291';

// System context passed to the feasibility LLM call so it can make
// realistic assessments about what's easy/hard to build.
const SYSTEM_CONTEXT = {
  tools: [
    'shell_exec -- run system commands (macOS)',
    'file_read / file_write -- local file access',
    'web_search -- real-time web search via API',
    'spaces_search / spaces_add_item -- content storage (Spaces API)',
    'get_current_time -- system clock',
    'screen_capture -- screenshot current screen',
    'file_convert -- convert between file formats',
  ],
  aiProfiles: [
    'fast (Haiku ~$0.0002/call) -- classification, routing, quick answers',
    'standard (Sonnet ~$0.003/call) -- general reasoning, composition',
    'powerful (Opus ~$0.02/call) -- deep multi-step reasoning',
    'vision (Sonnet) -- image/screenshot analysis',
    'embedding (~$0.00002/call) -- semantic search',
    'transcription (whisper-1 ~$0.006/min) -- audio-to-text',
  ],
  integrations: [
    'Google Calendar API (calendar-data.js)',
    'Email (mailto: via shell)',
    'Browser automation (Playwright)',
    'Native Electron BrowserWindow for web browsing',
    'ElevenLabs TTS + sound generation',
    'Spaces storage (clipboard-storage-v2)',
    'Voice pipeline (speech recognition, TTS, voice orb)',
    'File conversion (lib/convert-service.js)',
    'Screen capture (lib/screen-service.js)',
    'Edison KV store (key-value persistence)',
  ],
};

module.exports = BaseAgent.create({
  id: 'agent-builder-agent',
  name: 'Agent Builder',
  description:
    'Evaluates whether a new agent can be built for a user request, assesses feasibility and required integrations, and offers to draft a build plan in WISER Playbooks. Handles capability-gap fallbacks conversationally.',
  voice: 'sage',
  acks: ['Let me think about that.', 'Interesting idea, let me assess.'],
  categories: ['system', 'building', 'planning'],
  keywords: [
    'build agent',
    'create agent',
    'make agent',
    'new agent',
    'agent for',
    'build that',
    'build it',
    'can you build',
    'is it possible',
    'make a bot',
    'build a bot',
    'automate',
  ],
  executionType: 'action',
  estimatedExecutionMs: 6000,
  multiTurn: true,

  memoryConfig: { displayName: 'Agent Builder' },

  prompt: `Agent Builder helps users create new agents for the voice assistant.

Capabilities:
- Assess feasibility of building a new agent based on available tools and integrations
- Explain effort level, required APIs/permissions, and estimated cost
- Open WISER Playbooks to draft a step-by-step build plan
- Conversationally guide users through what's needed

Use this agent when:
- The user explicitly asks to build, create, or make an agent/bot/assistant
- The user asks "can you do X" and the answer requires building something new
- A capability gap was detected and the user needs guidance on what's possible

This agent does NOT execute playbooks or generate agent code directly -- it assesses feasibility and launches WISER Playbooks for the actual build process.

LOW confidence when: the user is asking an existing agent to do its job (play music, check calendar, send email). Those are handled by dedicated agents.`,

  async onExecute(task, { memory, log: agentLog }) {
    const content = (task.content || task.text || task.query || '').trim();
    if (!content) {
      return {
        success: true,
        message: "What kind of agent would you like to build? Describe what it should do and I'll tell you how feasible it is.",
      };
    }

    // Check if this is a follow-up confirmation from a previous feasibility assessment
    const lower = content.toLowerCase();
    const isConfirmation = /^(yes|yeah|yep|sure|go ahead|do it|let's do it|ok|okay|please|build it|draft it|start|go for it)/i.test(lower);

    if (isConfirmation && task.context?.pendingBuild) {
      return this._handleConfirmation(task.context.pendingBuild);
    }

    // Check if this is a capability-gap fallback (injected by exchange-bridge)
    const gapContext = task.metadata?.capabilityGap || null;
    const originalRequest = task.metadata?.originalRequest || content;

    // Run feasibility assessment
    const assessment = await this._assessFeasibility(originalRequest, gapContext);

    // Build a conversational response based on effort level
    const response = this._buildConversationalResponse(assessment, originalRequest);

    // Remember this assessment for follow-up
    if (memory) {
      try {
        await memory.load();
        const historySection = memory.getSection('Build History') || '';
        const entry = `[${new Date().toLocaleDateString()}] "${originalRequest.slice(0, 60)}" -- ${assessment.effort} effort`;
        memory.setSection('Build History', (historySection + '\n' + entry).trim().split('\n').slice(-20).join('\n'));
        await memory.save();
      } catch (_e) { /* non-fatal */ }
    }

    return {
      success: true,
      message: response,
      needsInput: {
        prompt: response,
        agentId: this.id,
        context: {
          pendingBuild: {
            originalRequest,
            assessment,
          },
        },
      },
    };
  },

  /**
   * Assess feasibility of building an agent for the given request.
   */
  async _assessFeasibility(request, gapContext) {
    const toolList = SYSTEM_CONTEXT.tools.join('\n    ');
    const aiList = SYSTEM_CONTEXT.aiProfiles.join('\n    ');
    const integrationList = SYSTEM_CONTEXT.integrations.join('\n    ');

    // Get existing agents for context
    let existingAgents = '';
    try {
      const { getAllAgents } = require('./agent-registry');
      const agents = getAllAgents().filter((a) => !a.bidExcluded);
      existingAgents = agents.map((a) => `- ${a.name}: ${a.description}`).join('\n');
    } catch (_e) { /* non-fatal */ }

    const gapNote = gapContext
      ? `\nNote: This request was already evaluated by the agent routing system and no existing agent could handle it. The identified gap: "${gapContext}"`
      : '';

    try {
      const result = await ai.json(
        `A user wants to build a voice agent for: "${request}"
${gapNote}

EXISTING AGENTS:
${existingAgents}

AVAILABLE TOOLS:
    ${toolList}

AI PROFILES (per-call cost):
    ${aiList}

AVAILABLE INTEGRATIONS:
    ${integrationList}

Assess the feasibility of building this agent. Return JSON:
{
  "effort": "easy" | "medium" | "hard" | "not_feasible",
  "reasoning": "1-2 sentences explaining why this effort level",
  "requiredIntegrations": ["list of integrations needed from the available list"],
  "missingAccess": ["list of external APIs, services, or permissions NOT in the available list that would be needed"],
  "estimatedCostPerUse": "$X.XX",
  "similarAgent": "name of the most similar existing agent, or null",
  "alternativeSuggestion": "if not_feasible, suggest what could be done instead, or null",
  "spokenResponse": "A natural, conversational 2-3 sentence response to the user. Be warm and helpful. If easy, be encouraging. If medium, explain what's needed. If hard, be honest but optimistic. If not feasible, be kind and suggest alternatives. Never say 'capability gap' or 'feasibility assessment' -- talk like a helpful colleague."
}

Effort guide:
- easy: Single LLM call, uses only available tools/integrations, <50 lines. Example: a text formatting agent, a joke agent.
- medium: 1-3 LLM calls, one external integration, 50-200 lines. Needs some setup but all pieces exist. Example: a weather agent, a news summarizer.
- hard: Multiple LLM calls, complex orchestration, external APIs, >200 lines. Example: a browser automation workflow, a multi-step data pipeline.
- not_feasible: Requires capabilities fundamentally outside the system (hardware control, real-time video processing, etc.) or would be unreliable.`,
        { profile: 'standard', temperature: 0.4, maxTokens: 500, feature: 'agent-builder-feasibility' },
      );

      return {
        effort: result.effort || 'medium',
        reasoning: result.reasoning || '',
        requiredIntegrations: result.requiredIntegrations || [],
        missingAccess: result.missingAccess || [],
        estimatedCostPerUse: result.estimatedCostPerUse || '~$0.01',
        similarAgent: result.similarAgent || null,
        alternativeSuggestion: result.alternativeSuggestion || null,
        spokenResponse: result.spokenResponse || null,
      };
    } catch (err) {
      log.warn('agent-builder', 'Feasibility assessment failed', { error: err.message });
      return {
        effort: 'medium',
        reasoning: 'Could not complete full assessment, but the request seems buildable.',
        requiredIntegrations: [],
        missingAccess: [],
        estimatedCostPerUse: '~$0.01',
        similarAgent: null,
        alternativeSuggestion: null,
        spokenResponse: null,
      };
    }
  },

  /**
   * Build a natural conversational response based on the assessment.
   * Falls back to a template if the LLM didn't produce a good spoken response.
   */
  _buildConversationalResponse(assessment, request) {
    // Prefer the LLM's spoken response if it's good
    if (assessment.spokenResponse && assessment.spokenResponse.length > 20) {
      // Append the offer to open Playbooks if not already mentioned
      const resp = assessment.spokenResponse;
      if (!/playbook|plan|draft/i.test(resp)) {
        return resp + ' Want me to open WISER Playbooks and start drafting it?';
      }
      return resp;
    }

    // Fallback templates by effort level
    const shortRequest = request.length > 50 ? request.slice(0, 50) + '...' : request;

    switch (assessment.effort) {
      case 'easy': {
        const integrations = assessment.requiredIntegrations.length
          ? `, using ${assessment.requiredIntegrations.join(' and ')}`
          : '';
        return `Good news -- that's actually a straightforward one to build${integrations}. It would cost about ${assessment.estimatedCostPerUse} per use. Want me to open WISER Playbooks and draft it out?`;
      }

      case 'medium': {
        const needs = assessment.missingAccess.length
          ? ` You'd need access to ${assessment.missingAccess.join(', ')}.`
          : '';
        const similar = assessment.similarAgent
          ? ` It's similar to the ${assessment.similarAgent}, so we have a good starting point.`
          : '';
        return `That's definitely doable.${similar}${needs} About ${assessment.estimatedCostPerUse} per use. Want me to plan it out step by step in WISER Playbooks?`;
      }

      case 'hard': {
        const missing = assessment.missingAccess.length
          ? ` and it needs ${assessment.missingAccess.join(', ')} which we'd need to set up`
          : '';
        return `That's a bigger project -- it involves ${assessment.requiredIntegrations.join(', ') || 'some complex orchestration'}${missing}. But it's doable. Let me create a detailed build playbook so we can tackle it piece by piece. Want me to open WISER Playbooks?`;
      }

      case 'not_feasible': {
        const alt = assessment.alternativeSuggestion
          ? ` Here's what we could do instead: ${assessment.alternativeSuggestion}.`
          : ' Let me know if you want to explore a different approach.';
        return `That would be really tough with what we have right now. ${assessment.reasoning}${alt}`;
      }

      default:
        return `I can look into building that for you. Want me to open WISER Playbooks and start drafting a plan for "${shortRequest}"?`;
    }
  },

  /**
   * Handle user confirmation -- open WISER Playbooks with the build context.
   */
  async _handleConfirmation(pendingBuild) {
    const { originalRequest, assessment } = pendingBuild;

    // Build a rich prompt for WISER Playbooks
    const playbookPrompt = this._buildPlaybookPrompt(originalRequest, assessment);

    // Try to open WISER Playbooks with the prompt
    const opened = await this._openPlaybooks(playbookPrompt);

    if (opened) {
      return {
        success: true,
        message: "Opening WISER Playbooks with the build plan. I've included the feasibility notes, required integrations, and a first draft outline. You can refine it from there.",
      };
    }

    // Fallback: generate and save the playbook to Spaces instead
    try {
      const { _generateAndSavePlaybook } = require('../../lib/hud-api');
      if (_generateAndSavePlaybook) {
        const result = await _generateAndSavePlaybook(originalRequest, {
          effort: assessment.effort,
          effortDescription: assessment.reasoning,
          estimatedCostPerUse: assessment.estimatedCostPerUse,
          integration: assessment.requiredIntegrations.join(', '),
          integrationDetail: '',
          tools: assessment.requiredIntegrations,
          estimatedCalls: {},
        });
        return {
          success: true,
          message: result.message + " WISER Playbooks isn't available right now, but the playbook has been saved to the Capability Wishlist in Spaces.",
        };
      }
    } catch (_e) { /* non-fatal */ }

    return {
      success: true,
      message: `I couldn't open WISER Playbooks right now. Here's what you'd need to build it: ${assessment.reasoning}. The required integrations are: ${assessment.requiredIntegrations.join(', ') || 'standard tools only'}.`,
    };
  },

  /**
   * Build a detailed prompt to pre-fill in WISER Playbooks.
   */
  _buildPlaybookPrompt(request, assessment) {
    const parts = [
      `Build an agent for: "${request}"`,
      '',
      `Effort: ${assessment.effort}`,
      `Reasoning: ${assessment.reasoning}`,
      `Estimated cost per use: ${assessment.estimatedCostPerUse}`,
    ];

    if (assessment.requiredIntegrations.length) {
      parts.push(`Required integrations: ${assessment.requiredIntegrations.join(', ')}`);
    }
    if (assessment.missingAccess.length) {
      parts.push(`Needs setup: ${assessment.missingAccess.join(', ')}`);
    }
    if (assessment.similarAgent) {
      parts.push(`Similar to: ${assessment.similarAgent} (use as reference)`);
    }

    parts.push('');
    parts.push('Please create a step-by-step build playbook with implementation details, the agent prompt, and testing plan.');

    return parts.join('\n');
  },

  /**
   * Open WISER Playbooks with the given prompt pre-filled.
   * Reuses the pattern from playbooks-launch-agent.
   */
  async _openPlaybooks(prompt) {
    // Find the Playbooks web tool
    let toolInfo = null;
    try {
      if (global.moduleManager) {
        const tools = global.moduleManager.getWebTools();
        toolInfo = (tools || []).find((t) => /playbook/i.test(t.name));
      }
    } catch (_e) { /* ignore */ }

    if (!toolInfo) {
      try {
        const tools = await require('electron').ipcMain.handle?.('module:get-web-tools');
        toolInfo = (tools || []).find((t) => /playbook/i.test(t.name));
      } catch (_e) { /* ignore */ }
    }

    if (!toolInfo) return false;

    // AI-match the best Space
    let spaceMatch = null;
    try {
      const resp = await fetch(`${SPACES_API}/api/spaces`);
      if (resp.ok) {
        const spaces = await resp.json();
        if (Array.isArray(spaces) && spaces.length > 0) {
          const spaceList = spaces
            .slice(0, 30)
            .map((s, i) => `${i + 1}. "${s.name || 'Untitled'}" (id: ${s.id})`)
            .join('\n');

          spaceMatch = await ai.json(
            `Given these Spaces and the user's request, pick the best Space.

Spaces:
${spaceList}

Request: "${prompt.slice(0, 200)}"

Return JSON: { "spaceId": "<id or null>", "confidence": <0-1> }`,
            { profile: 'fast', feature: 'agent-builder-space-match' },
          );

          if (!spaceMatch?.spaceId || spaceMatch.confidence < 0.6) {
            spaceMatch = null;
          }
        }
      }
    } catch (_e) { /* non-fatal */ }

    // Build deep-link URL
    const params = new URLSearchParams();
    params.set('prompt', prompt);
    params.set('autoSubmit', 'true');
    if (spaceMatch?.spaceId) {
      params.set('spaceId', spaceMatch.spaceId);
    }
    const deepLink = `${toolInfo.url}?${params.toString()}`;

    // Open the tool
    try {
      if (global.moduleManager) {
        global.moduleManager.openWebTool(toolInfo.id, { url: deepLink });
        return true;
      }
    } catch (_e) { /* ignore */ }

    if (global.mainWindow && !global.mainWindow.isDestroyed()) {
      global.mainWindow.webContents.send('open-in-new-tab', deepLink);
      return true;
    }

    return false;
  },
});
