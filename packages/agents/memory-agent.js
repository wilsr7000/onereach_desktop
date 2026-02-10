/**
 * Memory Management Agent - Cross-Agent Memory Orchestrator
 *
 * Central authority for ALL agent memory in the system. Uses Claude 4.6 Opus
 * (powerful profile with adaptive thinking) to reason about what to update.
 *
 * On every request, this agent:
 *   1. Loads the global user profile (Identity, Locations, Preferences, Key Facts)
 *   2. Loads ALL agent memory files (weather, calendar, daily-brief, DJ, etc.)
 *   3. Sends everything to 4.6 Opus with the user's request
 *   4. Opus decides which memories need to change and what the changes are
 *   5. Applies targeted edits to each relevant agent memory + user profile
 *
 * Handles requests like:
 *   - "My name is Robb" -> updates user profile AND every agent that references the name
 *   - "I moved to Portland" -> updates profile, weather agent home location, calendar timezone, etc.
 *   - "I prefer dark roast coffee" -> stores in appropriate agent memory
 *   - "What do you know about me?" -> reads all memories and synthesizes a comprehensive view
 *   - "Forget my home address" -> removes from profile and any agent that stored it
 *   - "I like my daily brief shorter" -> updates daily-brief-agent preferences
 *
 * Works with:
 *   - lib/user-profile-store.js (global cross-agent user profile)
 *   - lib/agent-memory-store.js (per-agent memory files)
 */

const { getUserProfile } = require('../../lib/user-profile-store');
const { getAgentMemory, listAgentMemories } = require('../../lib/agent-memory-store');
const ai = require('../../lib/ai-service');
const { getLogQueue } = require('../../lib/log-event-queue');
const log = getLogQueue();

// Maximum characters of agent memory context to include per agent
const MAX_MEMORY_CHARS_PER_AGENT = 2000;
// Maximum total characters for all agent memories combined
const MAX_TOTAL_MEMORY_CHARS = 30000;

// Dependency injection for testing -- override with _setDeps()
let _deps = {
  getUserProfile,
  getAgentMemory,
  listAgentMemories,
  aiJson: (prompt, opts) => ai.json(prompt, opts),
};

