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

  prompt: `Action Item Agent captures TODO/action items from meetings.

HIGH CONFIDENCE (0.80+) for:
- Explicit action items: "action item: John to send the proposal", "todo: review the budget"
- Follow-ups: "follow up with Sarah", "remind me to check on the build"
- Assignments: "assign this to Mike", "John is responsible for the report"

LOW CONFIDENCE (0.00) -- do NOT bid on:
- Calendar scheduling with specific times: "add a meeting at 2pm", "schedule a sync tomorrow at 11am", "book a call Thursday at 3pm" -> calendar-create-agent
- Calendar queries: "what's on my calendar", "any meetings today" -> calendar-query-agent
- Calendar delete/cancel: "cancel the meeting", "delete the standup" -> calendar-delete-agent
- General questions or knowledge: "what time is it", "tell me a joke" -> other agents

CRITICAL: If the user mentions a SPECIFIC TIME (at 2pm, at 11am, tomorrow, Monday, etc.) and wants to ADD/SCHEDULE/CREATE something, this is a CALENDAR EVENT, not an action item. Bid 0.00.`,

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
