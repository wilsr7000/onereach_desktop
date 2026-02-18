/**
 * Meeting Notes Agent
 *
 * Captures general notes, key points, and bookmarks during meetings:
 * - Notes: General observations or information
 * - Bookmarks: "Bookmark this" marks a moment in the recording
 *
 * Part of the meeting-agents space. Used by the Meeting HUD
 * in the recorder to capture notes during meetings.
 *
 * Returns structured data: { type, text, tags, deadline }
 */

const { getAgentMemory } = require('../../lib/agent-memory-store');
const ai = require('../../lib/ai-service');
const { getLogQueue } = require('../../lib/log-event-queue');
const log = getLogQueue();

const meetingNotesAgent = {
  id: 'meeting-notes-agent',
  name: 'Meeting Notes Agent',
  description:
    'Captures general meeting notes, key points, and bookmarks. Says things like "Note: discussed the timeline" or "Key point: 3 sprints needed" or "Bookmark this moment".',
  voice: 'alloy',
  acks: ['Noted.', 'Got it.'],
  categories: ['meeting', 'productivity'],
  keywords: ['note', 'key point', 'bookmark', 'remember', 'important', 'highlight', 'capture', 'mark'],
  executionType: 'action',
  defaultSpaces: ['meeting-agents'],

  /**
   * Briefing contribution: recent meeting notes summary.
   * Priority 6 = appears near end of daily brief.
   */
  async getBriefing() {
    try {
      const spacesApi = require('../../spaces-api');
      const items = await spacesApi.getItemsBySpace?.('meeting-agents');
      if (!items || items.length === 0) return { section: 'Meeting Notes', priority: 6, content: null };
      const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
      const recent = items.filter((i) => {
        const created = new Date(i.createdAt || 0).getTime();
        return created > dayAgo && (i.type === 'note' || i.agentId === 'meeting-notes-agent');
      });
      if (recent.length === 0) return { section: 'Meeting Notes', priority: 6, content: null };
      return {
        section: 'Meeting Notes',
        priority: 6,
        content: `${recent.length} meeting note${recent.length === 1 ? '' : 's'} captured in the last 24 hours.`,
      };
    } catch (_e) {
      /* skip */
    }
    return { section: 'Meeting Notes', priority: 6, content: null };
  },

  memory: null,

  async initialize() {
    if (!this.memory) {
      this.memory = getAgentMemory('meeting-notes-agent', { displayName: 'Meeting Notes Agent' });
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
      return { success: false, message: 'No content to capture as a note.' };
    }

    try {
      const extraction = await _extractNote(content);

      if (!extraction) {
        return {
          success: false,
          message: 'Could not extract note content.',
        };
      }

      if (this.memory) {
        try {
          const timestamp = new Date().toLocaleTimeString();
          const tagStr = extraction.tags.join(', ');
          const typeLabel = extraction.type === 'bookmark' ? 'BOOKMARK' : 'NOTE';
          this.memory.appendToSection(
            'Meeting Notes',
            `- [${timestamp}] [${typeLabel}] [${tagStr}] ${extraction.text}`
          );
          this.memory.save();
        } catch (_e) {
          // Non-fatal
        }
      }

      const typeLabel = extraction.type === 'bookmark' ? 'Bookmark' : 'Note';

      return {
        success: true,
        message: `${typeLabel} captured: ${extraction.text}`,
        data: {
          type: extraction.type,
          text: extraction.text,
          tags: extraction.tags,
          deadline: extraction.deadline,
        },
      };
    } catch (error) {
      log.error('agent', 'Error', { error: error.message });
      return { success: false, message: `Failed to capture note: ${error.message}` };
    }
  },
};

async function _extractNote(text) {
  try {
    const data = await ai.chat({
      profile: 'fast',
      messages: [
        {
          role: 'user',
          content: `Extract the meeting note from this input. Return JSON only.

Input: "${text}"

Extract:
- "type": Either "note" (general note/key point) or "bookmark" (marking a moment)
- "text": The clean note content
- "tags": Array of people mentioned or related. Use "Me" if no one specific is mentioned, "Everyone" if it's a team observation.
- "deadline": Any date/time reference, or null.

Examples:
- "Note: discussed the timeline for Q3" -> {"type":"note","text":"Discussed the timeline for Q3","tags":["Everyone"],"deadline":null}
- "Key point: we need 3 sprints for this" -> {"type":"note","text":"Need 3 sprints for this","tags":["Everyone"],"deadline":null}
- "Bookmark this moment" -> {"type":"bookmark","text":"Bookmarked moment","tags":["Me"],"deadline":null}
- "Important: Sarah mentioned the compliance deadline is April 1" -> {"type":"note","text":"Compliance deadline is April 1","tags":["Sarah"],"deadline":"April 1"}

Return ONLY valid JSON, no other text.`,
        },
      ],
      temperature: 0.1,
      maxTokens: 200,
      jsonMode: true,
      feature: 'meeting-notes-agent',
    });

    const result = JSON.parse(data.content || '{}');

    return {
      type: result.type === 'bookmark' ? 'bookmark' : 'note',
      text: result.text || text.trim(),
      tags: Array.isArray(result.tags) ? result.tags : ['Me'],
      deadline: result.deadline || null,
    };
  } catch (error) {
    log.warn('agent', 'LLM extraction failed', { error: error.message });
    const isBookmark = /bookmark/i.test(text);
    return {
      type: isBookmark ? 'bookmark' : 'note',
      text: text.trim(),
      tags: ['Me'],
      deadline: null,
    };
  }
}

module.exports = meetingNotesAgent;
