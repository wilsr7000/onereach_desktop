/**
 * Help Agent - A Thinking Agent
 *
 * Lists available capabilities and provides guidance.
 * Dynamically aggregates all registered agents to give users
 * a complete picture of what the app can do.
 *
 * Thinking Agent features:
 * - Remembers recently asked topics
 * - Tracks skill level (beginner/advanced) to adjust responses
 * - Can ask clarifying questions for vague help requests
 */

const { getAgentMemory } = require('../../lib/agent-memory-store');
const { learnFromInteraction } = require('../../lib/thinking-agent');

const CATEGORY_LABELS = {
  productivity: 'Productivity',
  information: 'Information',
  media: 'Media & Creative',
  system: 'System',
  utility: 'Utility',
  communication: 'Communication',
  help: 'Help',
  other: 'Other',
};

const CATEGORY_MAP = {
  'calendar-query-agent': 'productivity',
  'calendar-create-agent': 'productivity',
  'calendar-edit-agent': 'productivity',
  'calendar-delete-agent': 'productivity',
  'action-item-agent': 'productivity',
  'email-agent': 'productivity',
  'daily-brief-agent': 'productivity',
  'time-agent': 'information',
  'weather-agent': 'information',
  'search-agent': 'information',
  'browsing-agent': 'information',
  'browser-agent': 'information',
  'docs-agent': 'information',
  'dj-agent': 'media',
  'recorder-agent': 'media',
  'sound-effects-agent': 'media',
  'spaces-agent': 'system',
  'app-agent': 'system',
  'memory-agent': 'system',
  'help-agent': 'system',
  'error-agent': 'system',
  'orchestrator-agent': 'system',
  'spelling-agent': 'utility',
  'smalltalk-agent': 'utility',
  'playbook-agent': 'utility',
  'meeting-monitor-agent': 'communication',
  'meeting-notes-agent': 'communication',
  'decision-agent': 'communication',
};

const SKIP_FROM_DISPLAY = new Set(['error-agent', 'orchestrator-agent']);

