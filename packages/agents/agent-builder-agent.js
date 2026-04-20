/**
 * Agent Builder Agent
 *
 * Conversational agent that helps users build new agents when the orb can't
 * handle a request. Participates in normal LLM bidding for "build me an agent"
 * requests, and also serves as the fallback when the exchange detects a
 * capability gap.
 *
 * When the user asks for something no agent can handle and the request looks
 * feasible (`easy` or `medium`), this agent offers to build the new agent
 * RIGHT NOW using the bundled Claude Code CLI (see
 * `lib/claude-code-agent-builder.js`). For harder requests or when the
 * Claude Code path fails, it falls back to opening WISER Playbooks for a
 * manual build plan.
 */

'use strict';

const BaseAgent = require('./base-agent');
const ai = require('../../lib/ai-service');
const { getLogQueue } = require('../../lib/log-event-queue');
const log = getLogQueue();

const SPACES_API = 'http://127.0.0.1:47291';

// Effort levels for which we offer the in-app Claude Code build path.
// `hard` requests usually benefit from human planning in Playbooks first;
// `not_feasible` we never try.
const CLAUDE_CODE_FEASIBLE_EFFORTS = new Set(['easy', 'medium']);

// Lazy requires so tests can override via setters below.
let _claudeCodeBuilder = null;
let _exchangeBus = null;

function _getClaudeCodeBuilder() {
  if (_claudeCodeBuilder) return _claudeCodeBuilder;
  return require('../../lib/claude-code-agent-builder').buildAgentWithClaudeCode;
}

function _getExchangeBus() {
  if (_exchangeBus) return _exchangeBus;
  try {
    return require('../../lib/exchange/event-bus');
  } catch {
    return null;
  }
}

/**
 * Test-only: inject a fake Claude Code builder. Pass null to reset.
 * @param {Function|null} fn
 */
function _setClaudeCodeBuilder(fn) {
  _claudeCodeBuilder = fn || null;
}

/**
 * Test-only: inject a fake exchange bus. Pass null to reset.
 * @param {Object|null} bus
 */
