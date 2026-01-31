/**
 * Agent Memory Store
 * 
 * Provides persistent memory storage for agents.
 * Uses Spaces API directly so files appear in the GSX Agent space UI.
 * 
 * @module AgentMemoryStore
 */

const path = require('path');
const fs = require('fs');

// Memory store instances cache
const memoryInstances = new Map();

/**
 * Parse markdown into sections
 * @param {string} markdown - Raw markdown content
 * @returns {Map<string, string>} Section name -> content map
 */
function parseMarkdownSections(markdown) {
  const sections = new Map();
  if (!markdown) return sections;
  
  const lines = markdown.split('\n');
  let currentSection = '_header';
  let currentContent = [];
  
  for (const line of lines) {
    // Check for section headers (## Level 2 headers)
    const match = line.match(/^##\s+(.+)$/);
    if (match) {
      // Save previous section
      if (currentContent.length > 0 || currentSection !== '_header') {
        sections.set(currentSection, currentContent.join('\n').trim());
      }
      currentSection = match[1].trim();
      currentContent = [];
    } else {
      currentContent.push(line);
    }
  }
  
  // Save last section
  if (currentContent.length > 0) {
    sections.set(currentSection, currentContent.join('\n').trim());
  }
  
  return sections;
}

/**
 * Rebuild markdown from sections
 * @param {Map<string, string>} sections - Section name -> content map
 * @param {string} title - Document title
 * @returns {string} Markdown content
 */
function rebuildMarkdown(sections, title) {
  const lines = [];
  
  // Add title
  lines.push(`# ${title}`);
  lines.push('');
  
  // Add header section if exists (metadata block)
  if (sections.has('_header')) {
    lines.push(sections.get('_header'));
    lines.push('');
  }
  
  // Add all other sections
  for (const [name, content] of sections) {
    if (name === '_header') continue;
    lines.push(`## ${name}`);
    lines.push('');
    lines.push(content);
    lines.push('');
  }
  
  return lines.join('\n');
}

/**
 * Get Spaces storage instance
 */
function getStorage() {
  try {
    const { getSharedStorage } = require('../clipboard-storage-v2');
    return getSharedStorage();
  } catch (e) {
    console.error('[AgentMemory] Could not get Spaces storage:', e.message);
    return null;
  }
}

class AgentMemoryStore {
  /**
   * Create an agent memory store instance
   * @param {string} agentId - Unique agent identifier (e.g., 'dj-agent')
   * @param {Object} options - Configuration options
   * @param {string} options.displayName - Human-readable name for the memory file
   */
  constructor(agentId, options = {}) {
    this.agentId = agentId;
    this.displayName = options.displayName || this._formatDisplayName(agentId);
    this.itemId = `agent-memory-${agentId}`;
    this.memoryFileName = `${agentId}-memory.md`;
    
    // Cache for parsed content
    this._raw = null;
    this._sections = null;
    this._dirty = false;
    this._loaded = false;
  }
  
  /**
   * Format agent ID into display name
   * @private
   */
  _formatDisplayName(agentId) {
    return agentId
      .replace(/-/g, ' ')
      .replace(/\b\w/g, c => c.toUpperCase());
  }
  
  /**
   * Load memory from Spaces API
   * Creates the item if it doesn't exist
   * @returns {Promise<boolean>} True if loaded successfully
   */
  async load() {
    try {
      const storage = getStorage();
      if (!storage) {
        console.log('[AgentMemory] Spaces storage not available, using fallback');
        return this._loadFallback();
      }
      
      // Try to get existing item
      let existingItem = null;
      try {
        existingItem = storage.loadItem(this.itemId);
      } catch (loadErr) {
        console.log(`[AgentMemory] loadItem failed for ${this.agentId}, will create new:`, loadErr?.message || loadErr);
      }
      
      if (existingItem && existingItem.content) {
        // Load from existing item
        this._raw = existingItem.content || '';
        this._sections = parseMarkdownSections(this._raw);
        this._loaded = true;
        this._dirty = false;
        console.log(`[AgentMemory] Loaded memory for ${this.agentId} from Spaces`);
        return true;
      }
      
      // Create new item
      console.log(`[AgentMemory] Creating new memory for ${this.agentId}`);
      this._raw = this._createDefaultMemory();
      this._sections = parseMarkdownSections(this._raw);
      
      // Try to add to Spaces
      try {
        storage.addItem({
          id: this.itemId,
          type: 'text',
          content: this._raw,
          spaceId: 'gsx-agent',
          pinned: false,
          metadata: {
            name: this.memoryFileName,
            title: `${this.displayName} Memory`,
            description: `Memory and preferences for ${this.displayName} - you can edit this!`,
            category: 'agent-memory',
            agentId: this.agentId
          }
        });
        console.log(`[AgentMemory] Created memory item for ${this.agentId} in GSX Agent space`);
      } catch (addErr) {
        console.log(`[AgentMemory] Could not add to Spaces (non-fatal):`, addErr?.message || addErr);
      }
      
      this._loaded = true;
      this._dirty = false;
      return true;
      
    } catch (error) {
      console.error(`[AgentMemory] Error loading memory for ${this.agentId}:`, error?.message || error);
      return this._loadFallback();
    }
  }
  
  /**
   * Fallback loading from filesystem if Spaces API unavailable
   * @private
   */
  _loadFallback() {
    console.log(`[AgentMemory] Using fallback storage for ${this.agentId}`);
    this._raw = this._createDefaultMemory();
    this._sections = parseMarkdownSections(this._raw);
    this._loaded = true;
    this._dirty = false;
    return true;
  }
  
  /**
   * Create default memory content for a new agent
   * @private
   */
  _createDefaultMemory() {
    const now = new Date().toISOString();
    return `# ${this.displayName} Memory

> Last updated: ${now}

## About This Memory

This file stores learned preferences and context for the ${this.displayName}.
You can edit this file to adjust the agent's behavior.

## Learned Preferences

*No preferences learned yet. The agent will update this section as it learns.*

## Recent History

*No history yet.*

## User Notes

Add any custom preferences or notes here. The agent will respect these.
`;
  }
  
  /**
   * Save memory to Spaces API
   * @returns {Promise<boolean>} True if saved successfully
   */
  async save() {
    if (!this._dirty && this._loaded) {
      return true; // Nothing to save
    }
    
    try {
      // Update timestamp in header
      const now = new Date().toISOString();
      if (this._sections && this._sections.has('_header')) {
        let header = this._sections.get('_header');
        header = header.replace(/Last updated: .+/, `Last updated: ${now}`);
        this._sections.set('_header', header);
      }
      
      // Rebuild markdown
      this._raw = rebuildMarkdown(this._sections, `${this.displayName} Memory`);
      
      const storage = getStorage();
      if (!storage) {
        console.warn('[AgentMemory] Spaces storage not available for save');
        return false;
      }
      
      // Check if item exists
      const existingItem = storage.loadItem(this.itemId);
      
      if (existingItem) {
        // Update existing item using updateItemIndex with content
        storage.updateItemIndex(this.itemId, {
          content: this._raw,
          metadata: {
            name: this.memoryFileName,
            title: `${this.displayName} Memory`,
            description: `Memory and preferences for ${this.displayName} - you can edit this!`,
            category: 'agent-memory',
            agentId: this.agentId
          }
        });
        console.log(`[AgentMemory] Updated memory for ${this.agentId}`);
      } else {
        // Create new item
        storage.addItem({
          id: this.itemId,
          type: 'text',
          content: this._raw,
          spaceId: 'gsx-agent',
          pinned: false,
          metadata: {
            name: this.memoryFileName,
            title: `${this.displayName} Memory`,
            description: `Memory and preferences for ${this.displayName} - you can edit this!`,
            category: 'agent-memory',
            agentId: this.agentId
          }
        });
        console.log(`[AgentMemory] Created memory for ${this.agentId}`);
      }
      
      this._dirty = false;
      return true;
      
    } catch (error) {
      console.error(`[AgentMemory] Error saving memory for ${this.agentId}:`, error);
      return false;
    }
  }
  
  /**
   * Get a section from memory
   * @param {string} sectionName - Name of the section (e.g., "Learned Preferences")
   * @returns {string|null} Section content or null if not found
   */
  getSection(sectionName) {
    if (!this._loaded) {
      console.warn(`[AgentMemory] Memory not loaded for ${this.agentId}, call load() first`);
      return null;
    }
    
    return this._sections.get(sectionName) || null;
  }
  
  /**
   * Update a section in memory
   * @param {string} sectionName - Name of the section
   * @param {string} content - New content for the section
   */
  updateSection(sectionName, content) {
    if (!this._loaded) {
      console.warn(`[AgentMemory] Memory not loaded for ${this.agentId}, call load() first`);
      return;
    }
    
    this._sections.set(sectionName, content);
    this._dirty = true;
  }
  
  /**
   * Append to a section (e.g., for history logs)
   * @param {string} sectionName - Name of the section
   * @param {string} entry - Entry to append
   * @param {number} maxEntries - Maximum entries to keep (oldest removed first)
   */
  appendToSection(sectionName, entry, maxEntries = 50) {
    if (!this._loaded) {
      console.warn(`[AgentMemory] Memory not loaded for ${this.agentId}, call load() first`);
      return;
    }
    
    let content = this._sections.get(sectionName) || '';
    
    // Split into lines and add new entry
    let lines = content.split('\n').filter(l => l.trim());
    
    // Remove placeholder text if present
    if (lines.length === 1 && lines[0].startsWith('*No ')) {
      lines = [];
    }
    
    // Add new entry at the beginning (newest first)
    lines.unshift(entry);
    
    // Limit to maxEntries
    if (lines.length > maxEntries) {
      lines = lines.slice(0, maxEntries);
    }
    
    this._sections.set(sectionName, lines.join('\n'));
    this._dirty = true;
  }
  
  /**
   * Get raw markdown content
   * @returns {string} Raw markdown
   */
  getRaw() {
    return this._raw || '';
  }
  
  /**
   * Set raw markdown content (for user edits)
   * @param {string} markdown - New markdown content
   */
  setRaw(markdown) {
    this._raw = markdown;
    this._sections = parseMarkdownSections(markdown);
    this._dirty = true;
  }
  
  /**
   * Check if memory has unsaved changes
   * @returns {boolean}
   */
  isDirty() {
    return this._dirty;
  }
  
  /**
   * Check if memory is loaded
   * @returns {boolean}
   */
  isLoaded() {
    return this._loaded;
  }
  
  /**
   * Get the item ID for this memory
   * @returns {string}
   */
  getItemId() {
    return this.itemId;
  }
  
  /**
   * Get all section names
   * @returns {string[]}
   */
  getSectionNames() {
    if (!this._sections) return [];
    return Array.from(this._sections.keys()).filter(k => k !== '_header');
  }
  
  /**
   * Parse a key-value section (like preferences)
   * @param {string} sectionName - Name of the section
   * @returns {Object} Key-value pairs
   */
  parseSectionAsKeyValue(sectionName) {
    const content = this.getSection(sectionName);
    if (!content) return {};
    
    const result = {};
    const lines = content.split('\n');
    
    for (const line of lines) {
      // Match "- Key: Value" or "Key: Value"
      const match = line.match(/^-?\s*([^:]+):\s*(.+)$/);
      if (match) {
        const key = match[1].trim();
        const value = match[2].trim();
        result[key] = value;
      }
    }
    
    return result;
  }
  
  /**
   * Update a key-value section
   * @param {string} sectionName - Name of the section
   * @param {Object} keyValues - Key-value pairs to set
   */
  updateSectionAsKeyValue(sectionName, keyValues) {
    const lines = [];
    for (const [key, value] of Object.entries(keyValues)) {
      lines.push(`- ${key}: ${value}`);
    }
    this.updateSection(sectionName, lines.join('\n'));
  }
}

/**
 * Get or create an agent memory store instance
 * @param {string} agentId - Unique agent identifier
 * @param {Object} options - Configuration options
 * @returns {AgentMemoryStore}
 */
function getAgentMemory(agentId, options = {}) {
  if (!memoryInstances.has(agentId)) {
    const memory = new AgentMemoryStore(agentId, options);
    memoryInstances.set(agentId, memory);
  }
  return memoryInstances.get(agentId);
}

/**
 * List all agent memory files
 * @returns {string[]} Array of agent IDs that have memory files
 */
function listAgentMemories() {
  try {
    const storage = getStorage();
    if (!storage) return [];
    
    // Get all items in gsx-agent space with agent-memory category
    const items = storage.getSpaceItems('gsx-agent');
    return items
      .filter(item => item.metadata?.category === 'agent-memory' || item.id?.startsWith('agent-memory-'))
      .map(item => item.metadata?.agentId || item.id.replace('agent-memory-', ''));
  } catch (error) {
    console.error('[AgentMemory] Error listing memories:', error);
    return [];
  }
}

/**
 * Delete an agent's memory
 * @param {string} agentId - Agent ID
 * @returns {boolean} True if deleted
 */
function deleteAgentMemory(agentId) {
  try {
    const itemId = `agent-memory-${agentId}`;
    const storage = getStorage();
    if (storage) {
      storage.deleteItem(itemId);
    }
    memoryInstances.delete(agentId);
    console.log(`[AgentMemory] Deleted memory for ${agentId}`);
    return true;
  } catch (error) {
    console.error(`[AgentMemory] Error deleting memory for ${agentId}:`, error);
    return false;
  }
}

/**
 * Ensure memory exists for a list of agents
 * @param {Array<Object>} agents - Array of agent objects with id and name properties
 * @returns {Object} { created: string[], existing: string[], failed: string[] }
 */
async function ensureAgentMemories(agents) {
  const results = {
    created: [],
    existing: [],
    failed: []
  };
  
  for (const agent of agents) {
    try {
      const agentId = agent.id || agent;
      const displayName = agent.name || agent.displayName || null;
      
      const memory = getAgentMemory(agentId, displayName ? { displayName } : {});
      await memory.load();
      
      if (memory.isLoaded()) {
        results.existing.push(agentId);
      } else {
        results.failed.push(agentId);
      }
    } catch (error) {
      console.error(`[AgentMemory] Error ensuring memory for agent:`, error);
      results.failed.push(agent.id || agent);
    }
  }
  
  if (results.existing.length > 0) {
    console.log(`[AgentMemory] Loaded/created memories for: ${results.existing.join(', ')}`);
  }
  
  return results;
}

/**
 * Initialize memory files for built-in agents
 * Call this when the exchange/app starts up
 * @param {Array<Object>} builtInAgents - Array of built-in agent objects
 */
function initializeBuiltInAgentMemories(builtInAgents) {
  console.log(`[AgentMemory] Initializing memories for ${builtInAgents.length} built-in agents`);
  return ensureAgentMemories(builtInAgents);
}

module.exports = {
  AgentMemoryStore,
  getAgentMemory,
  listAgentMemories,
  deleteAgentMemory,
  ensureAgentMemories,
  initializeBuiltInAgentMemories
};
