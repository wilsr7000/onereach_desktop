/**
 * Decision Agent
 *
 * Logs decisions made during meetings with:
 * - Decision text
 * - Who was involved (tags)
 * - Rationale/context
 *
 * Part of the meeting-agents space. Used by the Meeting HUD
 * in the recorder to track decisions during meetings.
 *
 * Returns structured data: { type, text, tags, deadline }
 */

const { getAgentMemory } = require('../../lib/agent-memory-store');
const ai = require('../../lib/ai-service');
const { getLogQueue } = require('../../lib/log-event-queue');
const log = getLogQueue();

const decisionAgent = {
  id: 'decision-agent',
  name: 'Decision Agent',
  description:
    'Logs decisions made during meetings. Captures the decision, who was involved, and rationale. Says things like "Decision: we agreed to use React" or "We decided to launch in Q3".',
  voice: 'sage',
  acks: ['Decision noted.', 'Got it, decision recorded.'],
  categories: ['meeting', 'productivity'],
  keywords: ['decision', 'decided', 'agreed', 'approved', 'chose', 'selected', 'consensus', 'resolved'],
  executionType: 'action',
  defaultSpaces: ['meeting-agents'],

  /**
   * Briefing contribution: recent decisions logged.
   * Priority 7 = appears near end of daily brief.
   */
  async getBriefing() {
    try {
      const spacesApi = require('../../spaces-api');
      const items = await spacesApi.getItemsBySpace?.('meeting-agents');
      if (!items || items.length === 0) return { section: 'Decisions', priority: 7, content: null };
      const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
      const recent = items.filter((i) => {
        const created = new Date(i.createdAt || 0).getTime();
        return created > dayAgo && (i.type === 'decision' || i.agentId === 'decision-agent');
      });
      if (recent.length === 0) return { section: 'Decisions', priority: 7, content: null };
      return {
        section: 'Decisions',
        priority: 7,
        content: `${recent.length} decision${recent.length === 1 ? '' : 's'} logged in the last 24 hours.`,
      };
    } catch (_e) {
      /* skip */
    }
    return { section: 'Decisions', priority: 7, content: null };
  },

  memory: null,

  async initialize() {
    if (!this.memory) {
      this.memory = getAgentMemory('decision-agent', { displayName: 'Decision Agent' });
      await this.memory.load();
    }
    return this.memory;
  },

  // No bid() method. Routing is 100% LLM-based via unified-bidder.js.

  async execute(task) {
    // Ensure memory is loaded before use
    if (!this.memory) {
      await this.initialize();
    }

    const content = task.content || task.phrase || '';

    if (!content.trim()) {
      return { success: false, message: 'No content to extract decision from.' };
    }

    try {
      const extraction = await _extractDecision(content);

      if (!extraction) {
        return {
          success: false,
          message: 'Could not identify a decision in that input.',
        };
      }

      if (this.memory) {
        try {
          const timestamp = new Date().toLocaleTimeString();
          const tagStr = extraction.tags.join(', ');
          this.memory.appendToSection('Decisions', `- [${timestamp}] [${tagStr}] ${extraction.text}`);
          this.memory.save();
        } catch (_e) {
          // Non-fatal
        }
      }

      return {
        success: true,
        message: `Decision recorded: ${extraction.text}`,
        data: {
          type: 'decision',
          text: extraction.text,
          tags: extraction.tags,
          deadline: extraction.deadline,
        },
      };
    } catch (error) {
      log.error('agent', 'Error', { error: error.message });
      return { success: false, message: `Failed to extract decision: ${error.message}` };
    }
  },
};

async function _extractDecision(text) {
  try {
    const data = await ai.chat({
      profile: 'fast',
      messages: [
        {
          role: 'user',
          content: `Extract the decision from this meeting input. Return JSON only.

Input: "${text}"

Extract:
- "text": The clean decision statement
- "tags": Array of people involved in the decision. Use "Everyone" if the whole team decided. Use specific names if mentioned.
- "deadline": Any implementation deadline if mentioned, or null.

Examples:
- "We decided to use React for the frontend" -> {"text":"Use React for the frontend","tags":["Everyone"],"deadline":null}
- "John and Sarah approved the Q3 budget" -> {"text":"Approved the Q3 budget","tags":["John","Sarah"],"deadline":null}
- "Decision: launch by March 15" -> {"text":"Launch by March 15","tags":["Everyone"],"deadline":"March 15"}

Return ONLY valid JSON, no other text.`,
        },
      ],
      temperature: 0.1,
      maxTokens: 200,
      jsonMode: true,
      feature: 'decision-agent',
    });

    const result = JSON.parse(data.content || '{}');

    return {
      text: result.text || text.trim(),
      tags: Array.isArray(result.tags) ? result.tags : ['Everyone'],
      deadline: result.deadline || null,
    };
  } catch (error) {
    log.warn('agent', 'LLM extraction failed', { error: error.message });
    return { text: text.trim(), tags: ['Everyone'], deadline: null };
  }
}

module.exports = decisionAgent;
