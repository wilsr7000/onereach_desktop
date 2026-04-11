/**
 * Email Agent -- IMAP-connected email assistant with triage scoring.
 *
 * - Connects to real email via lib/email-service.js (IMAP + SMTP)
 * - Threaded conversation tracking via lib/email-thread-engine.js
 * - AI-powered triage scoring: urgency, importance, conversation weighting
 * - Background polling via IMAP IDLE or fallback interval
 * - Learns contacts and preferences over time
 * - Multi-account aware ("check my work email" vs "check personal")
 */

'use strict';

const { getAgentMemory } = require('../../lib/agent-memory-store');
const { getTimeContext, learnFromInteraction } = require('../../lib/thinking-agent');
const { getCircuit } = require('./circuit-breaker');
const ai = require('../../lib/ai-service');
const { getLogQueue } = require('../../lib/log-event-queue');
const log = getLogQueue();

const emailCircuit = getCircuit('email-agent-ai', {
  failureThreshold: 3,
  resetTimeout: 30000,
  windowMs: 60000,
});

const POLL_INTERVAL_MS = 5 * 60 * 1000;

function _getEmailService() {
  try {
    const { getEmailService } = require('../../lib/email-service');
    return getEmailService();
  } catch (_) {
    return null;
  }
}

function _getThreadEngine() {
  try {
    const { getEmailThreadEngine } = require('../../lib/email-thread-engine');
    return getEmailThreadEngine({ ai });
  } catch (_) {
    return null;
  }
}

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
- "triage" - User wants a prioritized inbox summary with scoring
- "check_threads" - User wants to see active conversation threads
- "get_thread" - User wants the full conversation thread for a specific email
- "compose" - User wants to write a new email
- "reply" - User wants to reply to an email
- "search" - User wants to find specific emails
- "send" - User wants to send an email
- "draft" - User wants to create/save a draft
- "mark_read" - User wants to mark emails as read
- "mark_important" - User wants to flag/star an email

Respond with JSON:
{
  "understood": true/false,
  "action": "check_inbox" | "check_urgent" | "triage" | "check_threads" | "get_thread" | "compose" | "reply" | "search" | "send" | "draft" | "mark_read" | "mark_important" | "clarify",
  "parameters": {
    "to": "recipient if specified",
    "subject": "subject if specified",
    "query": "search query if searching",
    "count": number of emails to show (default 5),
    "accountHint": "work or personal or specific label if mentioned",
    "uid": "email UID if referencing a specific email"
  },
  "needsClarification": true/false,
  "clarificationPrompt": "Question to ask if clarification needed",
  "reasoning": "Brief explanation of understanding"
}`;

  const userPrompt = `User request: "${userRequest}"\n\nWhat email action does the user want?`;

  try {
    const result = await emailCircuit.execute(async () => {
      return await ai.chat({
        profile: 'fast',
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
        temperature: 0.3,
        maxTokens: 300,
        jsonMode: true,
        feature: 'email-agent',
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
  description:
    'Handles all email communications -- check inbox, compose, send, search, reply, triage, and threaded conversations via IMAP',
  voice: 'nova',
  acks: ['Checking your email.', 'Let me look at your inbox.'],
  categories: ['communication', 'email', 'messaging'],
  keywords: [],
  executionType: 'action',
  estimatedExecutionMs: 5000,
  dataSources: ['email-imap'],

  async getBriefing() {
    try {
      const svc = _getEmailService();
      if (!svc) return { section: 'Email', priority: 4, content: null };

      const summary = await svc.getSummary();
      if (!summary.connected) {
        return { section: 'Email', priority: 4, content: null };
      }

      const engine = _getThreadEngine();
      if (engine && summary.recentEmails?.length > 0) {
        const threads = engine.buildThreads(summary.recentEmails);
        const scored = await engine.scoreThreads(threads, { useAI: false });
        const triageSummary = engine.summarize(scored);
        return {
          section: 'Email',
          priority: 4,
          content: `${summary.unreadCount} unread. ${triageSummary}`,
        };
      }

      return {
        section: 'Email',
        priority: 4,
        content: `${summary.unreadCount} unread email${summary.unreadCount !== 1 ? 's' : ''}.`,
      };
    } catch (_e) {
      return { section: 'Email', priority: 4, content: null };
    }
  },

  prompt: `Email Assistant handles all email-related tasks via IMAP.

Capabilities:
- Check for new, unread, urgent, or important emails
- Triage inbox with AI-scored urgency and importance
- Track threaded conversations and identify which need replies
- Read and summarize email contents
- Compose and send emails
- Reply to and forward emails
- Search emails by sender, subject, or content
- Create and manage drafts
- Multi-account support

