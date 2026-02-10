/**
 * Email Agent - A Data-Aware Thinking Agent
 * 
 * An AI-powered email assistant that:
 * - Uses data-aware bidding - checks cached email state before bidding
 * - Background polls email every 5 minutes to keep cache fresh
 * - Uses semantic LLM understanding (no keywords/regex) for intent
 * - Handles compose, send, read, search, reply, and draft operations
 * - Learns user preferences over time (frequent contacts, signature, style)
 * 
 * NOTE: Email API methods are stubs until connected to a real email provider.
 */

const { getAgentMemory } = require('../../lib/agent-memory-store');
const { getTimeContext, learnFromInteraction } = require('../../lib/thinking-agent');
const { getCircuit } = require('./circuit-breaker');
const ai = require('../../lib/ai-service');
const { getLogQueue } = require('../../lib/log-event-queue');
const log = getLogQueue();

// Circuit breaker for AI calls
const emailCircuit = getCircuit('email-agent-ai', {
  failureThreshold: 3,
  resetTimeout: 30000,
  windowMs: 60000
});

// Polling configuration
const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * AI-driven email request understanding
 * Takes a raw user request and uses LLM to understand what they want
 * 
 * @param {string} userRequest - Raw user request text
 * @param {Object} context - { partOfDay, memory, emailSummary, conversationHistory }
 * @returns {Promise<Object>} - { action, parameters, message, needsClarification?, clarificationPrompt? }
 */
async function aiUnderstandEmailRequest(userRequest, context) {
  const { partOfDay, memory, emailSummary, conversationHistory } = context;

  const systemPrompt = `You are an AI assistant helping understand email requests. Interpret what the user wants to do.

CURRENT CONTEXT:
- Time of day: ${partOfDay}
- Current time: ${new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
- Email status: ${emailSummary || 'No email data available'}
${conversationHistory ? `- Recent conversation:\n${conversationHistory}` : ''}

USER PREFERENCES (from memory):
${memory || 'No preferences learned yet.'}

ACTIONS YOU CAN IDENTIFY:
- "check_inbox" - User wants to see recent/unread emails
- "check_urgent" - User wants to see urgent/important/flagged emails
- "compose" - User wants to write a new email
- "reply" - User wants to reply to an email
- "search" - User wants to find specific emails
- "send" - User wants to send an email
- "draft" - User wants to create/save a draft

Respond with JSON:
{
  "understood": true/false,
  "action": "check_inbox" | "check_urgent" | "compose" | "reply" | "search" | "send" | "draft" | "clarify",
  "parameters": {
    "to": "recipient if specified",
    "subject": "subject if specified",
    "query": "search query if searching",
    "count": number of emails to show (default 5)
  },
  "needsClarification": true/false,
  "clarificationPrompt": "Question to ask if clarification needed",
  "reasoning": "Brief explanation of understanding"
}

EXAMPLES:
- "check my email" → action: "check_inbox"
- "anything urgent?" → action: "check_urgent"
- "email John about the meeting" → action: "compose", parameters: { to: "John", subject: "meeting" }
- "find emails from Sarah" → action: "search", parameters: { query: "from:Sarah" }
- "what important emails do I have" → action: "check_urgent"`;

  const userPrompt = `User request: "${userRequest}"

What email action does the user want?`;

  try {
    const result = await emailCircuit.execute(async () => {
      return await ai.chat({
        profile: 'fast',
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
        temperature: 0.3,
        maxTokens: 300,
        jsonMode: true,
        feature: 'email-agent'
      });
    });
    
    const parsed = JSON.parse(result.content);
    log.info('agent', 'AI understood request', { reasoning: parsed.reasoning });
    
    return parsed;
    
  } catch (error) {
    log.warn('agent', 'AI understanding failed', { error: error.message });
    return null;
  }
}

