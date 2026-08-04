/**
 * Agent Suggester - "what agents should I build?"
 *
 * Turns the self-heal/capability-gap machinery from reactive into demand
 * sensing: a menu of suggested agents (modal UI, descriptions + why-you
 * lines + one-click Build) grounded in:
 *   - the user's persistent WORK PROFILE (cross-agent user-profile-store);
 *     when empty, this agent interviews the user (3 questions) and saves
 *     the answers so every future suggestion — and every other agent —
 *     knows what the user does;
 *   - capability-gap events (requests no agent could handle);
 *   - recent orb conversation + chat/conversation items saved in Spaces
 *     (3rd-party chat history).
 *
 * Build buttons submit "build an agent: <name> — <description>" back
 * through the orb, so they ride the normal consent -> playbook -> build
 * pipeline (agent-builder-agent). Users who want to author the playbook
 * themselves say "playbook" at the consent step (WISER opens with the
 * local-agent template) and later "build the agent from my playbook".
 */

'use strict';

const BaseAgent = require('./base-agent');
const ai = require('../../lib/ai-service');
const { getLogQueue } = require('../../lib/log-event-queue');
const log = getLogQueue();
const {
  INTERVIEW_QUESTIONS,
  isWorkProfileEmpty,
  advanceInterview,
  collectSignals,
  buildSuggestionPrompt,
  filterSuggestions,
  renderAgentMenu,
  MENU_PANEL,
} = require('../../lib/agent-suggest');

// Deps seams (vitest CJS mocks don't reliably intercept requires here).
let _deps = null;
function _setTestDeps(deps) {
  _deps = deps || null;
}

function _profile() {
  if (_deps && _deps.getProfile) return _deps.getProfile();
  const { getUserProfile } = require('../../lib/user-profile-store');
  return getUserProfile();
}

function _signalDeps() {
  if (_deps && _deps.signalDeps) return _deps.signalDeps();
  return {
    queryLog: (opts) => log.query(opts),
    getConversation: () => {
      const { getRecentHistory } = require('../../lib/exchange/conversation-history');
      return getRecentHistory();
    },
    searchChats: () => {
      // Chat/conversation items saved into Spaces (3rd-party chat history
      // lands there today; future sources — Slack/MCP imports — extend here).
      try {
        const { getSpacesAPI } = require('../../spaces-api');
        const storage = getSpacesAPI().storage;
        const items = storage?.index?.items || [];
        return items
          .filter((i) => {
            const t = `${i.metadata?.itemType || ''} ${i.metadata?.title || ''}`.toLowerCase();
            return /chat|conversation|thread|transcript/.test(t);
          })
          .slice(-20)
          .map((i) => (i.content || i.metadata?.title || '').slice(0, 160));
      } catch {
        return [];
      }
    },
    listAgents: () => {
      const roster = [];
      try {
        const { getAllAgents } = require('./agent-registry');
        roster.push(...getAllAgents().map((a) => ({ name: a.name, description: a.description })));
      } catch { /* registry optional in tests */ }
      try {
        const { getAgentStore } = require('../../src/voice-task-sdk/agent-store');
        roster.push(...getAgentStore().getLocalAgents().map((a) => ({ name: a.name, description: a.description })));
      } catch { /* store optional */ }
      return roster;
    },
  };
}

function _showMenu(html) {
  if (_deps && _deps.showModal) return _deps.showModal(html);
  const { showAgentUIModal } = require('../../lib/agent-ui-modal-manager');
  showAgentUIModal({
    agentId: 'agent-suggester',
    agentName: 'Agent Suggester',
    html,
    panelWidth: MENU_PANEL.width,
    panelHeight: MENU_PANEL.height,
  });
}

function _ai() {
  return (_deps && _deps.ai) || ai;
}