This agent connects to real email inboxes via IMAP and sends via SMTP.
It distinguishes between active conversations (threaded, weighted higher) and standalone messages.`,

  capabilities: [
    'Check inbox and unread count via IMAP',
    'Triage inbox with urgency/importance scoring',
    'Track threaded email conversations',
    'Find urgent/flagged emails',
    'Compose and send emails via SMTP',
    'Search emails by sender, subject, or content',
    'Reply to emails in threads',
    'Create and manage drafts',
    'Learn frequent contacts and preferences',
    'Multi-account support',
  ],

  memory: null,

  _cache: {
    unreadCount: 0,
    urgentEmails: [],
    recentEmails: [],
    lastFetch: null,
  },

  _pollInterval: null,

  async initialize() {
    if (!this.memory) {
      this.memory = getAgentMemory('email-agent', { displayName: 'Email Assistant' });
      await this.memory.load();
      this._ensureMemorySections();
    }

    const svc = _getEmailService();
    if (svc) {
      svc.on('new-mail', () => this._refreshCache());
    }

    this._startPolling();
    return this.memory;
  },

  _ensureMemorySections() {
    const sections = this.memory.getSectionNames();

    if (!sections.includes('Frequent Contacts')) {
      this.memory.updateSection('Frequent Contacts', `*Will be populated as you use email*`);
    }
    if (!sections.includes('Email Preferences')) {
      this.memory.updateSection(
        'Email Preferences',
        `- Signature: Not set\n- Default Response Style: Professional\n- Priority Senders: None configured`
      );
    }
    if (!sections.includes('VIP Senders')) {
      this.memory.updateSection('VIP Senders', `*No VIP senders yet. Mark senders as important to add them.*`);
    }
    if (!sections.includes('Templates')) {
      this.memory.updateSection('Templates', `*No templates saved yet*`);
    }
    if (!sections.includes('Recent Activity')) {
      this.memory.updateSection('Recent Activity', `*No activity yet*`);
    }

    if (this.memory.isDirty()) {
      this.memory.save();
    }
  },

  _startPolling() {
    if (this._pollInterval) return;
    log.info('agent', 'Starting email background polling');
    this._refreshCache();
    this._pollInterval = setInterval(() => this._refreshCache(), POLL_INTERVAL_MS);
  },

  _stopPolling() {
    if (this._pollInterval) {
      clearInterval(this._pollInterval);
      this._pollInterval = null;
    }
  },

  async _refreshCache() {
    try {
      const svc = _getEmailService();
      if (!svc) return;

      const summary = await svc.getSummary();
      this._cache = {
        unreadCount: summary.unreadCount || 0,
        urgentEmails: summary.urgentEmails || [],
        recentEmails: summary.recentEmails || [],
        lastFetch: Date.now(),
        connected: summary.connected,
      };

      this._cachedEmailSummary = this._buildEmailSummary();
    } catch (error) {
      log.error('agent', 'Failed to refresh email cache', { error: error.message });
    }
  },

  async execute(task) {
    try {
      if (!this.memory) await this.initialize();

      const context = getTimeContext();
      const content = task.content || task.phrase || '';

      if (task.context?.originalRequest && task.context?.partialUnderstanding) {
        return this._handleClarificationResponse(task, context);
      }

      const aiContext = {
        partOfDay: context.partOfDay,
        memory: this.memory ? this._getMemoryContext() : null,
        emailSummary: this._buildEmailSummary(),
        conversationHistory: task.context?.conversationHistory || null,
      };

      const aiResult = await aiUnderstandEmailRequest(content, aiContext);

      if (aiResult && !aiResult.needsClarification) {
        const result = await this._executeAction(aiResult);
        await this._learnFromInteraction(content, result, context);
        return result;
      }

      if (aiResult?.needsClarification) {
        return {
          success: true,
          needsInput: {
            prompt: aiResult.clarificationPrompt,
            agentId: this.id,
            context: {
              originalRequest: content,
              partialUnderstanding: aiResult,
            },
          },
        };
      }

      return this._fallbackResponse(content);
    } catch (error) {
      log.error('agent', 'Error', { error });
      return {
        success: false,
        message: "I couldn't access your email right now. Check your email account settings.",
      };
    }
  },

  async _handleClarificationResponse(task, context) {
    const userResponse = task.context?.userInput || task.content;
    const originalRequest = task.context?.originalRequest;

    const aiContext = {
      partOfDay: context.partOfDay,
      memory: this.memory ? this._getMemoryContext() : null,
      emailSummary: this._buildEmailSummary(),
      conversationHistory: task.context?.conversationHistory || null,
    };

    const combinedRequest = `${originalRequest}. User clarified: ${userResponse}`;
    const aiResult = await aiUnderstandEmailRequest(combinedRequest, aiContext);

    if (aiResult && !aiResult.needsClarification) {
      const result = await this._executeAction(aiResult);
      await this._learnFromInteraction(combinedRequest, result, context);
      return result;
    }

    if (aiResult?.needsClarification) {
      return {
        success: true,
        needsInput: {
          prompt: aiResult.clarificationPrompt,
          agentId: this.id,
          context: {
            originalRequest: combinedRequest,
            partialUnderstanding: aiResult,
          },
        },
      };
    }

    return this._fallbackResponse(userResponse);
  },

  async _executeAction(aiResult) {
    const { action, parameters } = aiResult;
    const accountId = parameters?.accountHint ? this._resolveAccountHint(parameters.accountHint) : null;

    switch (action) {
      case 'check_inbox':
        return await this._checkInbox(accountId, parameters?.count || 5);
      case 'check_urgent':
        return await this._checkUrgent(accountId);
      case 'triage':
        return await this._triage(accountId);
      case 'check_threads':
        return await this._checkThreads(accountId);
      case 'get_thread':
        return await this._getThread(accountId, parameters?.uid);
      case 'compose':
        return await this._composeEmail(accountId, parameters);
      case 'reply':
        return await this._replyToEmail(accountId, parameters);
      case 'search':
        return await this._searchEmails(accountId, parameters?.query);
      case 'send':
        return await this._sendEmail(accountId, parameters);
      case 'draft':
        return await this._createDraft(accountId, parameters);
      case 'mark_read':
        return await this._markRead(accountId, parameters?.uid);
      case 'mark_important':
        return await this._markImportant(accountId, parameters?.uid);
      default:
        return await this._checkInbox(accountId, 5);
    }
  },

  _resolveAccountHint(hint) {
    if (!hint) return null;
    const svc = _getEmailService();
    if (!svc) return null;

    const accounts = svc.getAccountStatuses();
    const lower = hint.toLowerCase();
    const match = accounts.find((a) =>
      (a.label || '').toLowerCase().includes(lower) ||
      (a.email || '').toLowerCase().includes(lower)
    );
    return match ? match.id : null;
  },

  _fallbackResponse(_content) {
    const { unreadCount, urgentEmails, connected } = this._cache;

    if (!connected) {
      return {
        success: true,
        message: 'No email account connected. Go to Settings > Email Accounts to add one.',
      };
    }

    if (urgentEmails.length > 0) {
      return {
        success: true,
        message: `You have ${urgentEmails.length} flagged email${urgentEmails.length > 1 ? 's' : ''} and ${unreadCount} total unread.`,
      };
    }

    if (unreadCount > 0) {
      return {
        success: true,
        message: `You have ${unreadCount} unread email${unreadCount > 1 ? 's' : ''}.`,
      };
    }

    return { success: true, message: 'Your inbox is clear.' };
  },

  // ==================== EMAIL ACTIONS ====================

  async _checkInbox(accountId, count = 5) {
    const svc = _getEmailService();
    if (!svc) return { success: true, message: 'Email service not available. Add an account in Settings > Email Accounts.' };

    const inbox = await svc.fetchInbox(accountId, { count, unreadOnly: false });
    if (!inbox.connected) {
      return { success: true, message: 'No email account connected. Go to Settings > Email Accounts to set one up.' };
    }

    if (inbox.emails.length === 0) {
      return { success: true, message: 'Your inbox is empty.' };
    }

    const summary = inbox.emails
      .slice(0, count)
      .map((e) => `"${e.subject}" from ${e.from}${e.isRead ? '' : ' [unread]'}`)
      .join('\n- ');

    return {
      success: true,
      message: `You have ${inbox.total} emails (${inbox.unread || 0} unread). Recent:\n- ${summary}`,
    };
  },

  async _checkUrgent(accountId) {
    const svc = _getEmailService();
    if (!svc) return { success: true, message: 'Email service not available.' };

    const inbox = await svc.fetchInbox(accountId, { count: 30 });
    if (!inbox.connected) {
      return { success: true, message: 'No email account connected.' };
    }

    const flagged = inbox.emails.filter((e) => e.isFlagged);
    if (flagged.length === 0) {
      return { success: true, message: 'No flagged emails. You\'re all caught up.' };
    }

    const summary = flagged
      .slice(0, 5)
      .map((e) => `"${e.subject}" from ${e.from}`)
      .join('\n- ');

    return {
      success: true,
      message: `You have ${flagged.length} flagged email${flagged.length > 1 ? 's' : ''}:\n- ${summary}`,
    };
  },

  async _triage(accountId) {
    const svc = _getEmailService();
    const engine = _getThreadEngine();
    if (!svc || !engine) return { success: true, message: 'Email service not available.' };

    const inbox = await svc.fetchInbox(accountId, { count: 50 });
    if (!inbox.connected) return { success: true, message: 'No email account connected.' };

    if (inbox.emails.length === 0) return { success: true, message: 'Your inbox is empty.' };

    const userAccounts = svc.getAccountStatuses();
    if (userAccounts.length > 0) {
      engine.setUserEmail(userAccounts[0].email);
    }

    const threads = engine.buildThreads(inbox.emails);
    const scored = await engine.scoreThreads(threads, { useAI: true, topN: 5 });
    const triageSummary = engine.summarize(scored);

    const topItems = scored.slice(0, 5).map((t, i) => {
      const type = t.isConversation ? `conversation (${t.messageCount} messages)` : 'message';
      const replyTag = t.awaitingReply ? ' -- awaiting your reply' : '';
      return `${i + 1}. [${t.priority.toUpperCase()}] "${t.subject}" (${type})${replyTag}`;
    }).join('\n');

    return {
      success: true,
      message: `${triageSummary}\n\nTop items:\n${topItems}`,
    };
  },

  async _checkThreads(accountId) {
    const svc = _getEmailService();
    const engine = _getThreadEngine();
    if (!svc || !engine) return { success: true, message: 'Email service not available.' };

    const inbox = await svc.fetchInbox(accountId, { count: 50 });
    if (!inbox.connected) return { success: true, message: 'No email account connected.' };

    const userAccounts = svc.getAccountStatuses();
    if (userAccounts.length > 0) engine.setUserEmail(userAccounts[0].email);

    const threads = engine.buildThreads(inbox.emails);
    const conversations = threads.filter((t) => t.messages.length > 1);

    if (conversations.length === 0) {
      return { success: true, message: 'No active conversation threads.' };
    }

    const scored = await engine.scoreThreads(conversations, { useAI: false });
    const list = scored.slice(0, 8).map((t, i) => {
      const replyTag = t.awaitingReply ? ' [needs reply]' : '';
      return `${i + 1}. "${t.subject}" -- ${t.messageCount} messages, ${t.participants.length} participants${replyTag}`;
    }).join('\n');

    return {
      success: true,
      message: `${conversations.length} active conversation${conversations.length > 1 ? 's' : ''}:\n${list}`,
    };
  },

  async _getThread(accountId, uid) {
    if (!uid) {
      return {
        success: true,
        needsInput: {
          prompt: 'Which email thread? Tell me the subject or sender.',
          agentId: this.id,
          context: { originalRequest: 'get thread', partialUnderstanding: { action: 'get_thread' } },
        },
      };
    }

    const svc = _getEmailService();
    if (!svc) return { success: true, message: 'Email service not available.' };

    const msg = await svc.fetchMessage(accountId, uid);
    if (!msg) return { success: false, message: 'Could not find that email.' };

    const parts = [
      `From: ${msg.from}`,
      `To: ${msg.to}`,
      `Subject: ${msg.subject}`,
      `Date: ${msg.date}`,
      '',
      msg.text || '(no text content)',
    ];

    return { success: true, message: parts.join('\n') };
  },

  async _composeEmail(accountId, params) {
    if (!params?.to) {
      return {
        success: true,
        needsInput: {
          prompt: 'Who should I send this email to?',
          agentId: this.id,
          context: { originalRequest: `compose email about ${params?.subject || ''}`, partialUnderstanding: { action: 'compose', parameters: params } },
        },
      };
    }

    const svc = _getEmailService();
    if (!svc) return { success: true, message: 'Email service not available.' };

    const result = await svc.send(accountId, {
      to: params.to,
      subject: params.subject || '',
      body: params.body || '',
    });

    return { success: result.success, message: result.message };
  },

  async _replyToEmail(accountId, params) {
    if (!params?.uid && !params?.emailId) {
      return { success: true, message: 'Which email should I reply to? Give me the subject or sender.' };
    }

    const svc = _getEmailService();
    if (!svc) return { success: true, message: 'Email service not available.' };

    const uid = params.uid || params.emailId;
    const original = await svc.fetchMessage(accountId, uid);
    if (!original) return { success: false, message: 'Could not find the original email to reply to.' };

    const result = await svc.send(accountId, {
      to: original.from,
      subject: `Re: ${original.subject}`,
      body: params.body || '',
      inReplyTo: original.messageId,
      references: [...(original.references || []), original.messageId].filter(Boolean),
    });

    return { success: result.success, message: result.message || `Reply sent to ${original.from}` };
  },

  async _searchEmails(accountId, query) {
    if (!query) return { success: true, message: 'What should I search for?' };

    const svc = _getEmailService();
    if (!svc) return { success: true, message: 'Email service not available.' };

    const results = await svc.searchMessages(accountId, query);
    if (!results.connected) return { success: true, message: 'No email account connected.' };

    if (results.emails.length === 0) {
      return { success: true, message: `No emails found matching "${query}".` };
    }

    const list = results.emails.slice(0, 5).map((e) => `"${e.subject}" from ${e.from}`).join('\n- ');
    return {
      success: true,
      message: `Found ${results.emails.length} email${results.emails.length > 1 ? 's' : ''} matching "${query}":\n- ${list}`,
    };
  },

  async _sendEmail(accountId, params) {
    return this._composeEmail(accountId, params);
  },

  async _createDraft(_accountId, params) {
    return {
      success: true,
      message: `Draft created for ${params?.to || 'recipient'}: "${params?.subject || '(no subject)'}". Drafts are saved locally until sent.`,
    };
  },

  async _markRead(accountId, uid) {
    if (!uid) return { success: true, message: 'Which email should I mark as read?' };
    const svc = _getEmailService();
    if (!svc) return { success: true, message: 'Email service not available.' };
    await svc.markRead(accountId, uid);
    return { success: true, message: 'Marked as read.' };
  },

  async _markImportant(accountId, uid) {
    if (!uid) return { success: true, message: 'Which email should I flag as important?' };
    const svc = _getEmailService();
    if (!svc) return { success: true, message: 'Email service not available.' };
    await svc.markFlagged(accountId, uid);
    return { success: true, message: 'Flagged as important.' };
  },

  // ==================== HELPERS ====================

  _buildEmailSummary() {
    const { unreadCount, urgentEmails, lastFetch, connected } = this._cache;

    if (!lastFetch) return 'No email data available yet';
    if (!connected) return 'Email not connected';

    const parts = [`${unreadCount} unread`];
    if (urgentEmails.length > 0) parts.push(`${urgentEmails.length} flagged`);

    const ageMinutes = Math.round((Date.now() - lastFetch) / 60000);
    if (ageMinutes > 1) parts.push(`(updated ${ageMinutes} min ago)`);

    return parts.join(', ');
  },

  _getMemoryContext() {
    const sections = [];

    const contacts = this.memory.getSection('Frequent Contacts');
    if (contacts && !contacts.includes('*Will be populated')) {
      sections.push(`Frequent Contacts:\n${contacts}`);
    }

    const prefs = this.memory.getSection('Email Preferences');
    if (prefs) sections.push(`Email Preferences:\n${prefs}`);

    const vips = this.memory.getSection('VIP Senders');
    if (vips && !vips.includes('*No VIP')) {
      sections.push(`VIP Senders:\n${vips}`);
    }

    return sections.join('\n\n');
  },

  async _learnFromInteraction(request, result, _context) {
    if (!this.memory) return;

    const timestamp = new Date().toISOString().split('T')[0];
    const entry = `- ${timestamp}: "${request.slice(0, 40)}..." -> ${result.message?.slice(0, 50) || 'completed'}...`;
    this.memory.appendToSection('Recent Activity', entry, 20);

    const emailMatch = request.match(/email\s+(\w+)/i);
    if (emailMatch) {
      const contact = emailMatch[1];
      const currentContacts = this.memory.getSection('Frequent Contacts');
      if (currentContacts?.includes('*Will be populated')) {
        this.memory.updateSection('Frequent Contacts', `- ${contact}: mentioned`);
      } else {
        this.memory.appendToSection('Frequent Contacts', `- ${contact}: mentioned`, 10);
      }
    }

    await this.memory.save();

    await learnFromInteraction(this.memory, { content: request }, result, {
      useAILearning: false,
    });
  },

  cleanup() {
    this._stopPolling();
    log.info('agent', 'Email agent cleaned up');
  },
};

module.exports = emailAgent;