const emailAgent = {
  id: 'email-agent',
  name: 'Email Assistant',
  description: 'Handles all email communications - check inbox, compose, send, search, and reply with data-aware bidding',
  voice: 'nova',  // Clear, professional - see VOICE-GUIDE.md
  acks: ["Checking your email.", "Let me look at your inbox."],
  categories: ['communication', 'email', 'messaging'],
  
  // Empty keywords - using semantic LLM prompts only (per project rules)
  keywords: [],
  executionType: 'action',  // Needs email API for data and sending
  estimatedExecutionMs: 5000,  // Email API polling
  dataSources: ['email-api'],
  
  /**
   * Briefing contribution: unread email summary.
   * Priority 4 = appears after calendar in the daily brief.
   */
  async getBriefing() {
    try {
      // Use cached email state if available (background polling keeps it fresh)
      const summary = this._cachedEmailSummary || null;
      if (summary) {
        return {
          section: 'Email',
          priority: 4,
          content: summary,
        };
      }
      // Try a quick inbox check
      const result = await this.execute({ content: 'check inbox summary', metadata: { briefingMode: true } });
      if (result && result.success && result.message) {
        return { section: 'Email', priority: 4, content: result.message };
      }
    } catch (e) {
      // Email unavailable
    }
    return { section: 'Email', priority: 4, content: null };
  },
  
  // Prompt for LLM evaluation (semantic, no keywords/regex)
  prompt: `Email Assistant handles ALL email communications with data-aware context.

HIGH CONFIDENCE (0.85+) for:
- Checking email: "check my email", "any new messages", "what emails do I have"
- Urgent/important: "anything urgent", "important emails", "priority messages"
- Composing: "email John", "send an email to", "write to"
- Reading: "read my emails", "show unread", "inbox"
- Searching: "find emails from", "search for emails about"
- Replying: "reply to", "respond to that email"
- Drafts: "save as draft", "create draft"

DATA-AWARE BIDDING:
This agent checks its email cache before bidding. If user asks "anything urgent?" and there ARE urgent emails in cache, confidence is HIGH. If no urgent emails, confidence is LOW (defer to other agents).

CRITICAL: Any request about email, inbox, messages, compose, send, or reply belongs to this agent.`,

  // Agent capabilities for display
  capabilities: [
    'Check inbox and unread count',
    'Find urgent/flagged emails',
    'Compose and send emails',
    'Search emails by sender, subject, or content',
    'Reply to emails',
    'Create and manage drafts',
    'Learn frequent contacts and preferences'
  ],
  
  // Memory instance
  memory: null,
  
  // ==================== DATA-AWARE BIDDING CACHE ====================
  
  // Cache for email state (updated every 5 min)
  _cache: {
    unreadCount: 0,
    urgentEmails: [],
    recentEmails: [],
    lastFetch: null
  },
  
  // Polling interval handle
  _pollInterval: null,
  
  /**
   * Initialize memory and start background polling
   */
  async initialize() {
    if (!this.memory) {
      this.memory = getAgentMemory('email-agent', { displayName: 'Email Assistant' });
      await this.memory.load();
      this._ensureMemorySections();
    }
    
    // Start background polling for data-aware bidding
    this._startPolling();
    
    return this.memory;
  },
  
  /**
   * Ensure required memory sections exist
   */
  _ensureMemorySections() {
    const sections = this.memory.getSectionNames();
    
    // Frequent Contacts
    if (!sections.includes('Frequent Contacts')) {
      this.memory.updateSection('Frequent Contacts', `*Will be populated as you use email*`);
    }
    
    // Email Preferences
    if (!sections.includes('Email Preferences')) {
      this.memory.updateSection('Email Preferences', `- Signature: Not set
- Default Response Style: Professional
- Priority Senders: None configured`);
    }
    
    // Templates
    if (!sections.includes('Templates')) {
      this.memory.updateSection('Templates', `*No templates saved yet*`);
    }
    
    // Recent Activity
    if (!sections.includes('Recent Activity')) {
      this.memory.updateSection('Recent Activity', `*No activity yet*`);
    }
    
    if (this.memory.isDirty()) {
      this.memory.save();
    }
  },
  
  // ==================== BACKGROUND POLLING ====================
  
  /**
   * Start background polling every 5 minutes
   */
  _startPolling() {
    if (this._pollInterval) {
      return; // Already running
    }
    
    log.info('agent', 'Starting background polling (every 5 minutes)');
    
    // Initial fetch
    this._refreshCache();
    
    // Poll every 5 minutes
    this._pollInterval = setInterval(() => {
      this._refreshCache();
    }, POLL_INTERVAL_MS);
  },
  
  /**
   * Stop background polling
   */
  _stopPolling() {
    if (this._pollInterval) {
      clearInterval(this._pollInterval);
      this._pollInterval = null;
      log.info('agent', 'Background polling stopped');
    }
  },
  
  /**
   * Refresh cache from email API
   */
  async _refreshCache() {
    try {
      log.info('agent', 'Refreshing email cache...');
      
      // Fetch email summary from API (stub for now)
      const summary = await this._tools.getEmailSummary();
      
      this._cache = {
        unreadCount: summary.unreadCount || 0,
        urgentEmails: summary.urgentEmails || [],
        recentEmails: summary.recentEmails || [],
        lastFetch: Date.now()
      };
      
      log.info('agent', `Cache updated: ${this._cache.unreadCount} unread, ${this._cache.urgentEmails.length} urgent`);
      
    } catch (error) {
      log.error('agent', 'Failed to refresh cache', { error: error.message });
      // Keep stale cache rather than clearing
    }
  },
  
  // No bid() method. Routing is 100% LLM-based via unified-bidder.js.
  // NEVER add keyword/regex bidding here. See .cursorrules.
  
  // ==================== EXECUTION ====================
  
  /**
   * Execute the email task with full agentic capabilities
   */
  async execute(task) {
    try {
      // Initialize memory if needed
      if (!this.memory) {
        await this.initialize();
      }
      
      const context = getTimeContext();
      const content = task.content || task.phrase || '';
      
      // ==================== MULTI-TURN STATE HANDLING ====================
      // Check if this is a follow-up response to a previous needsInput
      if (task.context?.originalRequest && task.context?.partialUnderstanding) {
        log.info('agent', 'Handling follow-up clarification');
        return this._handleClarificationResponse(task, context);
      }
      
      // Build context for AI understanding
      const aiContext = {
        partOfDay: context.partOfDay,
        memory: this.memory ? this._getMemoryContext() : null,
        emailSummary: this._buildEmailSummary(),
        conversationHistory: task.context?.conversationHistory || null
      };
      
      // Use AI to understand the request
      const aiResult = await aiUnderstandEmailRequest(content, aiContext);
      
      if (aiResult && !aiResult.needsClarification) {
        const result = await this._executeAction(aiResult);
        await this._learnFromInteraction(content, result, context);
        return result;
      }
      
      // Need clarification
      if (aiResult?.needsClarification) {
        return {
          success: true,
          needsInput: {
            prompt: aiResult.clarificationPrompt,
            agentId: this.id,
            context: {
              originalRequest: content,
              partialUnderstanding: aiResult
            }
          }
        };
      }
      
      // Fallback: simple response based on cache
      return this._fallbackResponse(content);
      
    } catch (error) {
      log.error('agent', 'Error', { error });
      return {
        success: false,
        message: "I couldn't access your email right now. The email service may not be connected."
      };
    }
  },
  
  /**
   * Handle clarification response - combine original request with user's clarification
   */
  async _handleClarificationResponse(task, context) {
    const userResponse = task.context?.userInput || task.content;
    const originalRequest = task.context?.originalRequest;
    const partialUnderstanding = task.context?.partialUnderstanding;
    
    log.info('agent', `Original: "${originalRequest}", Clarification: "${userResponse}"`);
    
    // Build context for AI understanding with combined info
    const aiContext = {
      partOfDay: context.partOfDay,
      memory: this.memory ? this._getMemoryContext() : null,
      emailSummary: this._buildEmailSummary(),
      conversationHistory: task.context?.conversationHistory || null
    };
    
    // Combine original request with clarification
    const combinedRequest = `${originalRequest}. User clarified: ${userResponse}`;
    
    // Re-process with the combined request
    const aiResult = await aiUnderstandEmailRequest(combinedRequest, aiContext);
    
    if (aiResult && !aiResult.needsClarification) {
      const result = await this._executeAction(aiResult);
      await this._learnFromInteraction(combinedRequest, result, context);
      return result;
    }
    
    // Still need more clarification
    if (aiResult?.needsClarification) {
      return {
        success: true,
        needsInput: {
          prompt: aiResult.clarificationPrompt,
          agentId: this.id,
          context: {
            originalRequest: combinedRequest,
            partialUnderstanding: aiResult
          }
        }
      };
    }
    
    // Fallback
    return this._fallbackResponse(userResponse);
  },
  
  /**
   * Execute based on AI understanding
   */
  async _executeAction(aiResult) {
    const { action, parameters } = aiResult;
    
    switch (action) {
      case 'check_inbox':
        return await this._checkInbox(parameters?.count || 5);
      
      case 'check_urgent':
        return await this._checkUrgent();
      
      case 'compose':
        return await this._composeEmail(parameters);
      
      case 'reply':
        return await this._replyToEmail(parameters);
      
      case 'search':
        return await this._searchEmails(parameters?.query);
      
      case 'send':
        return await this._sendEmail(parameters);
      
      case 'draft':
        return await this._createDraft(parameters);
      
      default:
        return await this._checkInbox(5);
    }
  },
  
  /**
   * Fallback response using cached data
   */
  _fallbackResponse(content) {
    const { unreadCount, urgentEmails } = this._cache;
    
    if (urgentEmails.length > 0) {
      return {
        success: true,
        message: `You have ${urgentEmails.length} urgent email${urgentEmails.length > 1 ? 's' : ''} and ${unreadCount} total unread. Email API not fully connected yet.`
      };
    }
    
    if (unreadCount > 0) {
      return {
        success: true,
        message: `You have ${unreadCount} unread email${unreadCount > 1 ? 's' : ''}. Email API not fully connected yet.`
      };
    }
    
    return {
      success: true,
      message: "Your inbox is clear. Email API not fully connected yet - connect your email provider in Settings."
    };
  },
  
  // ==================== EMAIL ACTIONS ====================
  
  /**
   * Check inbox
   */
  async _checkInbox(count = 5) {
    const emails = await this._tools.readEmails({ count, unreadOnly: false });
    
    if (!emails.connected) {
      return {
        success: true,
        message: "Email service not connected. Connect your email provider in Settings to enable inbox access."
      };
    }
    
    if (emails.emails.length === 0) {
      return {
        success: true,
        message: "Your inbox is empty - no recent emails."
      };
    }
    
    const summary = emails.emails.slice(0, count).map(e => 
      `"${e.subject}" from ${e.from}`
    ).join(', ');
    
    return {
      success: true,
      message: `You have ${emails.total} emails. Recent: ${summary}`
    };
  },
  
  /**
   * Check urgent emails
   */
  async _checkUrgent() {
    const urgent = await this._tools.getUrgentEmails();
    
    if (!urgent.connected) {
      return {
        success: true,
        message: "Email service not connected. Connect your email provider in Settings to see urgent messages."
      };
    }
    
    if (urgent.urgentEmails.length === 0) {
      return {
        success: true,
        message: "No urgent emails right now. You're all caught up!"
      };
    }
    
    const summary = urgent.urgentEmails.slice(0, 3).map(e => 
      `"${e.subject}" from ${e.from}`
    ).join(', ');
    
    return {
      success: true,
      message: `You have ${urgent.urgentEmails.length} urgent email${urgent.urgentEmails.length > 1 ? 's' : ''}: ${summary}`
    };
  },
  
  /**
   * Compose email
   */
  async _composeEmail(params) {
    const result = await this._tools.composeEmail({
      to: params?.to,
      subject: params?.subject,
      body: params?.body
    });
    
    return {
      success: true,
      message: result.message || `Draft created for ${params?.to || 'recipient'}. Email API not fully connected - drafts are simulated.`
    };
  },
  
  /**
   * Reply to email
   */
  async _replyToEmail(params) {
    const result = await this._tools.replyToEmail({
      emailId: params?.emailId,
      body: params?.body
    });
    
    return {
      success: true,
      message: result.message || "Reply drafted. Email API not fully connected - replies are simulated."
    };
  },
  
  /**
   * Search emails
   */
  async _searchEmails(query) {
    const results = await this._tools.searchEmails({ query });
    
    if (!results.connected) {
      return {
        success: true,
        message: `Search for "${query}" not available. Connect your email provider in Settings.`
      };
    }
    
    if (results.emails.length === 0) {
      return {
        success: true,
        message: `No emails found matching "${query}".`
      };
    }
    
    return {
      success: true,
      message: `Found ${results.emails.length} emails matching "${query}".`
    };
  },
  
  /**
   * Send email
   */
  async _sendEmail(params) {
    const result = await this._tools.sendEmail({
      to: params?.to,
      subject: params?.subject,
      body: params?.body
    });
    
    return {
      success: result.success,
      message: result.message || "Email send attempted. Connect your email provider in Settings for full functionality."
    };
  },
  
  /**
   * Create draft
   */
  async _createDraft(params) {
    const result = await this._tools.createDraft({
      to: params?.to,
      subject: params?.subject,
      body: params?.body
    });
    
    return {
      success: true,
      message: result.message || "Draft saved. Connect your email provider in Settings for full functionality."
    };
  },
  
  // ==================== HELPERS ====================
  
  /**
   * Build email summary from cache
   */
  _buildEmailSummary() {
    const { unreadCount, urgentEmails, lastFetch } = this._cache;
    
    if (!lastFetch) {
      return 'No email data available yet';
    }
    
    const parts = [];
    parts.push(`${unreadCount} unread`);
    
    if (urgentEmails.length > 0) {
      parts.push(`${urgentEmails.length} urgent`);
    }
    
    const ageMinutes = Math.round((Date.now() - lastFetch) / 60000);
    if (ageMinutes > 1) {
      parts.push(`(updated ${ageMinutes} min ago)`);
    }
    
    return parts.join(', ');
  },
  
  /**
   * Get memory context for AI
   */
  _getMemoryContext() {
    const sections = [];
    
    const contacts = this.memory.getSection('Frequent Contacts');
    if (contacts && !contacts.includes('*Will be populated')) {
      sections.push(`Frequent Contacts:\n${contacts}`);
    }
    
    const prefs = this.memory.getSection('Email Preferences');
    if (prefs) sections.push(`Email Preferences:\n${prefs}`);
    
    return sections.join('\n\n');
  },
  
  /**
   * Learn from interaction
   */
  async _learnFromInteraction(request, result, context) {
    if (!this.memory) return;
    
    // Record activity
    const timestamp = new Date().toISOString().split('T')[0];
    const entry = `- ${timestamp}: "${request.slice(0, 40)}..." -> ${result.message?.slice(0, 50) || 'completed'}...`;
    this.memory.appendToSection('Recent Activity', entry, 20);
    
    // Extract contacts for learning
    const emailMatch = request.match(/email\s+(\w+)/i);
    if (emailMatch) {
      const contact = emailMatch[1];
      const contacts = this.memory.parseSectionAsKeyValue('Frequent Contacts') || {};
      if (!contacts[contact]) {
        // Add new contact
        const currentContacts = this.memory.getSection('Frequent Contacts');
        if (currentContacts?.includes('*Will be populated')) {
          this.memory.updateSection('Frequent Contacts', `- ${contact}: mentioned`);
        } else {
          this.memory.appendToSection('Frequent Contacts', `- ${contact}: mentioned`, 10);
        }
      }
    }
    
    await this.memory.save();
    
    // Use shared learning
    await learnFromInteraction(this.memory, { content: request }, result, {
      useAILearning: false
    });
  },
  
  // ==================== TOOL LIBRARY (STUBS) ====================
  
  _tools: {
    /**
     * Get email summary (for cache refresh)
     * STUB: Returns mock data until email API connected
     */
    async getEmailSummary() {
      // TODO: Connect to real email API (Gmail, Outlook, etc.)
      log.info('agent', 'getEmailSummary() - STUB returning mock data');
      return {
        connected: false,
        unreadCount: 0,
        urgentEmails: [],
        recentEmails: []
      };
    },
    
    /**
     * Get urgent/flagged emails
     * STUB: Returns mock data until email API connected
     */
    async getUrgentEmails() {
      log.info('agent', 'getUrgentEmails() - STUB returning mock data');
      return {
        connected: false,
        urgentEmails: [],
        unreadCount: 0
      };
    },
    
    /**
     * Read emails from inbox
     * STUB: Returns mock data until email API connected
     */
    async readEmails({ count = 10, from, unreadOnly = false }) {
      log.info('agent', `readEmails(count=${count}, unreadOnly=${unreadOnly}) - STUB`);
      return {
        connected: false,
        emails: [],
        total: 0
      };
    },
    
    /**
     * Search emails
     * STUB: Returns mock data until email API connected
     */
    async searchEmails({ query, from, subject }) {
      log.info('agent', `searchEmails(query="${query}") - STUB`);
      return {
        connected: false,
        emails: [],
        query
      };
    },
    
    /**
     * Compose a new email
     * STUB: Returns success message until email API connected
     */
    async composeEmail({ to, subject, body }) {
      log.info('agent', `composeEmail(to="${to}", subject="${subject}") - STUB`);
      return {
        success: true,
        message: `Email draft created for ${to || 'recipient'}. Connect email provider in Settings to send.`,
        draftId: `stub-draft-${Date.now()}`
      };
    },
    
    /**
     * Send an email
     * STUB: Returns success message until email API connected
     */
    async sendEmail({ to, subject, body }) {
      log.info('agent', `sendEmail(to="${to}", subject="${subject}") - STUB`);
      return {
        success: true,
        message: `Email to ${to || 'recipient'} queued. Connect email provider in Settings to actually send.`
      };
    },
    
    /**
     * Reply to an email
     * STUB: Returns success message until email API connected
     */
    async replyToEmail({ emailId, body }) {
      log.info('agent', `replyToEmail(emailId="${emailId}") - STUB`);
      return {
        success: true,
        message: 'Reply drafted. Connect email provider in Settings to send.'
      };
    },
    
    /**
     * Create a draft
     * STUB: Returns success message until email API connected
     */
    async createDraft({ to, subject, body }) {
      log.info('agent', `createDraft(to="${to}", subject="${subject}") - STUB`);
      return {
        success: true,
        message: 'Draft saved locally. Connect email provider in Settings for cloud sync.',
        draftId: `stub-draft-${Date.now()}`
      };
    },
    
    /**
     * Get unread count
     * STUB: Returns 0 until email API connected
     */
    async getUnreadCount() {
      log.info('agent', 'getUnreadCount() - STUB');
      return {
        connected: false,
        count: 0
      };
    }
  },
  
  // ==================== CLEANUP ====================
  
  /**
   * Cleanup when agent is unloaded
   */
  cleanup() {
    this._stopPolling();
    log.info('agent', 'Cleaned up');
  }
};

module.exports = emailAgent;