module.exports = BaseAgent.create({
  id: 'agent-suggester-agent',
  name: 'Agent Suggester',
  description:
    'Suggests new agents worth building for this user: shows a menu with descriptions and one-click Build, grounded in the user\'s work profile, unmet requests (capability gaps), and saved chat history. Interviews the user about their day-to-day work when the profile is empty.',
  voice: 'sage',
  acks: ['Let me look at what would help you most.', 'Thinking about what to build for you.'],
  categories: ['system', 'building', 'planning'],
  keywords: [
    'suggest agents',
    'what agents should i build',
    'what agents do i need',
    'agent ideas',
    'recommend agents',
    'agent suggestions',
    'agent menu',
    'what should i automate',
    'what can you build for me',
    'update what you know about my work',
    'my work profile',
  ],
  executionType: 'action',
  estimatedExecutionMs: 8000,
  multiTurn: true,

  memoryConfig: { displayName: 'Agent Suggester' },

  prompt: `Agent Suggester recommends NEW agents worth building for this user.

Use this agent when:
- The user asks what agents they should build / what to automate ("suggest agents", "agent ideas", "what do I need")
- The user wants to update their work profile ("update what you know about my work")

It shows a menu UI of suggestions with descriptions and Build buttons. It interviews the user about their job when it doesn't know them yet.

LOW confidence when: the user wants to BUILD a specific agent they already have in mind (Agent Builder handles that), or asks an existing agent to do its job.`,

  async onExecute(task) {
    const content = (task.content || task.text || task.query || '').trim();
    const profile = _profile();
    try {
      if (profile && typeof profile.load === 'function') await profile.load();
    } catch (_e) { /* profile is best-effort */ }

    // ── Interview continuation (multi-turn via pending context) ──────────
    const pending = task.context?.pendingInterview;
    if (pending) {
      return this._interviewStep(profile, pending, content);
    }

    // ── Explicit profile update request restarts the interview ───────────
    if (/update .*(work|profile)|about my (work|job)/i.test(content)) {
      return this._interviewStep(profile, { step: -1, answers: [] }, '');
    }

    // ── Empty profile -> interview first ─────────────────────────────────
    const facts = this._workFacts(profile);
    if (isWorkProfileEmpty(facts)) {
      return this._interviewStep(profile, { step: -1, answers: [] }, '', {
        preface: "I don't know your work well enough to suggest agents yet — three quick questions. ",
      });
    }

    // ── Suggest ───────────────────────────────────────────────────────────
    return this._suggest(profile, facts);
  },

  _workFacts(profile) {
    let all = {};
    try {
      all = (profile && typeof profile.getFacts === 'function' && profile.getFacts()) || {};
    } catch { /* profile optional */ }
    const facts = {};
    for (const q of INTERVIEW_QUESTIONS) {
      facts[q.key] = all[q.key] || (this.memory ? this._memoryFact(q.key) : '') || '';
    }
    return facts;
  },

  _memoryFact(key) {
    try {
      const section = this.memory.getSection('User Work Profile') || '';
      const m = section.match(new RegExp(`^- ${key}: (.*)$`, 'm'));
      return m ? m[1] : '';
    } catch {
      return '';
    }
  },

  async _interviewStep(profile, state, answer, opts = {}) {
    const step = advanceInterview(state, answer);

    if (!step.done) {
      return {
        success: true,
        message: (opts.preface || '') + step.nextQuestion,
        needsInput: {
          prompt: (opts.preface || '') + step.nextQuestion,
          agentId: this.id,
          context: { pendingInterview: step.state },
        },
      };
    }

    // Interview complete: persist to the cross-agent profile AND our memory
    // (the "prompt filled with user info" every future suggestion uses).
    try {
      if (profile && typeof profile.updateFacts === 'function') {
        profile.updateFacts(step.facts);
        if (typeof profile.save === 'function') await profile.save();
      }
    } catch (err) {
      log.warn('agent-suggester', 'profile save failed (memory fallback only)', { error: err.message });
    }
    try {
      if (this.memory) {
        const lines = Object.entries(step.facts).map(([k, v]) => `- ${k}: ${v}`);
        this.memory.updateSection('User Work Profile', lines.join('\n'));
        await this.memory.save();
      }
    } catch (_e) { /* non-fatal */ }

    return this._suggest(profile, step.facts, {
      notice: 'Work profile saved ✓',
      preface: "Got it — that's saved. ",
    });
  },

  async _suggest(profile, facts, opts = {}) {
    const profileText = Object.entries(facts)
      .filter(([, v]) => v)
      .map(([k, v]) => `${k}: ${v}`)
      .join('\n');

    const signals = collectSignals(_signalDeps());

    let suggestions = [];
    try {
      const result = await _ai().json(buildSuggestionPrompt(profileText, signals, 5), {
        profile: 'standard',
        temperature: 0.5,
        maxTokens: 900,
        feature: 'agent-suggester',
      });
      suggestions = filterSuggestions(result?.suggestions, signals.existingAgents);
    } catch (err) {
      log.warn('agent-suggester', 'suggestion generation failed', { error: err.message });
      return {
        success: false,
        message: "I couldn't put suggestions together right now — try again in a moment.",
      };
    }

    if (!suggestions.length) {
      return {
        success: true,
        message:
          "Your current agents already cover what I can see. Ask me again after you've used the orb a bit more, or tell me about tasks I don't know about.",
      };
    }

    const profileSummary = (facts.workRole || '').slice(0, 80);
    const html = renderAgentMenu(suggestions, { notice: opts.notice, profileSummary });
    try {
      _showMenu(html);
    } catch (err) {
      log.warn('agent-suggester', 'menu modal failed (spoken list only)', { error: err.message });
    }

    const top = suggestions[0];
    const spoken =
      (opts.preface || '') +
      `I put ${suggestions.length} agent ideas on screen. Top pick: ${top.name} — ${top.description} ` +
      `Tap Build on any of them, or say "build the first one".`;

    return {
      success: true,
      message: spoken,
      spokenSummary: spoken,
      visualText: `${suggestions.length} agent suggestions`,
      data: { suggestions },
    };
  },
});

module.exports._setTestDeps = _setTestDeps;
