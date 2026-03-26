/**
 * Tickets Agent
 *
 * Full-featured agent for the Agentic TMS. Reads and writes tickets stored in
 * Edison Key/Value, with AI-powered intent parsing and natural-language responses.
 *
 * Supports: summarize, next ticket, create, assign, block/unblock, status,
 * explain, list assigned, list blocked, mark complete.
 */

'use strict';

const ai = require('../../lib/ai-service');
const { getLogQueue } = require('../../lib/log-event-queue');
const log = getLogQueue();
const tickets = require('../../lib/tickets-client');

const TICKETS_ACCOUNT_ID = '35254342-4a2e-475b-aec1-18547e517e29';
const TICKETS_BASE_URL = `https://files.edison.api.onereach.ai/public/${TICKETS_ACCOUNT_ID}/agententic-tms/index.html`;

function openTicketsUI(action) {
  const url = action ? `${TICKETS_BASE_URL}?action=${action}` : TICKETS_BASE_URL;

  // Use moduleManager.openWebTool (creates a proper BrowserWindow, same as the Tools menu)
  if (global.moduleManager) {
    try {
      const tools = global.moduleManager.getWebTools() || [];
      const tool = tools.find((t) => /ticket/i.test(t.name));
      if (tool) {
        global.moduleManager.openWebTool(tool.id, { url });
        return true;
      }
    } catch (err) {
      log.warn('tickets-agent', 'moduleManager lookup failed', { error: err.message });
    }
  }

  // Fallback: open in tabbed browser
  if (global.mainWindow && !global.mainWindow.isDestroyed()) {
    global.mainWindow.webContents.send('open-in-new-tab', url);
    return true;
  }

  log.warn('tickets-agent', 'No window available to open Tickets UI');
  return false;
}