const memoryAgent = {
  id: 'memory-agent',
  name: 'Memory Manager',
  description: 'Central memory orchestrator -- manages what the app remembers about you across ALL agents. View, correct, update, or delete personal facts and preferences anywhere in the system.',
  voice: 'ash',

  categories: ['system', 'settings', 'profile', 'memory', 'preferences'],

  prompt: `Memory Manager is the central authority for ALL stored memory in the app. It manages the global user profile AND per-agent memories across every agent in the system.

HIGH CONFIDENCE (0.85+) for:
- Viewing profile: "What do you know about me?", "Show my profile", "What's my name?"
- Corrections: "My name is Robb", "That's wrong", "My name is not Isaac"
- Updates: "I moved to San Francisco", "Change my timezone", "I prefer Celsius"
- Deletions: "Forget my address", "Remove my work location", "Clear my profile"
- General memory: "What have you learned about me?", "Show my preferences"
- Agent-specific preferences: "Make my daily brief shorter", "Always use Berkeley for weather"
- Cross-agent corrections: "Stop calling me Isaac everywhere", "Update my city in all agents"

MEDIUM CONFIDENCE (0.50-0.70) for:
- Ambiguous identity statements: "I'm Richard" (could be greeting or correction)
- Preference statements without explicit "remember": "I like dark mode"

LOW CONFIDENCE (0.00-0.20) - DO NOT BID:
- Greetings: "Hi", "Hello" (smalltalk-agent)
- Calendar/weather/time queries
- App features or settings (app-agent)
- Playing music, sending emails, or any action unrelated to personal memory

This agent is the ONLY agent that should modify the user profile store or any agent's memory.
If the user says something is wrong about their profile or any agent's behavior, this agent handles it.`,

  keywords: [
    'my name is', 'call me', 'i am', "i'm called",
    'what do you know', 'what do you remember', 'show my profile',
    'forget', 'remove', 'delete', 'clear',
    'correct', 'wrong', 'not my name', 'that is wrong', "that's wrong",
    'change my', 'update my', 'set my',
    'my home', 'my work', 'my address', 'my city', 'my timezone',
    'i moved', 'i live in', 'i prefer',
    'remember that', 'remember my', 'don\'t forget',
    'what is my name', 'who am i', 'my preferences',
    'profile', 'personal info', 'about me',
    'brief preference', 'weather location', 'agent memory',
  ],

  executionType: 'action',
  estimatedExecutionMs: 10000,
  dataSources: ['user-profile-store', 'agent-memory-store'],

  // Memory instance (for agent-specific memory, e.g. change log)
  memory: null,

  /**
   * Override dependencies for testing.
   * Pass an object with any of: getUserProfile, getAgentMemory, listAgentMemories, aiJson
   */
  _setDeps(overrides) {
    _deps = { ..._deps, ...overrides };
  },

  /**
   * Initialize agent memory
   */
  async initialize() {
    if (!this.memory) {
      this.memory = _deps.getAgentMemory('memory-agent', { displayName: 'Memory Manager' });
      await this.memory.load();
      this._ensureMemorySections();
    }
    return this.memory;
  },

  /**
   * Ensure memory sections exist
   */
  _ensureMemorySections() {
    const sections = this.memory.getSectionNames();

    if (!sections.includes('Change Log')) {
      this.memory.updateSection('Change Log', '*No changes yet.*');
    }
    if (!sections.includes('Deleted Facts')) {
      this.memory.updateSection('Deleted Facts', '*No deletions yet.*');
    }
    if (this.memory.isDirty()) {
      this.memory.save();
    }
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // CONTEXT GATHERING: Load all agent memories and user profile
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Load the global user profile as a formatted string.
   * @returns {Promise<{factsStr: string, profile: Object}>}
   */
  async _loadUserProfile() {
    const profile = _deps.getUserProfile();
    if (!profile.isLoaded()) await profile.load();
    const currentFacts = profile.getFacts();

    const factsStr = Object.entries(currentFacts)
      .filter(([_, v]) => v && !v.includes('not yet learned') && !v.startsWith('*'))
      .map(([k, v]) => `  ${k}: ${v}`)
      .join('\n');

    return { factsStr, profile, currentFacts };
  },

  /**
   * Load ALL agent memory files and build a context map.
   * Skips the memory-agent's own memory (we don't edit ourselves).
   * Truncates large memories to stay within token budget.
   *
   * @returns {Promise<Map<string, {raw: string, memory: Object}>>}
   */
  async _loadAllAgentMemories() {
    const agentMemories = new Map();
    let totalChars = 0;

    try {
      const agentIds = _deps.listAgentMemories();
      log.info('agent', '[MemoryAgent] Discovered agent memories', { count: agentIds.length, ids: agentIds });

      for (const agentId of agentIds) {
        // Skip our own memory and the user profile (handled separately)
        if (agentId === 'memory-agent' || agentId === 'user-profile') continue;

        try {
          const mem = _deps.getAgentMemory(agentId);
          await mem.load();
          let raw = mem.getRaw() || '';

          // Strip duplicate headers (some files have repeated "# Agent Memory" lines)
          const lines = raw.split('\n');
          const firstContentIdx = lines.findIndex((l, i) => i > 0 && !l.startsWith('# ') && l.trim() !== '');
          if (firstContentIdx > 1) {
            raw = lines.slice(firstContentIdx - 1).join('\n');
          }

          // Truncate to per-agent limit
          if (raw.length > MAX_MEMORY_CHARS_PER_AGENT) {
            raw = raw.slice(0, MAX_MEMORY_CHARS_PER_AGENT) + '\n... (truncated)';
          }

          // Check total budget
          if (totalChars + raw.length > MAX_TOTAL_MEMORY_CHARS) {
            log.info('agent', '[MemoryAgent] Total memory budget reached, stopping', { loaded: agentMemories.size });
            break;
          }

          agentMemories.set(agentId, { raw, memory: mem });
          totalChars += raw.length;
        } catch (e) {
          log.info('agent', `[MemoryAgent] Skipped ${agentId}`, { reason: e.message });
        }
      }
    } catch (e) {
      log.error('agent', '[MemoryAgent] Failed to list agent memories', { error: e.message });
    }

    log.info('agent', '[MemoryAgent] Loaded agent memories', {
      count: agentMemories.size,
      totalChars,
      agents: [...agentMemories.keys()],
    });

    return agentMemories;
  },

  /**
   * Format all agent memories into a string block for the LLM prompt.
   */
  _formatAgentMemories(agentMemories) {
    if (agentMemories.size === 0) return '(no agent memories found)';

    const parts = [];
    for (const [agentId, { raw }] of agentMemories) {
      parts.push(`=== ${agentId} ===\n${raw}`);
    }
    return parts.join('\n\n');
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // EXECUTION: Analyze with Opus and apply changes
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Execute a memory management request.
   *
   * Pipeline:
   *   1. Load user profile + all agent memories
   *   2. Send to 4.6 Opus with adaptive thinking
   *   3. Opus returns a structured plan: profile changes + per-agent changes
   *   4. Apply all changes, save, and log
   */
  async execute(task) {
    const content = (task.content || '').trim();
    if (!content) {
      return { success: false, message: 'I didn\'t catch that. What would you like to know or change about your memory?' };
    }

    // Initialize our own memory (for change log)
    if (!this.memory) await this.initialize();

    try {
      // 1. Load everything
      const { factsStr, profile, currentFacts } = await this._loadUserProfile();
      const agentMemories = await this._loadAllAgentMemories();
      const agentMemoryContext = this._formatAgentMemories(agentMemories);

      // Conversation history for context
      const conversationText = (task.conversationHistory || [])
        .map(m => `${m.role}: ${m.content}`)
        .join('\n')
        .slice(-800);

      // 2. Send to 4.6 Opus with adaptive thinking
      const interpretation = await _deps.aiJson(
        `You are the Memory Orchestrator for a personal assistant app. You have access to the user's global profile AND every agent's individual memory file. Your job is to analyze the user's request and determine what needs to change -- across the ENTIRE system, not just one place.

═══════════════════════════════════════
GLOBAL USER PROFILE
═══════════════════════════════════════
${factsStr || '(empty -- nothing learned yet)'}

═══════════════════════════════════════
AGENT MEMORIES (one block per agent)
═══════════════════════════════════════
${agentMemoryContext}

═══════════════════════════════════════
CONVERSATION CONTEXT
═══════════════════════════════════════
${conversationText || '(none)'}

═══════════════════════════════════════
USER REQUEST: "${content}"
═══════════════════════════════════════

Think carefully about this request. Consider:
- Does this affect the user profile? (Name, location, preferences, etc.)
- Does this affect any agent memories? (Weather home location, daily brief style, DJ preferences, calendar settings, etc.)
- If the user changes their name or city, which agents stored the old value?
- If the user wants to see what's stored, synthesize info from ALL sources.

Return JSON:
{
  "action": "view" | "update" | "delete" | "clear_all",
  "response": "Natural language response to the user confirming what you did or showing what you found",
  "profileChanges": {
    "facts": { "Key": "Value", ... },
    "deleteKeys": ["key1", "key2"]
  },
  "agentChanges": [
    {
      "agentId": "weather-agent",
      "reason": "User changed home city",
      "sectionUpdates": {
        "Learned Preferences": "- Home Location: Portland",
        "Favorite Locations": "- Home: Portland"
      }
    }
  ]
}

Rules:
- "action": "view" -- User wants to see what's stored. Read ALL memories and synthesize.
  The response should be a comprehensive, friendly summary of everything known about the user.
  List the global profile facts AND any per-agent preferences that are relevant.
  Set profileChanges.facts={}, profileChanges.deleteKeys=[], agentChanges=[].

- "action": "update" -- User is providing or correcting information.
  Put global profile changes in profileChanges.facts (keys capitalized: "Name", "Home City").
  Put per-agent changes in agentChanges with the exact section name and new section content.
  IMPORTANT: For sectionUpdates, provide the COMPLETE new content for that section (not a diff).
  Only include agents that actually need to change.

- "action": "delete" -- User wants to forget something.
  Put profile keys to remove in profileChanges.deleteKeys.
  For agent memories, provide sectionUpdates with the key removed.

- "action": "clear_all" -- Only if user EXPLICITLY asks to wipe everything.

- If the user changes their name, city, or other identity info, check EVERY agent memory
  for references to the old value and update them all.
- If the user says "my name is X" and the current Name is different, that's an update+correction.
- Be thorough: if the user says "I moved to Portland", update the profile Home City,
  the weather agent's Home Location, and any other agent that has a location reference.
- NEVER invent agent memories that don't exist. Only modify agents you can see above.
- If an agent's memory has no relevant content, do NOT include it in agentChanges.`,
        {
          profile: 'standard',
          system: 'You are the central memory orchestrator. Analyze all agent memories and the user profile to determine what needs to change. Return valid JSON only.',
          temperature: 0.1,
          maxTokens: 4000,
          feature: 'memory-agent-orchestrator'
        }
      );

      if (!interpretation || !interpretation.action) {
        return { success: false, message: 'I couldn\'t understand that request. Try "what do you know about me?" or "my name is ..."' };
      }

      const { action, response, profileChanges, agentChanges } = interpretation;
      const timestamp = new Date().toISOString();
      const allChanges = [];

      // 3. Apply changes based on action
      switch (action) {
        case 'view':
          log.info('agent', '[MemoryAgent] Full memory view requested');
          return { success: true, message: response };

        case 'update':
          // Apply user profile changes
          if (profileChanges?.facts && typeof profileChanges.facts === 'object') {
            for (const [key, value] of Object.entries(profileChanges.facts)) {
              if (value && String(value).trim()) {
                const oldValue = currentFacts[key] || '(not set)';
                profile.updateFact(key, String(value));
                allChanges.push(`[profile] ${key}: "${oldValue}" -> "${value}"`);
                log.info('agent', '[MemoryAgent] Updated profile fact', { key, old: oldValue, new: value });
              }
            }
            if (Object.keys(profileChanges.facts).length > 0) {
              await profile.save();
            }
          }

          // Apply per-agent memory changes
          if (Array.isArray(agentChanges)) {
            for (const change of agentChanges) {
              const agentData = agentMemories.get(change.agentId);
              if (!agentData) {
                log.info('agent', `[MemoryAgent] Skipping unknown agent: ${change.agentId}`);
                continue;
              }
              const mem = agentData.memory;
              if (change.sectionUpdates && typeof change.sectionUpdates === 'object') {
                for (const [section, newContent] of Object.entries(change.sectionUpdates)) {
                  const oldContent = mem.getSection(section) || '(empty)';
                  mem.updateSection(section, String(newContent));
                  allChanges.push(`[${change.agentId}] ${section}: updated (${change.reason || 'user request'})`);
                  log.info('agent', '[MemoryAgent] Updated agent memory', {
                    agentId: change.agentId, section, reason: change.reason,
                  });
                }
                mem.save();
              }
            }
          }

          if (allChanges.length > 0) {
            this._logChange(timestamp, 'update', allChanges);
          }
          log.info('agent', '[MemoryAgent] Cross-agent update complete', {
            profileChanges: Object.keys(profileChanges?.facts || {}).length,
            agentChanges: (agentChanges || []).length,
            totalChanges: allChanges.length,
          });
          return { success: true, message: response || `Updated ${allChanges.length} item(s) across the system.` };

        case 'delete':
          // Delete from user profile
          if (profileChanges?.deleteKeys && Array.isArray(profileChanges.deleteKeys)) {
            for (const key of profileChanges.deleteKeys) {
              const section = this._findFactSection(profile, key);
              if (section) {
                const sectionFacts = profile._store.parseSectionAsKeyValue(section);
                const oldValue = sectionFacts[key];
                if (oldValue) {
                  delete sectionFacts[key];
                  profile._store.updateSectionAsKeyValue(section, sectionFacts);
                  allChanges.push(`[profile] ${key}: "${oldValue}" (removed)`);
                  log.info('agent', '[MemoryAgent] Deleted profile fact', { key, old: oldValue });
                }
              }
            }
            if (profileChanges.deleteKeys.length > 0) {
              await profile.save();
              this._logDeletion(timestamp, profileChanges.deleteKeys, currentFacts);
            }
          }

          // Delete from agent memories
          if (Array.isArray(agentChanges)) {
            for (const change of agentChanges) {
              const agentData = agentMemories.get(change.agentId);
              if (!agentData) continue;
              const mem = agentData.memory;
              if (change.sectionUpdates && typeof change.sectionUpdates === 'object') {
                for (const [section, newContent] of Object.entries(change.sectionUpdates)) {
                  mem.updateSection(section, String(newContent));
                  allChanges.push(`[${change.agentId}] ${section}: cleaned (${change.reason || 'deletion'})`);
                }
                mem.save();
              }
            }
          }

          if (allChanges.length > 0) {
            this._logChange(timestamp, 'delete', allChanges);
          }
          return { success: true, message: response || `Removed ${allChanges.length} item(s).` };

        case 'clear_all':
          // Reset user profile
          profile._store.updateSection('Identity', '- Name: (not yet learned)');
          profile._store.updateSection('Locations', '- Home: (not yet learned)\n- Work: (not yet learned)');
          profile._store.updateSection('Preferences', '- Temperature Units: Fahrenheit\n- Time Format: 12-hour');
          profile._store.updateSection('Key Facts', '*No facts learned yet.*');
          await profile.save();

          // Reset all agent memories to their defaults (clear learned preferences)
          for (const [agentId, { memory: mem }] of agentMemories) {
            try {
              const sections = mem.getSectionNames();
              if (sections.includes('Learned Preferences')) {
                mem.updateSection('Learned Preferences', '*No preferences learned yet. The agent will update this section as it learns.*');
              }
              if (sections.includes('Recent History')) {
                mem.updateSection('Recent History', '*No history yet.*');
              }
              mem.save();
              allChanges.push(`[${agentId}] preferences and history cleared`);
            } catch (_) { /* non-critical */ }
          }

          this._logChange(timestamp, 'clear_all', ['Full system memory reset', ...allChanges]);
          log.info('agent', '[MemoryAgent] Full system memory cleared', { agentCount: allChanges.length });
          return { success: true, message: response || 'Your entire profile and all agent memories have been reset.' };

        default:
          return { success: false, message: 'I wasn\'t sure what to do. Try "show my profile" or "my name is ..."' };
      }
    } catch (err) {
      log.error('agent', '[MemoryAgent] Execution error', { error: err.message, stack: err.stack?.slice(0, 300) });
      return { success: false, message: 'Sorry, I had trouble managing your memory. Please try again.' };
    }
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // PASSIVE OBSERVATION: Watch conversations and learn automatically
  // ═══════════════════════════════════════════════════════════════════════════

  // Rate limiter state for passive observation
  _lastObservationTime: 0,
  _observationCooldownMs: 45000,  // 45s between observations
  _recentObservations: [],        // dedup buffer: last N observation signatures

  /**
   * Observe a completed conversation and automatically extract facts to store
   * in the right agent memories. Called after every successful task:settled.
   *
   * This replaces the old extractAndSaveUserFacts() which only updated the
   * user profile. Now Opus analyzes the interaction and routes facts to the
   * correct agent memories across the entire system.
   *
   * @param {Object} task - The completed task (content, metadata, conversationHistory)
   * @param {Object} result - The task result (success, message, output)
   * @param {string} agentId - The agent that handled the task
   * @returns {Promise<{learned: boolean, changes: string[]}>}
   */
  async observeConversation(task, result, agentId) {
    // ── Rate limit ───────────────────────────────────────────────────────
    const now = Date.now();
    if (now - this._lastObservationTime < this._observationCooldownMs) {
      return { learned: false, changes: [], reason: 'cooldown' };
    }

    // ── Skip trivial / failed interactions ───────────────────────────────
    const userMessage = (task?.content || '').trim();
    const agentResponse = (result?.output || result?.message || '').trim();
    if (userMessage.length < 8 || !result?.success) {
      return { learned: false, changes: [], reason: 'trivial' };
    }

    // Skip if the memory agent itself handled this (avoid recursion)
    if (agentId === 'memory-agent') {
      return { learned: false, changes: [], reason: 'self' };
    }

    // ── Dedup: skip if we just observed a very similar message ────────────
    const signature = `${userMessage.slice(0, 60).toLowerCase()}|${agentId}`;
    if (this._recentObservations.includes(signature)) {
      return { learned: false, changes: [], reason: 'dedup' };
    }
    this._recentObservations.push(signature);
    if (this._recentObservations.length > 20) this._recentObservations.shift();

    this._lastObservationTime = now;

    // ── Initialize own memory if needed ──────────────────────────────────
    if (!this.memory) {
      try { await this.initialize(); } catch (_) { /* non-critical */ }
    }

    try {
      // 1. Load all context
      const { factsStr, profile, currentFacts } = await this._loadUserProfile();
      const agentMemories = await this._loadAllAgentMemories();
      const agentMemoryContext = this._formatAgentMemories(agentMemories);

      // 2. Ask Opus to analyze the conversation for learnable information
      const analysis = await _deps.aiJson(
        `You are the Memory Watcher for a personal assistant app. You passively observe completed conversations between the user and various agents, and decide if anything is worth remembering.

═══════════════════════════════════════
CURRENT USER PROFILE
═══════════════════════════════════════
${factsStr || '(empty)'}

═══════════════════════════════════════
ALL AGENT MEMORIES
═══════════════════════════════════════
${agentMemoryContext}

═══════════════════════════════════════
CONVERSATION JUST COMPLETED
═══════════════════════════════════════
Agent: ${agentId}
User said: "${userMessage}"
Agent responded: "${agentResponse.slice(0, 500)}"

═══════════════════════════════════════

Analyze this conversation. Is there anything worth remembering? Consider:
- Did the user reveal personal info? (name, location, preferences, schedule patterns)
- Did the user express a preference that an agent should remember? (brief style, music genre, weather location, time format)
- Did the user correct something? (wrong name, wrong city, wrong assumption)
- Is there a pattern emerging? (always asks for weather in morning, prefers short answers)
- Did the agent learn something that OTHER agents should also know?

IMPORTANT:
- Only extract facts that are CLEARLY stated or STRONGLY implied. Do NOT guess.
- Do NOT repeat facts already in the user profile or agent memories above.
- If the conversation is routine (weather check, time check, simple Q&A with no personal info), return shouldUpdate: false.
- Be conservative. It's better to miss a fact than to store wrong information.

Return JSON:
{
  "shouldUpdate": true | false,
  "reasoning": "Brief explanation of why or why not",
  "profileChanges": {
    "facts": { "Key": "Value", ... }
  },
  "agentChanges": [
    {
      "agentId": "weather-agent",
      "reason": "User mentioned they moved to Portland",
      "sectionUpdates": {
        "Learned Preferences": "- Home Location: Portland"
      }
    }
  ]
}

If nothing new to learn, return: { "shouldUpdate": false, "reasoning": "...", "profileChanges": { "facts": {} }, "agentChanges": [] }`,
        {
          profile: 'fast',
          thinking: false,
          system: 'You analyze conversations to extract learnable facts. Return valid JSON only. Be conservative -- only extract clearly stated facts.',
          temperature: 0.1,
          maxTokens: 1000,
          feature: 'memory-agent-observer'
        }
      );

      if (!analysis || !analysis.shouldUpdate) {
        log.info('agent', '[MemoryAgent:Observer] Nothing to learn', {
          agentId,
          reasoning: analysis?.reasoning?.slice(0, 100) || 'no analysis',
        });
        return { learned: false, changes: [], reason: analysis?.reasoning || 'nothing new' };
      }

      // 3. Apply changes
      const allChanges = [];
      const timestamp = new Date().toISOString();

      // Profile changes
      if (analysis.profileChanges?.facts && typeof analysis.profileChanges.facts === 'object') {
        const newFacts = analysis.profileChanges.facts;
        const newKeys = Object.keys(newFacts).filter(k => newFacts[k] && String(newFacts[k]).trim());
        if (newKeys.length > 0) {
          for (const [key, value] of Object.entries(newFacts)) {
            if (value && String(value).trim()) {
              const oldValue = currentFacts[key] || '(not set)';
              // Skip if identical to existing
              if (currentFacts[key] === value) continue;
              profile.updateFact(key, String(value));
              allChanges.push(`[profile] ${key}: "${oldValue}" -> "${value}"`);
            }
          }
          if (allChanges.length > 0) {
            await profile.save();
          }
        }
      }

      // Agent memory changes
      if (Array.isArray(analysis.agentChanges)) {
        for (const change of analysis.agentChanges) {
          const agentData = agentMemories.get(change.agentId);
          if (!agentData) continue;
          const mem = agentData.memory;
          if (change.sectionUpdates && typeof change.sectionUpdates === 'object') {
            for (const [section, newContent] of Object.entries(change.sectionUpdates)) {
              const existing = mem.getSection(section) || '';
              // Skip if section content is unchanged
              if (existing.trim() === String(newContent).trim()) continue;
              mem.updateSection(section, String(newContent));
              allChanges.push(`[${change.agentId}] ${section}: updated (${change.reason || 'observed'})`);
            }
            if (allChanges.some(c => c.startsWith(`[${change.agentId}]`))) {
              mem.save();
            }
          }
        }
      }

      if (allChanges.length > 0) {
        this._logChange(timestamp, 'observe', allChanges);
        log.info('agent', '[MemoryAgent:Observer] Learned from conversation', {
          agentId,
          changes: allChanges.length,
          details: allChanges,
        });
      }

      return { learned: allChanges.length > 0, changes: allChanges };
    } catch (err) {
      log.warn('agent', '[MemoryAgent:Observer] Error during observation', { error: err.message });
      return { learned: false, changes: [], reason: err.message };
    }
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // HELPERS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Find which section a fact key lives in within the user profile.
   * @private
   */
  _findFactSection(profile, key) {
    for (const section of ['Identity', 'Locations', 'Preferences', 'Key Facts']) {
      const facts = profile._store.parseSectionAsKeyValue(section);
      if (facts && key in facts) return section;
    }
    return null;
  },

  /**
   * Log a change to agent memory for audit trail.
   * @private
   */
  _logChange(timestamp, action, changes) {
    if (!this.memory) return;
    try {
      const current = this.memory.getSection('Change Log') || '';
      const entry = `- [${timestamp.slice(0, 16)}] ${action}: ${changes.join('; ')}`;
      const lines = current.startsWith('*') ? [entry] : [entry, ...current.split('\n').slice(0, 29)];
      this.memory.updateSection('Change Log', lines.join('\n'));
      this.memory.save();
    } catch (_) { /* non-critical */ }
  },

  /**
   * Log deletions so they can be reviewed.
   * @private
   */
  _logDeletion(timestamp, keys, previousFacts) {
    if (!this.memory) return;
    try {
      const current = this.memory.getSection('Deleted Facts') || '';
      const entries = keys
        .filter(k => previousFacts[k])
        .map(k => `- [${timestamp.slice(0, 16)}] ${k}: "${previousFacts[k]}"`);
      if (entries.length === 0) return;
      const lines = current.startsWith('*') ? entries : [...entries, ...current.split('\n').slice(0, 29)];
      this.memory.updateSection('Deleted Facts', lines.join('\n'));
      this.memory.save();
    } catch (_) { /* non-critical */ }
  }
};

module.exports = memoryAgent;
