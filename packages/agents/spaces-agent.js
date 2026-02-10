/**
 * Spaces Agent - Intelligent Content Assistant
 * 
 * A dedicated agent for managing and querying Spaces content.
 * Provides smart summaries when opening Spaces, answers questions
 * about saved content, and searches within Spaces.
 * 
 * Capabilities:
 * - "Open Spaces" with intelligent summary of recent items
 * - "What did I save today/yesterday/this week?"
 * - "Find my notes about X" / "Search spaces for Y"
 * - "How many screenshots do I have?"
 * - Analytics and insights about saved content
 * - "Create a space called X" - creates new spaces
 * - "Add a note" / "Save note: X" - adds notes to spaces
 */

const { getAgentMemory } = require('../../lib/agent-memory-store');
const ai = require('../../lib/ai-service');
const { getLogQueue } = require('../../lib/log-event-queue');
const log = getLogQueue();

// Get the Spaces API (lazy load to avoid circular deps)
let spacesAPI = null;
function getSpacesAPI() {
  if (!spacesAPI) {
    try {
      const SpacesAPIClass = require('../../spaces-api');
      spacesAPI = new SpacesAPIClass();
    } catch (e) {
      log.error('agent', 'Failed to load Spaces API', { error: e.message });
    }
  }
  return spacesAPI;
}

// Time period keywords and their millisecond values
const TIME_PERIODS = {
  'today': 24 * 60 * 60 * 1000,
  'yesterday': 48 * 60 * 60 * 1000,  // Look back 48h, filter for yesterday
  'this week': 7 * 24 * 60 * 60 * 1000,
  'last week': 14 * 24 * 60 * 60 * 1000,
  'this month': 30 * 24 * 60 * 60 * 1000,
  'recent': 24 * 60 * 60 * 1000,
};

