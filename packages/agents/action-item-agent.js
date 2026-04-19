/**
 * Action Item Agent
 *
 * Captures action items from meeting context with:
 * - Owner/assignee extraction (person names as tags)
 * - Deadline detection
 * - Clean task text
 *
 * Part of the meeting-agents space. Used by the Meeting HUD
 * in the recorder to track action items during meetings.
 *
 * Returns structured data: { type, text, tags, deadline }
 * Tags are person names (or "Me"/"Everyone" as defaults).
 */

const { getAgentMemory } = require('../../lib/agent-memory-store');
const ai = require('../../lib/ai-service');
const { getLogQueue } = require('../../lib/log-event-queue');
const log = getLogQueue();

const actionItemAgent = {
  id: 'action-item-agent',
  name: 'Action Item Agent',
  description:
    'Captures action items from meeting context. Extracts assignees, deadlines, and clean task descriptions. Says things like "Action: John to send proposal by Friday" or "Todo: review the budget".',
  voice: 'coral',
  acks: ['Got it.', 'Action item captured.'],
  categories: ['meeting', 'productivity'],
  keywords: ['action', 'todo', 'task', 'assign', 'follow up', 'deadline', 'owner', 'responsible'],
  executionType: 'action',
  estimatedExecutionMs: 2000,
  defaultSpaces: ['meeting-agents'],

  // ── Per-criterion expertise (agent-system v2, Phase 4) ─────────────────
  // Scores used by council mode when task.rubric === 'meeting_outcome'.
  expertise: {
    notes_quality: 0.4,      // sees notes as context, doesn't author them
    decisions_captured: 0.3, // decisions are someone else's job
    action_items: 0.95,      // this agent's core job -- highest confidence
    unresolved: 0.5,         // captures "X needs follow-up" well
    priority: 0.7,           // deadlines + owners give strong priority signal
  },

  /**
   * Briefing contribution: pending/overdue action items.
   * Priority 5 = appears after email in the daily brief.
   */
  async getBriefing() {
    try {
      // Check the default space for uncompleted action items
      const spacesApi = require('../../spaces-api');
      const items = await spacesApi.getItemsBySpace?.('meeting-agents');
      if (!items || items.length === 0) {
        return { section: 'Action Items', priority: 5, content: null };
      }
      // Filter to incomplete items from the last 7 days
      const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
      const pending = items.filter((i) => {
        const created = new Date(i.createdAt || 0).getTime();
        return created > weekAgo && !i.completed;
      });
      if (pending.length === 0) {
        return { section: 'Action Items', priority: 5, content: 'No pending action items.' };
      }
      const summaryLines = pending.slice(0, 5).map((i) => {
        const desc = i.content?.substring(0, 80) || i.title || 'Untitled task';
        return `- ${desc}`;
      });
      const more = pending.length > 5 ? ` (and ${pending.length - 5} more)` : '';
      return {
        section: 'Action Items',
        priority: 5,
        content: `You have ${pending.length} pending action items${more}:\n${summaryLines.join('\n')}`,
      };
    } catch (_e) {
      // Action items unavailable
    }
    return { section: 'Action Items', priority: 5, content: null };
  },

  prompt: `Action Item Agent captures TODO items, action items, and follow-ups from conversations and meetings.

Capabilities:
- Capture explicit action items and TODOs
- Record follow-up tasks with assignees
- Track task assignments and responsibilities
- Log action items with deadlines when mentioned

This agent captures task-oriented items from conversation. It does not schedule calendar events with specific times.`,

  memory: null,

  async initialize() {
    if (!this.memory) {
      this.memory = getAgentMemory('action-item-agent', { displayName: 'Action Item Agent' });
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
      return { success: false, message: 'No content to extract action item from.' };
    }

    try {
      // Use LLM to extract structured action item data
      const extraction = await _extractActionItem(content);

      if (!extraction) {
        return {
          success: false,
          message: 'Could not identify an action item in that input.',
        };
      }

      // Save to memory for meeting history
      if (this.memory) {
        try {
          const timestamp = new Date().toLocaleTimeString();
          const tagStr = extraction.tags.join(', ');
          const deadlineStr = extraction.deadline ? ` (by ${extraction.deadline})` : '';
          this.memory.appendToSection('Action Items', `- [${timestamp}] [${tagStr}] ${extraction.text}${deadlineStr}`);
          this.memory.save();
        } catch (_e) {
          // Non-fatal
        }
      }

      return {
        success: true,
        message: `Action item captured: ${extraction.text}`,
        data: {
          type: 'action-item',
          text: extraction.text,
          tags: extraction.tags,
          deadline: extraction.deadline,
        },
      };
    } catch (error) {
      log.error('agent', 'Error', { error: error.message });
      return { success: false, message: `Failed to extract action item: ${error.message}` };
    }
  },
};

/**
 * Extract structured action item data from natural language using LLM.
 */
async function _extractActionItem(text) {
  try {
    const data = await ai.chat({
      profile: 'fast',
      messages: [
        {
          role: 'user',
          content: `Extract the action item from this meeting input. Return JSON only.

Input: "${text}"

Extract:
- "text": The clean action item description (without names/dates that were extracted)
- "tags": Array of person names assigned. Use "Me" if the speaker is assigning to themselves, "Everyone" if it's for the whole team. If a specific name is mentioned, use that name.
- "deadline": Any deadline/date mentioned (as a short string like "Friday", "end of week", "March 15"), or null if none.

Examples:
- "John needs to send the proposal by Friday" -> {"text":"Send the proposal","tags":["John"],"deadline":"Friday"}
- "I'll review the budget" -> {"text":"Review the budget","tags":["Me"],"deadline":null}
- "Everyone should read the doc before Monday" -> {"text":"Read the doc","tags":["Everyone"],"deadline":"Monday"}
- "Sarah and Mike to coordinate on the launch" -> {"text":"Coordinate on the launch","tags":["Sarah","Mike"],"deadline":null}

Return ONLY valid JSON, no other text.`,
        },
      ],
      temperature: 0.1,
      maxTokens: 200,
      jsonMode: true,
      feature: 'action-item-agent',
    });

    const result = JSON.parse(data.content || '{}');

    return {
      text: result.text || text.trim(),
      tags: Array.isArray(result.tags) ? result.tags : ['Me'],
      deadline: result.deadline || null,
    };
  } catch (error) {
    log.warn('agent', 'LLM extraction failed, using fallback', { error: error.message });
    return { text: text.trim(), tags: ['Me'], deadline: null };
  }
}

module.exports = actionItemAgent;