const ticketsAgent = {
  id: 'tickets-agent',
  name: 'Ticketing',
  description:
    'The ticketing agent. Handles EVERYTHING related to tickets and ticketing -- open the ticketing app, create tickets, assign, block, complete, summarize, query, and manage tickets.',
  voice: 'alloy',
  acks: ['Checking your tickets.', 'Let me look that up.', 'On it.'],
  categories: ['productivity', 'tickets', 'ticketing'],
  keywords: [
    'tickets',
    'ticket',
    'ticketing',
    'ticketing app',
    'ticketing system',
    'my tickets',
    'next ticket',
    'create ticket',
    'new ticket',
    'assign ticket',
    'ticket status',
    'summarize tickets',
    'ticket summary',
    'blocked ticket',
    'im blocked',
    'unblock ticket',
    'explain ticket',
    'complete ticket',
    'done with ticket',
    'what tickets',
    'open tickets',
    'ticket report',
    'launch tickets',
    'launch ticketing',
    'open ticketing',
    'show me my tickets',
    'I want ticketing',
    'I want a ticket',
  ],
  executionType: 'action',
  estimatedExecutionMs: 6000,
  dataSources: ['edison-kv'],

  prompt: `Ticketing Agent -- the primary agent for ALL ticket and ticketing requests.

This agent handles every request that mentions tickets, ticketing, or the ticketing app/system. It should ALWAYS win bids over other agents when the user mentions tickets or ticketing in any form.

Capabilities:
- Launch/open the ticketing app (Agentic TMS)
- Summarize all tickets with counts by status, priority, and section
- Show the next actionable ticket from the "next-actions" queue
- Create new tickets with title, description, priority, tags
- Assign tickets to team members
- Mark tickets as blocked (with reason) or unblock them
- Explain a ticket's context, history, and current state
- Report on ticket status
- List tickets assigned to the user or filtered by criteria
- Mark tickets as complete

This agent reads and writes to the shared Edison Key/Value ticket store. It does NOT create playbooks, plans, or projects -- only tickets.`,

  async execute(task) {
    const query = (task.content || task.text || task.query || '').trim();
    if (!query) return { success: false, message: 'What would you like to do with your tickets?' };

    const context = task.context || {};

    try {
      // Multi-turn continuations
      if (context.ticketState === 'awaiting_ticket_fields') {
        return await this._resumeCreate(query, context);
      }
      if (context.ticketState === 'awaiting_block_reason') {
        return await this._resumeBlock(query, context);
      }
      if (context.ticketState === 'awaiting_assignment') {
        return await this._resumeAssign(query, context);
      }

      // Classify intent and extract details in one AI call
      const parsed = await this._classifyIntent(query);
      log.info('tickets-agent', 'Classified intent', { intent: parsed.intent, ticketId: parsed.ticketId });

      // Launch doesn't need auth or userId
      if (parsed.intent === 'launch') {
        return this._handleLaunch();
      }

      const userId = await tickets.resolveUserId();
      if (!userId) {
        return {
          success: true,
          message: 'I can\'t access your tickets yet -- no userId found. Either log into OneReach (so I can pick up your email) or set "ticketsUserId" in Settings.',
        };
      }

      switch (parsed.intent) {
        case 'summarize':
          return await this._handleSummarize(userId);
        case 'next_ticket':
          return await this._handleNextTicket(userId);
        case 'create':
          return await this._handleCreate(userId, parsed);
        case 'assign':
          return await this._handleAssign(userId, parsed);
        case 'block':
          return await this._handleBlock(userId, parsed);
        case 'unblock':
          return await this._handleUnblock(userId, parsed);
        case 'status':
          return await this._handleStatus(userId, parsed);
        case 'explain':
          return await this._handleExplain(userId, parsed);
        case 'list_assigned':
          return await this._handleListAssigned(userId);
        case 'list_blocked':
          return await this._handleListBlocked(userId);
        case 'complete':
          return await this._handleComplete(userId, parsed);
        default:
          return await this._handleSummarize(userId);
      }
    } catch (err) {
      log.error('tickets-agent', 'Execute failed', { error: err.message, stack: err.stack });
      if (err.message.includes('auth token') || err.message.includes('Token fetch')) {
        return { success: true, message: 'I can\'t reach the ticket store right now -- no auth token available. Open any GSX or IDW page in the browser first so the app can capture your session.' };
      }
      return { success: true, message: `Something went wrong with tickets: ${err.message}` };
    }
  },

  // ────────────── Intent Classification ──────────────

  async _classifyIntent(query) {
    return ai.json(
      `Classify this ticket management request and extract any details.

USER REQUEST: "${query}"

Return JSON:
{
  "intent": "<one of: launch, summarize, next_ticket, create, assign, block, unblock, status, explain, list_assigned, list_blocked, complete>",
  "ticketId": "<ticket ID like tsk_xxxxxxxx if mentioned, else null>",
  "assignee": "<person name or user ID if mentioned, else null>",
  "title": "<ticket title if creating, else null>",
  "description": "<ticket description if creating, else null>",
  "priority": "<urgent, normal, or low if mentioned, else null>",
  "section": "<inbox, next-actions, waiting, or someday if mentioned, else null>",
  "tags": ["<any tags mentioned>"],
  "reason": "<reason if blocking, else null>"
}

Rules:
- "open tickets", "launch tickets", "show me my tickets", "open ticketing", "launch ticketing" → launch
- "summarize my tickets", "ticket overview", "ticket report" → summarize
- "what is my next ticket", "next task", "what should I work on" → next_ticket
- "create a ticket", "new ticket", "add a ticket" → create
- "assign ticket to", "give ticket to" → assign
- "I'm blocked", "blocked on", "can't proceed" → block
- "unblock", "no longer blocked" → unblock
- "status of ticket", "where is ticket" → status
- "explain ticket", "tell me about ticket", "what is ticket" → explain
- "my tickets", "tickets assigned to me", "what do I have" → list_assigned
- "what's blocked", "blocked tickets", "show blocked" → list_blocked
- "done with ticket", "complete ticket", "finished", "mark done" → complete
- Extract ticket IDs (tsk_xxxxxxxxx) from the text when present
- Extract only what the user explicitly mentioned; leave fields null if not stated`,
      { profile: 'fast', feature: 'tickets-classify' },
    );
  },

  // ────────────── Handlers ──────────────

  _handleLaunch() {
    const opened = openTicketsUI();
    return {
      success: true,
      message: opened ? 'Opening the Tickets app.' : 'Could not open the Tickets app. Try opening it from the Tools menu.',
    };
  },

  async _handleSummarize(userId) {
    const stats = await tickets.getTicketStats(userId);
    if (stats.total === 0) {
      return { success: true, message: 'You have no tickets.' };
    }

    const all = await tickets.getAllTickets(userId);
    const ticketSnapshot = all
      .filter((t) => !t.isCompleted)
      .slice(0, 30)
      .map((t) => `- [${t.id}] "${t.title}" (${t.status}, ${t.priority}, ${t.section})`)
      .join('\n');

    const summary = await ai.complete(
      `Summarize these ticket stats and open tickets concisely for the user.

Stats:
- Total: ${stats.total}
- Open: ${stats.open}, Blocked: ${stats.blocked}, Completed: ${stats.completed}
- By status: ${JSON.stringify(stats.byStatus)}
- By priority: ${JSON.stringify(stats.byPriority)}
- By section: ${JSON.stringify(stats.bySection)}

Open tickets:
${ticketSnapshot || '(none)'}

Write a brief, useful summary. Highlight urgent or blocked items. Keep it concise.`,
      { profile: 'fast', feature: 'tickets-summarize' },
    );

    return { success: true, message: summary };
  },

  async _handleNextTicket(userId) {
    const nextActions = await tickets.getTicketsByFilter(userId, {
      section: 'next-actions',
      isCompleted: false,
      isBlocked: false,
    });

    if (nextActions.length === 0) {
      const pending = await tickets.getTicketsByFilter(userId, {
        status: 'pending',
        isCompleted: false,
        isBlocked: false,
      });
      if (pending.length === 0) {
        return { success: true, message: 'No actionable tickets right now. Your queue is clear.' };
      }
      const next = pending[0];
      return {
        success: true,
        message: `Your next pending ticket is "${next.title}" (${next.id}), priority: ${next.priority}. ${next.description ? `\n\n${next.description}` : ''}`,
      };
    }

    const byPriority = { urgent: 0, normal: 1, low: 2 };
    nextActions.sort((a, b) => (byPriority[a.priority] ?? 1) - (byPriority[b.priority] ?? 1));
    const next = nextActions[0];

    return {
      success: true,
      message: `Your next ticket is "${next.title}" (${next.id}), priority: ${next.priority}, section: ${next.section}. ${next.description ? `\n\n${next.description}` : ''}`,
    };
  },

  async _handleCreate(userId, parsed) {
    if (!parsed.title) {
      const opened = openTicketsUI('create');
      if (opened) {
        return {
          success: true,
          message: 'Opening the Tickets app for you to create a new ticket.',
        };
      }
      return {
        success: true,
        needsInput: {
          prompt: 'What should the ticket be about? Give me a title and optionally a description.',
          agentId: this.id,
          context: { ticketState: 'awaiting_ticket_fields', pendingTicket: parsed },
        },
      };
    }

    const ticket = await tickets.createTicket(userId, {
      title: parsed.title,
      description: parsed.description || '',
      priority: parsed.priority || 'normal',
      section: parsed.section || 'inbox',
      tags: parsed.tags || [],
    });

    return {
      success: true,
      message: `Created ticket "${ticket.title}" (${ticket.id}), priority: ${ticket.priority}, section: ${ticket.section}.`,
    };
  },

  async _handleAssign(userId, parsed) {
    if (!parsed.ticketId) {
      return {
        success: true,
        needsInput: {
          prompt: 'Which ticket should I assign? Please provide the ticket ID (tsk_...).',
          agentId: this.id,
          context: { ticketState: 'awaiting_assignment', assignee: parsed.assignee },
        },
      };
    }
    if (!parsed.assignee) {
      return {
        success: true,
        needsInput: {
          prompt: `Who should I assign ticket ${parsed.ticketId} to?`,
          agentId: this.id,
          context: { ticketState: 'awaiting_assignment', ticketId: parsed.ticketId },
        },
      };
    }

    const updated = await tickets.updateTicket(userId, parsed.ticketId, {
      assignedTo: parsed.assignee,
    });

    return {
      success: true,
      message: `Assigned "${updated.title}" (${updated.id}) to ${parsed.assignee}.`,
    };
  },

  async _handleBlock(userId, parsed) {
    if (!parsed.ticketId) {
      const running = await tickets.getTicketsByFilter(userId, { status: 'running', isBlocked: false });
      if (running.length === 1) {
        parsed.ticketId = running[0].id;
      } else {
        return {
          success: true,
          needsInput: {
            prompt: 'Which ticket are you blocked on? Please provide the ticket ID (tsk_...).',
            agentId: this.id,
            context: { ticketState: 'awaiting_block_reason', reason: parsed.reason },
          },
        };
      }
    }

    if (!parsed.reason) {
      return {
        success: true,
        needsInput: {
          prompt: `What is blocking you on ticket ${parsed.ticketId}?`,
          agentId: this.id,
          context: { ticketState: 'awaiting_block_reason', ticketId: parsed.ticketId },
        },
      };
    }

    const updated = await tickets.updateTicket(userId, parsed.ticketId, {
      isBlocked: true,
      status: 'blocked',
      blockedReason: parsed.reason,
    });

    return {
      success: true,
      message: `Marked "${updated.title}" (${updated.id}) as blocked. Reason: ${parsed.reason}`,
    };
  },

  async _handleUnblock(userId, parsed) {
    if (!parsed.ticketId) {
      const blocked = await tickets.getTicketsByFilter(userId, { isBlocked: true });
      if (blocked.length === 1) {
        parsed.ticketId = blocked[0].id;
      } else if (blocked.length === 0) {
        return { success: true, message: 'No blocked tickets found.' };
      } else {
        const list = blocked.map((t) => `- ${t.id}: "${t.title}"`).join('\n');
        return { success: true, message: `Multiple blocked tickets found. Which one?\n${list}` };
      }
    }

    const updated = await tickets.updateTicket(userId, parsed.ticketId, {
      isBlocked: false,
      blockedReason: undefined,
      status: 'pending',
    });

    return {
      success: true,
      message: `Unblocked "${updated.title}" (${updated.id}). Status set back to pending.`,
    };
  },

  async _handleStatus(userId, parsed) {
    if (!parsed.ticketId) {
      return await this._handleSummarize(userId);
    }

    const ticket = await tickets.getTicket(userId, parsed.ticketId);
    if (!ticket) return { success: false, message: `Ticket ${parsed.ticketId} not found.` };

    const lines = [
      `"${ticket.title}" (${ticket.id})`,
      `Status: ${ticket.status} | Priority: ${ticket.priority} | Section: ${ticket.section}`,
    ];
    if (ticket.assignedTo) lines.push(`Assigned to: ${ticket.assignedTo}`);
    if (ticket.isBlocked) lines.push(`BLOCKED: ${ticket.blockedReason || 'No reason given'}`);
    if (ticket.isCompleted) lines.push(`Completed: ${ticket.completedAt}`);
    lines.push(`Created: ${ticket.createdAt} | Updated: ${ticket.updatedAt}`);

    return { success: true, message: lines.join('\n') };
  },

  async _handleExplain(userId, parsed) {
    if (!parsed.ticketId) {
      return { success: false, message: 'Which ticket should I explain? Please provide a ticket ID (tsk_...).' };
    }

    const ticket = await tickets.getTicket(userId, parsed.ticketId);
    if (!ticket) return { success: false, message: `Ticket ${parsed.ticketId} not found.` };

    const explanation = await ai.complete(
      `Explain this ticket to the user in plain language. Include what it's about, its current state, any blockers, and recent activity.

Ticket JSON:
${JSON.stringify(ticket, null, 2)}

Be concise but thorough. Focus on what the user needs to know to take action.`,
      { profile: 'fast', feature: 'tickets-explain' },
    );

    return { success: true, message: explanation };
  },

  async _handleListAssigned(userId) {
    const all = await tickets.getAllTickets(userId);
    const mine = all.filter(
      (t) => !t.isCompleted && (t.assignedTo === userId || t.createdBy === userId),
    );

    if (mine.length === 0) {
      return { success: true, message: 'You have no active tickets assigned.' };
    }

    const byPriority = { urgent: 0, normal: 1, low: 2 };
    mine.sort((a, b) => (byPriority[a.priority] ?? 1) - (byPriority[b.priority] ?? 1));

    const list = mine
      .map((t) => {
        let line = `- [${t.id}] "${t.title}" (${t.status}, ${t.priority})`;
        if (t.isBlocked) line += ' [BLOCKED]';
        return line;
      })
      .join('\n');

    return {
      success: true,
      message: `You have ${mine.length} active ticket${mine.length === 1 ? '' : 's'}:\n${list}`,
    };
  },

  async _handleListBlocked(userId) {
    const blocked = await tickets.getTicketsByFilter(userId, { isBlocked: true });
    if (blocked.length === 0) {
      return { success: true, message: 'No blocked tickets. Everything is clear.' };
    }

    const list = blocked
      .map((t) => `- [${t.id}] "${t.title}" -- ${t.blockedReason || 'No reason given'}`)
      .join('\n');

    return {
      success: true,
      message: `${blocked.length} blocked ticket${blocked.length === 1 ? '' : 's'}:\n${list}`,
    };
  },

  async _handleComplete(userId, parsed) {
    if (!parsed.ticketId) {
      const running = await tickets.getTicketsByFilter(userId, { status: 'running' });
      if (running.length === 1) {
        parsed.ticketId = running[0].id;
      } else {
        return { success: false, message: 'Which ticket is done? Please provide the ticket ID (tsk_...).' };
      }
    }

    const updated = await tickets.updateTicket(userId, parsed.ticketId, {
      isCompleted: true,
      status: 'completed',
    });

    return {
      success: true,
      message: `Marked "${updated.title}" (${updated.id}) as complete.`,
    };
  },

  // ────────────── Multi-turn Handlers ──────────────

  async _resumeCreate(query, context) {
    const userId = await tickets.resolveUserId();
    if (!userId) {
      return { success: true, message: 'I can\'t access your tickets yet -- no userId found. Log into OneReach or set "ticketsUserId" in Settings.' };
    }

    const pending = context.pendingTicket || {};

    const extracted = await ai.json(
      `Extract ticket details from this user response. They are creating a new ticket.

Previous context: ${JSON.stringify(pending)}

USER RESPONSE: "${query}"

Return JSON:
{
  "title": "<ticket title>",
  "description": "<description or empty string>",
  "priority": "<urgent, normal, or low -- default normal>",
  "section": "<inbox, next-actions, waiting, or someday -- default inbox>",
  "tags": ["<any tags>"]
}

Merge with any existing context. The title is required.`,
      { profile: 'fast', feature: 'tickets-create-extract' },
    );

    const title = extracted.title || pending.title;
    if (!title) {
      return {
        success: true,
        needsInput: {
          prompt: 'I still need a title for the ticket. What should it be called?',
          agentId: this.id,
          context: { ticketState: 'awaiting_ticket_fields', pendingTicket: { ...pending, ...extracted } },
        },
      };
    }

    const ticket = await tickets.createTicket(userId, {
      title,
      description: extracted.description || pending.description || '',
      priority: extracted.priority || pending.priority || 'normal',
      section: extracted.section || pending.section || 'inbox',
      tags: extracted.tags || pending.tags || [],
    });

    return {
      success: true,
      message: `Created ticket "${ticket.title}" (${ticket.id}), priority: ${ticket.priority}, section: ${ticket.section}.`,
    };
  },

  async _resumeBlock(query, context) {
    const userId = await tickets.resolveUserId();
    if (!userId) {
      return { success: true, message: 'I can\'t access your tickets yet -- no userId found. Log into OneReach or set "ticketsUserId" in Settings.' };
    }

    const ticketId = context.ticketId;

    if (!ticketId) {
      const idMatch = query.match(/tsk_[a-z0-9]{9}/);
      if (idMatch) {
        const reason = context.reason || query.replace(idMatch[0], '').trim() || 'Blocked (no reason given)';
        const updated = await tickets.updateTicket(userId, idMatch[0], {
          isBlocked: true,
          status: 'blocked',
          blockedReason: reason,
        });
        return { success: true, message: `Marked "${updated.title}" (${updated.id}) as blocked. Reason: ${reason}` };
      }
      return { success: false, message: 'I need a ticket ID (tsk_...) to mark as blocked.' };
    }

    const reason = query.trim() || 'Blocked (no reason given)';
    const updated = await tickets.updateTicket(userId, ticketId, {
      isBlocked: true,
      status: 'blocked',
      blockedReason: reason,
    });

    return { success: true, message: `Marked "${updated.title}" (${updated.id}) as blocked. Reason: ${reason}` };
  },

  async _resumeAssign(query, context) {
    const userId = await tickets.resolveUserId();
    if (!userId) {
      return { success: true, message: 'I can\'t access your tickets yet -- no userId found. Log into OneReach or set "ticketsUserId" in Settings.' };
    }

    let ticketId = context.ticketId;
    let assignee = context.assignee;

    if (!ticketId) {
      const idMatch = query.match(/tsk_[a-z0-9]{9}/);
      if (idMatch) {
        ticketId = idMatch[0];
        assignee = assignee || query.replace(idMatch[0], '').trim();
      }
    }

    if (!assignee) {
      assignee = query.trim();
    }

    if (!ticketId || !assignee) {
      return { success: false, message: 'I need both a ticket ID and an assignee name to make the assignment.' };
    }

    const updated = await tickets.updateTicket(userId, ticketId, {
      assignedTo: assignee,
    });

    return {
      success: true,
      message: `Assigned "${updated.title}" (${updated.id}) to ${assignee}.`,
    };
  },
};

module.exports = ticketsAgent;