const helpAgent = {
  id: 'help-agent',
  name: 'Help Agent',
  description: 'Lists available capabilities - remembers your skill level',
  voice: 'alloy',
  categories: ['system', 'help'],
  keywords: ['help', 'what can you do', 'capabilities', 'commands', 'how do i', 'what do you'],
  executionType: 'informational',

  prompt: `Help Agent lists the app's capabilities, explains available features, and describes what agents can do.

Capabilities:
- List all available agents and their capabilities
- Explain how to use specific features
- Describe what the app can do overall
- Provide general guidance on getting started

This agent provides information about the app's capabilities. It does not perform tasks itself.`,

  memory: null,
  _deps: null,

  _setDeps(deps) {
    this._deps = deps;
  },

  async initialize() {
    if (!this.memory) {
      this.memory = getAgentMemory('help-agent', { displayName: 'Help Agent' });
      await this.memory.load();
      this._ensureMemorySections();
    }
    return this.memory;
  },

  _ensureMemorySections() {
    const sections = this.memory.getSectionNames();

    if (!sections.includes('Learned Preferences')) {
      this.memory.updateSection(
        'Learned Preferences',
        `- Skill Level: Beginner
- Preferred Detail: Concise
- Last Topic: None`
      );
    }

    if (!sections.includes('Topics Asked')) {
      this.memory.updateSection('Topics Asked', `*Topics you've asked about will appear here*`);
    }

    if (this.memory.isDirty()) {
      this.memory.save();
    }
  },

  async execute(task, _context) {
    try {
      if (!this.memory) {
        await this.initialize();
      }

      const lower = (task.content || '').toLowerCase();
      const prefs = this.memory?.parseSectionAsKeyValue('Learned Preferences') || {};
      const skillLevel = prefs['Skill Level'] || 'Beginner';
      const isAdvanced = skillLevel.toLowerCase() === 'advanced';

      if (task.context?.pendingState === 'awaiting_topic') {
        const topic = task.context?.userInput || task.content;
        return this._getHelpForTopic(topic, isAdvanced);
      }

      if (/^help[\s!.,?]*$/i.test(lower) || lower === 'help me') {
        return {
          success: true,
          needsInput: {
            prompt:
              'What would you like help with? I can tell you about scheduling, weather, music, web search, recording, or anything else. Or say "show me everything".',
            agentId: this.id,
            context: { pendingState: 'awaiting_topic' },
          },
        };
      }

      const result = this._getHelpForTopic(lower, isAdvanced);

      await learnFromInteraction(this.memory, task, result, {
        learnedPreferences: { 'Last Topic': this._extractTopic(lower) },
      });

      const topic = this._extractTopic(lower);
      if (topic) {
        const timestamp = new Date().toISOString().split('T')[0];
        this.memory.appendToSection('Topics Asked', `- ${timestamp}: ${topic}`, 20);
        await this.memory.save();
      }

      return result;
    } catch (err) {
      return { success: false, message: `I had trouble loading help info: ${err.message}` };
    }
  },

  _getAgentList() {
    if (this._deps?.getAgentList) {
      try { return this._deps.getAgentList(); } catch (_) { /* fall through */ }
    }
    try {
      const { getAllAgents } = require('./agent-registry');
      return getAllAgents();
    } catch (_) {
      return [];
    }
  },

  _extractTopic(lower) {
    if (lower.includes('time') || lower.includes('date')) return 'time';
    if (lower.includes('weather')) return 'weather';
    if (lower.includes('music') || lower.includes('play') || lower.includes('volume')) return 'music';
    if (lower.includes('calendar') || lower.includes('schedule') || lower.includes('meeting')) return 'calendar';
    if (lower.includes('search') || lower.includes('browse') || lower.includes('web')) return 'search';
    if (lower.includes('record') || lower.includes('video') || lower.includes('capture')) return 'recording';
    if (lower.includes('space') || lower.includes('content') || lower.includes('organize')) return 'spaces';
    if (lower.includes('brief') || lower.includes('morning')) return 'daily-brief';
    if (lower.includes('undo') || lower.includes('cancel') || lower.includes('repeat')) return 'commands';
    if (lower.includes('everything') || lower.includes('all') || lower.includes('what can')) return 'general';
    return 'general';
  },

  _getHelpForTopic(topic, isAdvanced) {
    const lower = topic.toLowerCase();

    if (lower.includes('time') || lower.includes('date')) {
      const basic = "Just ask 'what time is it' or 'what's the date' and I'll tell you.";
      const extra = isAdvanced ? ' I remember your preferred format.' : '';
      return { success: true, message: basic + extra };
    }

    if (lower.includes('weather')) {
      const basic = "Say 'what's the weather in' followed by a city name. I'll remember your home city.";
      const extra = isAdvanced ? ' I support both Fahrenheit and Celsius.' : '';
      return { success: true, message: basic + extra };
    }

    if (lower.includes('music') || lower.includes('play') || lower.includes('volume')) {
      return {
        success: true,
        message: "Say 'play music', 'pause', 'skip', or 'volume up/down'. I'll ask about your mood to pick music.",
      };
    }

    if (lower.includes('calendar') || lower.includes('schedule') || lower.includes('meeting')) {
      return {
        success: true,
        message: "I can manage your calendar. Ask 'what's on my schedule', 'add a meeting', 'cancel the standup', or 'find free time this week'.",
      };
    }

    if (lower.includes('search') || lower.includes('browse') || lower.includes('web')) {
      return {
        success: true,
        message: "Say 'search for' followed by anything. I can also browse websites, read pages, and fill forms autonomously.",
      };
    }

    if (lower.includes('record') || lower.includes('capture')) {
      return {
        success: true,
        message: "Say 'record a video' or 'capture my screen' to open the recorder. It supports camera, screen, and dual-recording sessions.",
      };
    }

    if (lower.includes('space') || lower.includes('content') || lower.includes('organize')) {
      return {
        success: true,
        message: "Spaces stores all your content. Ask 'open spaces' or use Cmd+Shift+V. You can search, organize, and push content to the cloud.",
      };
    }

    if (lower.includes('brief') || lower.includes('morning')) {
      return {
        success: true,
        message: "Say 'give me my daily brief' for a summary of your schedule, weather, and more. Multiple agents contribute.",
      };
    }

    if (lower.includes('undo') || lower.includes('cancel') || lower.includes('repeat') || lower.includes('command')) {
      return {
        success: true,
        message: "Say 'cancel' to stop, 'repeat' to hear my last response, or use Cmd+K to open the command palette.",
      };
    }

    return this._buildCapabilitiesOverview();
  },

  _buildCapabilitiesOverview() {
    const agents = this._getAgentList();
    const grouped = {};

    for (const agent of agents) {
      if (SKIP_FROM_DISPLAY.has(agent.id)) continue;
      const cat = CATEGORY_MAP[agent.id] || agent.categories?.[0] || 'other';
      if (!grouped[cat]) grouped[cat] = [];
      grouped[cat].push({ name: agent.name, desc: agent.description || '' });
    }

    const speech = this._buildSpeechSummary(grouped);
    const html = this._buildHTMLPanel(grouped);

    return {
      success: true,
      message: speech,
      html,
    };
  },

  _buildSpeechSummary(grouped) {
    const parts = [];
    const total = Object.values(grouped).reduce((s, arr) => s + arr.length, 0);

    parts.push(`I have ${total} capabilities across several areas.`);

    const areaSnippets = [];
    if (grouped.productivity?.length) areaSnippets.push('calendar management and daily briefings');
    if (grouped.information?.length) areaSnippets.push('web search, weather, and browsing');
    if (grouped.media?.length) areaSnippets.push('music, recording, and sound effects');
    if (grouped.communication?.length) areaSnippets.push('meeting notes and action items');
    if (grouped.utility?.length) areaSnippets.push('spelling, chat, and playbooks');
    if (grouped.system?.length) areaSnippets.push('app navigation, spaces, and memory');

    if (areaSnippets.length > 0) {
      parts.push('I can help with ' + areaSnippets.join(', ') + '.');
    }

    parts.push("Just ask naturally. Say 'help with calendar' for details on any area, or press Cmd+K to search everything.");
    return parts.join(' ');
  },

  _buildHTMLPanel(grouped) {
    const order = ['productivity', 'information', 'media', 'communication', 'utility', 'system'];
    let html = '<div style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;color:#e0e0e0;padding:8px 0;">';
    html += '<div style="font-size:13px;font-weight:600;margin-bottom:10px;color:#fff;">All Capabilities</div>';

    for (const cat of order) {
      const agents = grouped[cat];
      if (!agents?.length) continue;
      const label = CATEGORY_LABELS[cat] || cat;
      html += `<div style="margin-bottom:10px;">`;
      html += `<div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.6px;color:rgba(255,255,255,0.4);margin-bottom:4px;">${label}</div>`;
      for (const a of agents) {
        html += `<div style="display:flex;align-items:baseline;gap:6px;padding:2px 0;">`;
        html += `<span style="font-size:12px;color:#f0f0f0;">${escapeHtml(a.name)}</span>`;
        if (a.desc) {
          html += `<span style="font-size:10px;color:rgba(255,255,255,0.3);">${escapeHtml(truncate(a.desc, 50))}</span>`;
        }
        html += `</div>`;
      }
      html += `</div>`;
    }

    html += '<div style="font-size:10px;color:rgba(255,255,255,0.25);margin-top:6px;border-top:1px solid rgba(255,255,255,0.06);padding-top:6px;">Press Cmd+K to search all features</div>';
    html += '</div>';
    return html;
  },
};

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function truncate(s, max) {
  return s.length > max ? s.slice(0, max - 1) + '\u2026' : s;
}

module.exports = helpAgent;