const spacesAgent = {
  id: 'spaces-agent',
  name: 'Spaces Assistant',
  description: 'Manages your saved content in Spaces. Opens Spaces with smart summaries, searches your content, creates new spaces, and saves notes. Say "create a space called Work" or "add a note" to manage content.',
  voice: 'nova',
  acks: ['Let me check your Spaces.', 'Looking at your saved items.', 'Working on that.'],
  categories: ['storage', 'content', 'clipboard', 'search', 'organization', 'notes'],
  keywords: [
    'spaces', 'clipboard', 'saved', 'items', 'find', 'search', 'recent',
    'what did i save', 'open spaces', 'show clipboard', 'my items',
    'screenshots', 'notes', 'files', 'content', 'storage',
    'create space', 'new space', 'add note', 'save note', 'remember this'
  ],
  executionType: 'action',  // Reads/writes Spaces data
  
  // Pending note content (for multi-turn note creation)
  _pendingNote: null,

  // Memory for tracking user patterns
  memory: null,

  /**
   * Initialize memory
   */
  async initialize() {
    if (!this.memory) {
      this.memory = getAgentMemory('spaces-agent', { displayName: 'Spaces Assistant' });
      await this.memory.load();
      this._ensureMemorySections();
    }
    return this.memory;
  },

  /**
   * Ensure required memory sections exist
   */
  _ensureMemorySections() {
    const sections = this.memory.getSectionNames();

    if (!sections.includes('Recent Queries')) {
      this.memory.updateSection('Recent Queries', '*Tracks your recent Spaces queries*');
    }

    if (!sections.includes('Patterns')) {
      this.memory.updateSection('Patterns', '*Learns what content you save most*');
    }

    if (this.memory.isDirty()) {
      this.memory.save();
    }
  },

  // No bid() method. Routing is 100% LLM-based via unified-bidder.js.
  // NEVER add keyword/regex bidding here. See .cursorrules.

  /**
   * Execute the task
   */
  async execute(task, context = {}) {
    const { onProgress = () => {} } = context;

    try {
      await this.initialize();
      const lower = task.content?.toLowerCase() || '';

      onProgress('Checking your Spaces...');

      // ==================== MULTI-TURN STATE HANDLING ====================
      // Check if this is a follow-up response to a previous needsInput
      const action = task.context?.action;
      if (action) {
        log.info('agent', `Handling follow-up for action: ${action}`);
        
        if (action === 'create-space') {
          // User is providing the space name
          return this._handleCreateSpaceResponse(task, onProgress);
        }
        
        if (action === 'add-note') {
          // User is providing the note content
          return this._handleAddNoteResponse(task, onProgress);
        }
      }
      
      // Handle generic yes/no follow-ups (for "open spaces?" prompts)
      if (task.context?.userInput) {
        const userResponse = task.context.userInput.toLowerCase();
        if (userResponse.includes('yes') || userResponse.includes('open') || userResponse.includes('sure')) {
          return this._openWithSummary(task, onProgress);
        }
      }

      // Create space command
      if ((lower.includes('create') || lower.includes('make') || lower.includes('new')) &&
          (lower.includes('space') || lower.includes('folder'))) {
        return this._createSpace(task, onProgress);
      }

      // Add note command
      if ((lower.includes('add') || lower.includes('save') || lower.includes('create') || lower.includes('remember')) &&
          (lower.includes('note') || lower.includes('reminder'))) {
        return this._addNote(task, onProgress);
      }

      // List spaces command
      if ((lower.includes('list') || lower.includes('what')) && lower.includes('spaces') && 
          !lower.includes('open') && !lower.includes('show')) {
        return this._listSpaces(task, onProgress);
      }

      // Open/show spaces
      if (lower.includes('open') || lower.includes('show')) {
        return this._openWithSummary(task, onProgress);
      }

      // Find/search
      if (lower.includes('find') || lower.includes('search')) {
        return this._searchSpaces(task, onProgress);
      }

      // Analytics
      if (lower.includes('how many') || lower.includes('count')) {
        return this._getAnalytics(task, onProgress);
      }

      // Time-based query
      if (lower.includes('what') && (lower.includes('save') || lower.includes('add'))) {
        return this._queryByTime(task, onProgress);
      }

      // Default: provide summary and offer to open
      return this._summarizeAndOffer(task, onProgress);

    } catch (error) {
      log.error('agent', 'Execute error', { error });
      return {
        success: false,
        message: 'Sorry, I had trouble accessing your Spaces. Please try again.'
      };
    }
  },

  /**
   * Open Spaces with an intelligent summary
   */
  async _openWithSummary(task, onProgress) {
    onProgress('Getting recent items...');

    // Get recent items (last 24 hours)
    const recentItems = await this._getRecentItems(24 * 60 * 60 * 1000);
    const pinnedItems = await this._getPinnedItems();
    const allSpaces = await this._getSpaces();

    onProgress('Generating summary...');

    // Format for LLM
    const itemsData = this._formatItemsForLLM(recentItems, pinnedItems, allSpaces);

    // Generate smart summary
    const summary = await this._generateSummary(itemsData, task.content);

    // Track this query
    const timestamp = new Date().toISOString().split('T')[0];
    this.memory.appendToSection('Recent Queries', `- ${timestamp}: Opened Spaces`, 20);
    await this.memory.save();

    return {
      success: true,
      message: summary,
      data: {
        action: { type: 'open-spaces' }
      }
    };
  },

  /**
   * Search within Spaces
   */
  async _searchSpaces(task, onProgress) {
    const query = this._extractSearchQuery(task.content);
    
    if (!query) {
      return {
        success: true,
        message: "What would you like me to search for in your Spaces?"
      };
    }

    onProgress(`Searching for "${query}"...`);

    const api = getSpacesAPI();
    if (!api) {
      return { success: false, message: 'Spaces is not available right now.' };
    }

    try {
      const results = await api.search(query, { limit: 10 });

      if (!results || results.length === 0) {
        return {
          success: true,
          message: `I didn't find anything matching "${query}" in your Spaces.`
        };
      }

      // Format results for voice
      const summary = this._formatSearchResults(results, query);

      return {
        success: true,
        message: summary,
        data: {
          action: { type: 'open-spaces' },
          searchQuery: query
        }
      };
    } catch (error) {
      log.error('agent', 'Search error', { error });
      return {
        success: true,
        message: `I had trouble searching. Opening Spaces so you can search manually.`,
        data: { action: { type: 'open-spaces' } }
      };
    }
  },

  /**
   * Query items by time period
   */
  async _queryByTime(task, onProgress) {
    const lower = task.content.toLowerCase();
    
    // Determine time period
    let periodMs = 24 * 60 * 60 * 1000; // Default: today
    let periodName = 'today';

    for (const [name, ms] of Object.entries(TIME_PERIODS)) {
      if (lower.includes(name)) {
        periodMs = ms;
        periodName = name;
        break;
      }
    }

    onProgress(`Looking at items from ${periodName}...`);

    const items = await this._getRecentItems(periodMs);

    // Filter for "yesterday" specifically
    if (periodName === 'yesterday') {
      const now = Date.now();
      const yesterdayStart = now - 48 * 60 * 60 * 1000;
      const yesterdayEnd = now - 24 * 60 * 60 * 1000;
      const yesterdayItems = items.filter(item => 
        item.timestamp >= yesterdayStart && item.timestamp < yesterdayEnd
      );
      return this._formatTimeQueryResponse(yesterdayItems, periodName);
    }

    return this._formatTimeQueryResponse(items, periodName);
  },

  /**
   * Get analytics about Spaces
   */
  async _getAnalytics(task, onProgress) {
    const lower = task.content.toLowerCase();
    
    onProgress('Counting items...');

    const api = getSpacesAPI();
    if (!api) {
      return { success: false, message: 'Spaces is not available right now.' };
    }

    try {
      const spaces = await api.list();
      const totalItems = spaces.reduce((sum, s) => sum + (s.itemCount || 0), 0);

      // Get items to count by type
      const allItems = await this._getAllItems();
      
      // Count by type
      const byType = {};
      allItems.forEach(item => {
        byType[item.type] = (byType[item.type] || 0) + 1;
      });

      // Determine what they're asking about
      let response = '';
      
      if (lower.includes('screenshot')) {
        const count = byType['image'] || 0;
        const recentScreenshots = allItems.filter(i => 
          i.type === 'image' && i.timestamp > Date.now() - 7 * 24 * 60 * 60 * 1000
        ).length;
        response = `You have ${count} images and screenshots in Spaces. ${recentScreenshots} were saved this week.`;
      } else if (lower.includes('video')) {
        const count = byType['video'] || 0;
        response = `You have ${count} videos in Spaces.`;
      } else if (lower.includes('text') || lower.includes('note')) {
        const count = (byType['text'] || 0) + (byType['code'] || 0);
        response = `You have ${count} text items and notes in Spaces.`;
      } else {
        // General count
        const typeList = Object.entries(byType)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([type, count]) => `${count} ${type}${count > 1 ? 's' : ''}`)
          .join(', ');
        
        response = `You have ${totalItems} items across ${spaces.length} spaces. Most common: ${typeList}.`;
      }

      return { success: true, message: response };
    } catch (error) {
      log.error('agent', 'Analytics error', { error });
      return { success: false, message: 'I had trouble counting your items.' };
    }
  },

  /**
   * Summarize Spaces and offer to open
   */
  async _summarizeAndOffer(task, onProgress) {
    const recentItems = await this._getRecentItems(24 * 60 * 60 * 1000);
    
    if (recentItems.length === 0) {
      return {
        success: true,
        message: "Your Spaces is quiet today. No new items in the last 24 hours. Would you like me to open it?",
        needsInput: {
          prompt: "Say 'yes' to open Spaces, or ask me something specific.",
          agentId: this.id
        }
      };
    }

    const byType = this._groupByType(recentItems);
    const typesSummary = Object.entries(byType)
      .map(([type, items]) => `${items.length} ${type}${items.length > 1 ? 's' : ''}`)
      .join(', ');

    return {
      success: true,
      message: `You have ${recentItems.length} new items today: ${typesSummary}. Would you like me to open Spaces?`,
      needsInput: {
        prompt: "Say 'yes' or 'open' to view them.",
        agentId: this.id
      }
    };
  },

  /**
   * Create a new space
   */
  async _createSpace(task, onProgress) {
    const api = getSpacesAPI();
    if (!api) {
      return { success: false, message: 'Spaces is not available right now.' };
    }

    // Extract space name from the request
    const spaceName = this._extractSpaceName(task.content);

    if (!spaceName) {
      return {
        success: true,
        message: "What would you like to call the new space?",
        needsInput: {
          prompt: "Tell me the name for your new space.",
          agentId: this.id,
          context: { action: 'create-space' }
        }
      };
    }

    onProgress(`Creating space "${spaceName}"...`);

    try {
      // Check if space already exists
      const existingSpaces = await api.list();
      const existing = existingSpaces.find(s => 
        s.name.toLowerCase() === spaceName.toLowerCase()
      );

      if (existing) {
        return {
          success: true,
          message: `A space called "${existing.name}" already exists. Would you like me to open it?`,
          needsInput: {
            prompt: "Say 'yes' to open it, or give me a different name.",
            agentId: this.id
          }
        };
      }

      // Create the space
      const newSpace = await api.create(spaceName);

      // Track in memory
      const timestamp = new Date().toISOString().split('T')[0];
      this.memory.appendToSection('Recent Queries', `- ${timestamp}: Created space "${spaceName}"`, 20);
      await this.memory.save();

      return {
        success: true,
        message: `Done! I created a new space called "${newSpace.name}". Would you like me to open Spaces?`,
        data: {
          action: { type: 'open-spaces' },
          created: newSpace
        }
      };
    } catch (error) {
      log.error('agent', 'Create space error', { error });
      return {
        success: false,
        message: `Sorry, I couldn't create the space: ${error.message}`
      };
    }
  },

  /**
   * Handle create-space follow-up response (user providing space name)
   */
  async _handleCreateSpaceResponse(task, onProgress) {
    const api = getSpacesAPI();
    if (!api) {
      return { success: false, message: 'Spaces is not available right now.' };
    }

    // The user's response IS the space name
    const spaceName = (task.context?.userInput || task.content || '').trim();
    
    if (!spaceName || spaceName.length < 1) {
      return {
        success: true,
        message: "I didn't catch the name. What would you like to call the space?",
        needsInput: {
          prompt: "Tell me the name for your new space.",
          agentId: this.id,
          context: { action: 'create-space' }
        }
      };
    }

    onProgress(`Creating space "${spaceName}"...`);

    try {
      // Check if space already exists
      const existingSpaces = await api.list();
      const existing = existingSpaces.find(s => 
        s.name.toLowerCase() === spaceName.toLowerCase()
      );

      if (existing) {
        return {
          success: true,
          message: `A space called "${existing.name}" already exists. Would you like me to open it?`
        };
      }

      // Create the space
      const newSpace = await api.create(spaceName);

      // Track in memory
      const timestamp = new Date().toISOString().split('T')[0];
      this.memory.appendToSection('Recent Queries', `- ${timestamp}: Created space "${spaceName}"`, 20);
      await this.memory.save();

      return {
        success: true,
        message: `Done! I created a new space called "${newSpace.name}".`,
        data: {
          action: { type: 'open-spaces' },
          created: newSpace
        }
      };
    } catch (error) {
      log.error('agent', 'Create space error', { error });
      return {
        success: false,
        message: `Sorry, I couldn't create the space: ${error.message}`
      };
    }
  },

  /**
   * Handle add-note follow-up response (user providing note content)
   */
  async _handleAddNoteResponse(task, onProgress) {
    const api = getSpacesAPI();
    if (!api) {
      return { success: false, message: 'Spaces is not available right now.' };
    }

    // The user's response IS the note content
    const noteContent = (task.context?.userInput || task.content || '').trim();
    
    if (!noteContent || noteContent.length < 1) {
      return {
        success: true,
        message: "I didn't catch that. What would you like me to save?",
        needsInput: {
          prompt: "Tell me what to write in the note.",
          agentId: this.id,
          context: { action: 'add-note' }
        }
      };
    }

    onProgress('Saving your note...');

    try {
      // Save to the default "Unclassified" space
      const title = noteContent.slice(0, 50) + (noteContent.length > 50 ? '...' : '');
      
      await api.addItem('unclassified', {
        type: 'text',
        title: title,
        text: noteContent
      });

      // Track in memory
      const timestamp = new Date().toISOString().split('T')[0];
      this.memory.appendToSection('Recent Queries', `- ${timestamp}: Added note: "${title}"`, 20);
      await this.memory.save();

      return {
        success: true,
        message: `Done! I saved your note "${title}" to Unclassified.`
      };
    } catch (error) {
      log.error('agent', 'Add note error', { error });
      return {
        success: false,
        message: `Sorry, I couldn't save the note: ${error.message}`
      };
    }
  },

  /**
   * Add a note to Spaces
   */
  async _addNote(task, onProgress) {
    const api = getSpacesAPI();
    if (!api) {
      return { success: false, message: 'Spaces is not available right now.' };
    }

    // Extract note content from the request
    const noteContent = this._extractNoteContent(task.content);

    if (!noteContent) {
      return {
        success: true,
        message: "What would you like me to save?",
        needsInput: {
          prompt: "Tell me what to write in the note.",
          agentId: this.id,
          context: { action: 'add-note' }
        }
      };
    }

    onProgress('Saving note...');

    try {
      // Add to the default (unclassified) space
      const newItem = await api.items.add('unclassified', {
        type: 'text',
        content: noteContent,
        metadata: {
          title: noteContent.length > 50 ? noteContent.slice(0, 50) + '...' : noteContent,
          source: 'voice-assistant'
        }
      });

      // Track in memory
      const timestamp = new Date().toISOString().split('T')[0];
      const preview = noteContent.length > 30 ? noteContent.slice(0, 30) + '...' : noteContent;
      this.memory.appendToSection('Recent Queries', `- ${timestamp}: Added note "${preview}"`, 20);
      await this.memory.save();

      return {
        success: true,
        message: `Saved! I added your note to Spaces.`,
        data: {
          action: { type: 'open-spaces' },
          created: newItem
        }
      };
    } catch (error) {
      log.error('agent', 'Add note error', { error });
      return {
        success: false,
        message: `Sorry, I couldn't save the note: ${error.message}`
      };
    }
  },

  /**
   * List all spaces
   */
  async _listSpaces(task, onProgress) {
    const api = getSpacesAPI();
    if (!api) {
      return { success: false, message: 'Spaces is not available right now.' };
    }

    onProgress('Getting your spaces...');

    try {
      const spaces = await api.list();

      if (spaces.length === 0) {
        return {
          success: true,
          message: "You don't have any spaces yet. Would you like me to create one?"
        };
      }

      // Format for voice
      const spaceList = spaces
        .sort((a, b) => (b.itemCount || 0) - (a.itemCount || 0))
        .slice(0, 5)
        .map(s => `${s.name} with ${s.itemCount || 0} items`)
        .join(', ');

      const response = spaces.length <= 5
        ? `You have ${spaces.length} spaces: ${spaceList}.`
        : `You have ${spaces.length} spaces. The top ones are: ${spaceList}.`;

      return {
        success: true,
        message: response
      };
    } catch (error) {
      log.error('agent', 'List spaces error', { error });
      return {
        success: false,
        message: 'Sorry, I had trouble getting your spaces.'
      };
    }
  },

  /**
   * Extract space name from user input
   */
  _extractSpaceName(text) {
    const lower = text.toLowerCase();
    
    // Patterns like "create a space called X" or "new space named X"
    const patterns = [
      /(?:create|make|new)\s+(?:a\s+)?(?:space|folder)\s+(?:called|named|for)\s+["']?(.+?)["']?$/i,
      /(?:create|make|new)\s+(?:a\s+)?["']?(.+?)["']?\s+space/i,
      /(?:space|folder)\s+(?:called|named)\s+["']?(.+?)["']?$/i,
    ];

    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) {
        return match[1].trim().replace(/['"]/g, '');
      }
    }

    // Fallback: remove common words and see what's left
    const cleaned = lower
      .replace(/\b(create|make|new|a|space|folder|called|named|for|please|can you|could you)\b/gi, '')
      .trim();
    
    // Only return if it looks like a name (2+ chars, not just punctuation)
    if (cleaned.length >= 2 && /[a-z]/i.test(cleaned)) {
      // Capitalize first letter of each word
      return cleaned.split(/\s+/)
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
    }

    return null;
  },

  /**
   * Extract note content from user input
   */
  _extractNoteContent(text) {
    // Patterns like "add note: X" or "save note saying X" or "remember that X"
    const patterns = [
      /(?:add|save|create)\s+(?:a\s+)?note[:\s]+["']?(.+?)["']?$/i,
      /(?:add|save|create)\s+(?:a\s+)?note\s+(?:saying|that)\s+["']?(.+?)["']?$/i,
      /(?:remember|note)\s+(?:that\s+)?["']?(.+?)["']?$/i,
      /(?:save|add)\s+["']?(.+?)["']?\s+(?:as\s+a\s+)?note/i,
    ];

    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) {
        return match[1].trim().replace(/['"]/g, '');
      }
    }

    // Fallback: if it's "add note X" or "save X", extract what follows the action
    const fallbackMatch = text.match(/(?:add|save|note|remember)[:\s]+(.{5,})/i);
    if (fallbackMatch) {
      const content = fallbackMatch[1].trim();
      // Make sure it's not just "a note" or similar
      if (!content.match(/^(a\s+)?note$/i)) {
        return content;
      }
    }

    return null;
  },

  // ==================== HELPER METHODS ====================

  /**
   * Get recent items within a time period
   */
  async _getRecentItems(periodMs) {
    const api = getSpacesAPI();
    if (!api) return [];

    try {
      // Get all spaces
      const spaces = await api.list();
      const allItems = [];

      // Get items from each space
      for (const space of spaces) {
        const items = await api.items.list(space.id, { limit: 100 });
        allItems.push(...items);
      }

      // Filter by time
      const cutoff = Date.now() - periodMs;
      return allItems.filter(item => item.timestamp >= cutoff)
        .sort((a, b) => b.timestamp - a.timestamp);
    } catch (error) {
      log.error('agent', 'Error getting recent items', { error });
      return [];
    }
  },

  /**
   * Get all items
   */
  async _getAllItems() {
    const api = getSpacesAPI();
    if (!api) return [];

    try {
      const spaces = await api.list();
      const allItems = [];

      for (const space of spaces) {
        const items = await api.items.list(space.id, { limit: 1000 });
        allItems.push(...items);
      }

      return allItems;
    } catch (error) {
      log.error('agent', 'Error getting all items', { error });
      return [];
    }
  },

  /**
   * Get pinned items
   */
  async _getPinnedItems() {
    const api = getSpacesAPI();
    if (!api) return [];

    try {
      const spaces = await api.list();
      const pinned = [];

      for (const space of spaces) {
        const items = await api.items.list(space.id, { pinned: true });
        pinned.push(...items);
      }

      return pinned;
    } catch (error) {
      log.error('agent', 'Error getting pinned items', { error });
      return [];
    }
  },

  /**
   * Get all spaces
   */
  async _getSpaces() {
    const api = getSpacesAPI();
    if (!api) return [];

    try {
      return await api.list();
    } catch (error) {
      log.error('agent', 'Error getting spaces', { error });
      return [];
    }
  },

  /**
   * Group items by type
   */
  _groupByType(items) {
    const byType = {};
    items.forEach(item => {
      const type = item.type || 'other';
      byType[type] = byType[type] || [];
      byType[type].push(item);
    });
    return byType;
  },

  /**
   * Format items for LLM summarization
   */
  _formatItemsForLLM(recentItems, pinnedItems, spaces) {
    const byType = this._groupByType(recentItems);

    // Get type summary
    const typeSummary = {};
    for (const [type, items] of Object.entries(byType)) {
      typeSummary[type] = {
        count: items.length,
        samples: items.slice(0, 3).map(i => ({
          preview: (i.preview || i.title || '').slice(0, 80),
          tags: i.tags || []
        }))
      };
    }

    return {
      totalRecentCount: recentItems.length,
      pinnedCount: pinnedItems.length,
      spacesCount: spaces.length,
      byType: typeSummary,
      timeRange: '24 hours',
      pinnedHighlights: pinnedItems.slice(0, 3).map(p => 
        (p.title || p.preview || 'Untitled').slice(0, 50)
      )
    };
  },

  /**
   * Generate smart summary using LLM
   */
  async _generateSummary(itemsData, userQuery) {
    if (itemsData.totalRecentCount === 0) {
      return "Opening Spaces. Nothing new in the last 24 hours.";
    }

    try {
      const prompt = `You are a helpful assistant summarizing the user's saved content when they open their Spaces app.

USER'S SAVED CONTENT (last ${itemsData.timeRange}):
- New items: ${itemsData.totalRecentCount}
- Pinned items: ${itemsData.pinnedCount}
- Total spaces: ${itemsData.spacesCount}
- By type: ${JSON.stringify(itemsData.byType)}
${itemsData.pinnedHighlights.length > 0 ? `- Pinned highlights: ${itemsData.pinnedHighlights.join(', ')}` : ''}

USER SAID: "${userQuery}"

Generate a brief, natural summary (1-2 sentences max) for voice output. Start with "Opening Spaces." then mention what's interesting. Examples:
- "Opening Spaces. You saved 5 items today, mostly screenshots from your coding session."
- "Opening Spaces. Busy day with 12 new items including code snippets and meeting notes."
- "Opening Spaces. Just one new text note since yesterday."

Be conversational and brief. Don't list everything - pick the most interesting pattern.`;

      const result = await ai.chat({
        profile: 'fast',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.7,
        maxTokens: 100,
        feature: 'spaces-agent'
      });

      return result.content?.trim() || this._generateSimpleSummary(itemsData);
    } catch (error) {
      log.error('agent', 'LLM error', { error });
      return this._generateSimpleSummary(itemsData);
    }
  },

  /**
   * Generate simple summary without LLM
   */
  _generateSimpleSummary(itemsData) {
    if (itemsData.totalRecentCount === 0) {
      return "Opening Spaces. No new items in the last 24 hours.";
    }

    const types = Object.entries(itemsData.byType)
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 2)
      .map(([type, data]) => `${data.count} ${type}${data.count > 1 ? 's' : ''}`)
      .join(' and ');

    return `Opening Spaces. You have ${itemsData.totalRecentCount} new items today, including ${types}.`;
  },

  /**
   * Extract search query from user input
   */
  _extractSearchQuery(text) {
    const lower = text.toLowerCase();
    
    // Common patterns
    const patterns = [
      /(?:find|search|look for|search for)\s+(?:my\s+)?(?:notes?\s+)?(?:about\s+)?["']?(.+?)["']?$/i,
      /(?:find|search)\s+(.+?)\s+(?:in\s+)?(?:my\s+)?spaces/i,
      /(?:where|what)\s+(?:is|are)\s+(?:my\s+)?(.+)/i,
    ];

    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) {
        return match[1].trim().replace(/['"]/g, '');
      }
    }

    // Fallback: remove common words
    return lower
      .replace(/\b(find|search|look|for|in|my|spaces|clipboard|notes?|items?|the|about)\b/gi, '')
      .trim();
  },

  /**
   * Format search results for voice
   */
  _formatSearchResults(results, query) {
    if (results.length === 1) {
      const item = results[0];
      const itemDesc = item.title || item.preview?.slice(0, 50) || item.type;
      return `Found one item matching "${query}": ${itemDesc}. Opening Spaces to show you.`;
    }

    // Group by type
    const byType = this._groupByType(results);
    const typeParts = Object.entries(byType)
      .map(([type, items]) => `${items.length} ${type}${items.length > 1 ? 's' : ''}`)
      .join(', ');

    return `Found ${results.length} items matching "${query}": ${typeParts}. Opening Spaces to show you.`;
  },

  /**
   * Format time-based query response
   */
  _formatTimeQueryResponse(items, periodName) {
    if (items.length === 0) {
      return {
        success: true,
        message: `You didn't save anything ${periodName}.`
      };
    }

    const byType = this._groupByType(items);
    const typeParts = Object.entries(byType)
      .sort((a, b) => b[1].length - a[1].length)
      .map(([type, typeItems]) => `${typeItems.length} ${type}${typeItems.length > 1 ? 's' : ''}`)
      .join(', ');

    const verb = periodName === 'today' ? 'saved' : 'saved';
    
    return {
      success: true,
      message: `${periodName === 'today' ? 'Today' : periodName.charAt(0).toUpperCase() + periodName.slice(1)} you ${verb} ${items.length} items: ${typeParts}. Want me to open Spaces?`,
      needsInput: {
        prompt: "Say 'yes' or 'open' to view them.",
        agentId: this.id
      }
    };
  }
};

module.exports = spacesAgent;