function _setExchangeBus(bus) {
  _exchangeBus = bus || null;
}

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

    // Check if this is a follow-up confirmation from a previous feasibility assessment.
    // Three possible responses:
    //   affirmative -> proceed with the currently-pending buildMethod
    //   playbook    -> user prefers drafting in Playbooks instead of Claude Code
    //   negative    -> user declines, we bow out politely
    if (task.context?.pendingBuild) {
      const lower = content.toLowerCase();
      const isNegative = /^(no|nope|not now|cancel|forget it|skip it|never mind|nah)\b/i.test(lower);
      const prefersPlaybooks = /\b(playbook|playbooks|draft|step by step|plan it out|not now)\b/i.test(lower);
      const isAffirmative = /^(yes|yeah|yep|sure|go ahead|do it|let's do it|ok|okay|please|build it|draft it|start|go for it)/i.test(lower);

      if (isNegative) {
        return {
          success: true,
          message: "OK, no worries. Let me know if you want to try again.",
        };
      }
      if (prefersPlaybooks) {
        return this._handleConfirmation({ ...task.context.pendingBuild, buildMethod: 'playbook' });
      }
      if (isAffirmative) {
        return this._handleConfirmation(task.context.pendingBuild);
      }
      // Ambiguous follow-up -- fall through to a fresh feasibility pass on the
      // new content (user probably moved on to a different request).
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

    const buildMethod = this._chooseBuildMethod(assessment);

    // Rich HUD card that lets the user click Build / Playbook / Not now
    // instead of (or in addition to) replying by voice. The existing
    // delegated data-value click handler in command-hud.html routes the
    // value back through submitTask with metadata.targetAgentId set, so
    // a click reaches this same agent's pending-input handler.
    const ui = {
      type: 'buildProposal',
      request: originalRequest,
      effort: assessment.effort,
      reasoning: assessment.reasoning || '',
      estimatedCostPerUse: assessment.estimatedCostPerUse,
      requiredIntegrations: assessment.requiredIntegrations || [],
      missingAccess: assessment.missingAccess || [],
      buildMethod,
      alternativeSuggestion: assessment.alternativeSuggestion,
      message: response,
    };

    return {
      success: true,
      message: response,
      ui,
      // Keep voice path alive so users can also say yes/playbook/no.
      // The command-HUD panel will render `ui` above; the orb will
      // continue listening for the spoken response.
      needsInput: {
        prompt: response,
        agentId: this.id,
        context: {
          pendingBuild: {
            originalRequest,
            assessment,
            buildMethod,
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
   * Pick the build method to offer: 'claude-code' for easy/medium requests
   * (we can build it in ~30s using the bundled CLI), 'playbook' otherwise.
   * @param {Object} assessment
   * @returns {'claude-code' | 'playbook' | 'none'}
   */
  _chooseBuildMethod(assessment) {
    if (assessment.effort === 'not_feasible') return 'none';
    if (CLAUDE_CODE_FEASIBLE_EFFORTS.has(assessment.effort)) return 'claude-code';
    return 'playbook';
  },

  /**
   * Build a natural conversational response based on the assessment.
   * For feasible requests we offer to build NOW with Claude Code; for harder
   * requests we offer Playbooks as before.
   */
  _buildConversationalResponse(assessment, request) {
    const method = this._chooseBuildMethod(assessment);

    // not_feasible: explain why, offer alternative, don't prompt to build
    if (method === 'none') {
      const alt = assessment.alternativeSuggestion
        ? ` Here's what we could do instead: ${assessment.alternativeSuggestion}.`
        : ' Let me know if you want to explore a different approach.';
      return `That would be really tough with what we have right now. ${assessment.reasoning}${alt}`;
    }

    // Prefer the LLM's spoken response if it's good -- but append the right
    // call-to-action (Claude Code now vs Playbooks draft) for the chosen method.
    if (assessment.spokenResponse && assessment.spokenResponse.length > 20) {
      const resp = assessment.spokenResponse.trim();
      const alreadyAsksToBuild = /playbook|draft|build it now|should i build|want me to build|create it now/i.test(resp);
      if (alreadyAsksToBuild) return resp;
      if (method === 'claude-code') {
        return resp + ' Want me to build it right now? It\'ll take about 30 seconds.';
      }
      return resp + ' Want me to open WISER Playbooks and start drafting it?';
    }

    // Fallback templates keyed on effort + method
    const shortRequest = request.length > 50 ? request.slice(0, 50) + '...' : request;

    if (method === 'claude-code') {
      switch (assessment.effort) {
        case 'easy': {
          const integrations = assessment.requiredIntegrations.length
            ? `, using ${assessment.requiredIntegrations.join(' and ')}`
            : '';
          return `Good news -- that's actually a straightforward one to build${integrations}. About ${assessment.estimatedCostPerUse} per use. Want me to build it right now? (About 30 seconds. Or say "playbook" to plan it first.)`;
        }
        case 'medium': {
          const similar = assessment.similarAgent
            ? ` It's similar to the ${assessment.similarAgent}, so we have a good starting point.`
            : '';
          const needs = assessment.missingAccess.length
            ? ` Heads-up: you'd need ${assessment.missingAccess.join(', ')} for it to actually work.`
            : '';
          return `That's definitely doable.${similar}${needs} About ${assessment.estimatedCostPerUse} per use. Want me to build it right now? (Or say "playbook" to plan it first.)`;
        }
        default:
          return `I think I can build that for you. Want me to create the agent right now?`;
      }
    }

    // Playbook fallback (effort === 'hard')
    switch (assessment.effort) {
      case 'hard': {
        const missing = assessment.missingAccess.length
          ? ` and it needs ${assessment.missingAccess.join(', ')} which we'd need to set up`
          : '';
        return `That's a bigger project -- it involves ${assessment.requiredIntegrations.join(', ') || 'some complex orchestration'}${missing}. Let me create a detailed build playbook so we can tackle it piece by piece. Want me to open WISER Playbooks?`;
      }
      default:
        return `I can look into building that for you. Want me to open WISER Playbooks and start drafting a plan for "${shortRequest}"?`;
    }
  },

  /**
   * Handle user confirmation. Routes to either the in-app Claude Code build
   * path or the Playbooks-draft path based on which offer was made.
   */
  async _handleConfirmation(pendingBuild) {
    const { buildMethod } = pendingBuild;

    if (buildMethod === 'claude-code') {
      return this._buildWithClaudeCode(pendingBuild);
    }
    return this._buildWithPlaybooks(pendingBuild);
  },

  /**
   * Broadcast a build-progress event via the exchange event bus so the
   * orb (and any other listeners) can surface the current stage in its HUD.
   * @private
   */
  _emitBuildProgress(event) {
    try {
      const bus = _getExchangeBus();
      if (bus && typeof bus.emit === 'function') {
        bus.emit('agent-builder:progress', event);
      }
    } catch (_e) {
      // Progress events are advisory -- never block a build on telemetry.
    }
  },

  /**
   * Build the agent in-app using the bundled Claude Code CLI.
   * Falls back to the Playbooks flow if the build fails for any reason.
   * Emits `agent-builder:progress` events throughout so the orb can show status.
   */
  async _buildWithClaudeCode(pendingBuild) {
    const { originalRequest, assessment } = pendingBuild;

    log.info('agent-builder', 'Building agent with Claude Code', {
      request: originalRequest.slice(0, 120),
      effort: assessment.effort,
    });

    let build;
    try {
      const builder = _getClaudeCodeBuilder();
      build = await builder(originalRequest, {
        onProgress: (evt) => this._emitBuildProgress({ ...evt, originalRequest }),
        generatorOptions: {
          // Let the generator choose an appropriate template based on capabilities
        },
      });
    } catch (err) {
      log.warn('agent-builder', 'Claude Code build threw; falling back to Playbooks', {
        error: err.message,
      });
      return this._buildWithPlaybooks(pendingBuild);
    }

    if (!build.success) {
      // Budget-blocked builds are a distinct failure we surface plainly
      if (build.budgetBlocked) {
        log.warn('agent-builder', 'Claude Code build refused by budget precheck', {
          reason: build.error,
        });
        return {
          success: true,
          message:
            `I can't build that right now -- we're close to the daily budget cap. ` +
            `Want me to draft a plan in WISER Playbooks instead (no cost)?`,
          needsInput: {
            prompt: 'Would you like to try Playbooks instead?',
            agentId: this.id,
            context: {
              pendingBuild: { ...pendingBuild, buildMethod: 'playbook' },
            },
          },
        };
      }

      log.warn('agent-builder', 'Claude Code build failed; offering Playbooks fallback', {
        stage: build.stage,
        error: build.error,
      });
      return {
        success: true,
        message:
          `I tried to build it directly but hit a snag (${build.error || 'unknown error'}). ` +
          `Want me to open WISER Playbooks instead so we can work through it step by step?`,
        needsInput: {
          prompt: 'Would you like to try Playbooks instead?',
          agentId: this.id,
          context: {
            pendingBuild: { ...pendingBuild, buildMethod: 'playbook' },
          },
        },
      };
    }

    const agentName = (build.agent && (build.agent.name || build.agent.displayName)) || 'new agent';
    const elapsedSec = Math.max(1, Math.round((build.elapsedMs || 0) / 1000));

    // Auto-retry the original request. The new agent is already registered
    // with the exchange (via agent-store's `agent:hot-connect` event) so it
    // can bid on the re-submitted task. The `retriedAfterBuild` flag
    // prevents an infinite build->retry->build loop if the new agent still
    // can't handle it.
    let retryScheduled = false;
    try {
      const bus = _getExchangeBus();
      if (bus && typeof bus.processSubmit === 'function') {
        // Fire-and-forget -- don't block the "Done" message on the re-run
        Promise.resolve(
          bus.processSubmit(originalRequest, {
            toolId: 'orb',
            skipFilter: true,
            metadata: {
              retriedAfterBuild: true,
              builtAgentId: build.agent && build.agent.id,
            },
          })
        ).catch((err) => {
          log.warn('agent-builder', 'Auto-retry after build failed', { error: err.message });
        });
        retryScheduled = true;
      }
    } catch (err) {
      log.warn('agent-builder', 'Could not schedule auto-retry', { error: err.message });
    }

    const followUp = retryScheduled
      ? 'Running your original request now...'
      : 'Try your original request again and it should pick up.';

    return {
      success: true,
      message:
        `Done. I built "${agentName}" in about ${elapsedSec} second${elapsedSec === 1 ? '' : 's'}. ` +
        followUp,
    };
  },

  /**
   * Open WISER Playbooks with the build context (original flow).
   */
  async _buildWithPlaybooks(pendingBuild) {
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
    const a = assessment || {};
    const parts = [
      `Build an agent for: "${request}"`,
      '',
      `Effort: ${a.effort || 'unknown'}`,
      `Reasoning: ${a.reasoning || ''}`,
      `Estimated cost per use: ${a.estimatedCostPerUse || '~$0.01'}`,
    ];

    const required = Array.isArray(a.requiredIntegrations) ? a.requiredIntegrations : [];
    const missing = Array.isArray(a.missingAccess) ? a.missingAccess : [];

    if (required.length) {
      parts.push(`Required integrations: ${required.join(', ')}`);
    }
    if (missing.length) {
      parts.push(`Needs setup: ${missing.join(', ')}`);
    }
    if (a.similarAgent) {
      parts.push(`Similar to: ${a.similarAgent} (use as reference)`);
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

// Test-only helpers for injecting mock dependencies. Accessed via
// `require('./agent-builder-agent')._setClaudeCodeBuilder(fn)` etc.
module.exports._setClaudeCodeBuilder = _setClaudeCodeBuilder;
module.exports._setExchangeBus = _setExchangeBus;
