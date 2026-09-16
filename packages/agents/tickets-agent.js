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

// ── Daily-brief read path (2026-09-15) ──────────────────────────────────────
// Open tickets live in the NEON graph (the Tickets app's :Ticket nodes --
// 595 of them, with pipeline build stages BELONGS_TO the user's playbooks);
// the Agentic TMS KV store this agent writes holds one test row. The brief
// reads the graph read-only through lib/neon-read-client (no local graph
// credential needed), scoped to the signed-in user: tickets they created,
// or tickets in playbooks they created. Both stores are merged.
const OPEN_STATUSES = ['open', 'pending', 'in_progress', 'in progress', 'blocked'];
const OPEN_TICKETS_FOR_USER = `MATCH (t:Ticket)
WHERE toLower(coalesce(t.status, '')) IN $statuses
OPTIONAL MATCH (t)-[:BELONGS_TO]->(pb:Playbook)
OPTIONAL MATCH (creator:Person)-[:CREATED]->(pb)
WITH t, collect(DISTINCT coalesce(pb.name, pb.title)) AS playbooks, collect(DISTINCT creator.id) AS creators
WHERE t.created_by_user = $user OR $user IN creators
RETURN t.id AS id, t.title AS title, t.status AS status, t.priority AS priority, t.section AS section,
       t.is_blocked AS isBlocked, t.created_by_user AS createdBy, t.created_by_app_name AS app,
       coalesce(t.ticket_updated_at, t.updatedAt, t.updated_at, t.created_at) AS updated,
       [p IN playbooks WHERE p IS NOT NULL][0] AS playbook
ORDER BY updated DESC
LIMIT 200`;
const KV_READ_TIMEOUT_MS = 3000;

let _briefDeps = null;
function _setBriefDepsForTests(deps) {
  _briefDeps = deps || null;
}

function _toMs(v) {
  if (v === null || v === undefined) return 0;
  if (typeof v === 'number') return v;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : 0;
}

function _ago(ms, now) {
  if (!ms) return 'no date';
  const h = Math.round((now - ms) / 3600000);
  if (h < 1) return 'just now';
  if (h < 24) return `${h} hr${h === 1 ? '' : 's'} ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}

function _statusLabel(status) {
  const s = String(status || '').toLowerCase().replace(/\s+/g, '_');
  if (s === 'in_progress') return 'In progress';
  if (s === 'blocked') return 'Blocked';
  if (s === 'pending') return 'Pending';
  return 'Open';
}

function _normalizeTicket(row, source) {
  const status = String((row && row.status) || '').toLowerCase().replace(/\s+/g, '_');
  const title = String((row && row.title) || '').trim() || 'Untitled ticket';
  const stage = title.match(/^Stage:\s*(.+)$/i);
  return {
    id: row && row.id,
    title,
    status,
    blocked: !!(row && (row.isBlocked === true || row.is_blocked === true)) || status === 'blocked',
    priority: String((row && row.priority) || '').toLowerCase() || null,
    section: (row && row.section) || null,
    playbook: (row && row.playbook) || null,
    updatedMs: _toMs(row && (row.updated !== undefined ? row.updated : row.updatedAt)),
    source,
    stage: stage ? stage[1].trim() : null,
  };
}

/**
 * Compress open tickets into { line, spoken } items and a section text.
 * Blocked first, then the most recently touched regular tickets, then the
 * pipeline "Stage: ..." tickets grouped by playbook. Pure; exported for tests.
 */
function compressTickets(graphRows, kvRows, { now = Date.now() } = {}) {
  const seen = new Set();
  const all = [];
  for (const r of graphRows || []) {
    const t = _normalizeTicket(r, 'graph');
    if (t.id && seen.has(t.id)) continue;
    if (t.id) seen.add(t.id);
    all.push(t);
  }
  for (const r of kvRows || []) {
    const t = _normalizeTicket(r, 'tms');
    if (t.id && seen.has(t.id)) continue;
    if (t.id) seen.add(t.id);
    all.push(t);
  }
  const blocked = all.filter((t) => t.blocked).sort((a, b) => b.updatedMs - a.updatedMs);
  const stages = all.filter((t) => t.stage && !t.blocked);
  const regular = all.filter((t) => !t.stage && !t.blocked).sort((a, b) => b.updatedMs - a.updatedMs);

  const byPlaybook = new Map();
  for (const s of stages) {
    const key = s.playbook || 'an unnamed playbook';
    const g = byPlaybook.get(key) || { playbook: key, stages: [], updatedMs: 0 };
    g.stages.push(s.stage);
    g.updatedMs = Math.max(g.updatedMs, s.updatedMs);
    byPlaybook.set(key, g);
  }
  const groups = [...byPlaybook.values()].sort((a, b) => b.updatedMs - a.updatedMs);

  const items = [];
  for (const t of blocked.slice(0, 3)) {
    items.push({
      kind: 'blocked',
      line: `Blocked · ${t.title}${t.playbook ? ` · ${t.playbook}` : ''} · ${_ago(t.updatedMs, now)}`,
      spoken: `${t.title} is blocked.`,
    });
  }
  for (const t of regular.slice(0, 3)) {
    const pri = t.priority && !['normal', 'medium'].includes(t.priority) ? ` · ${t.priority}` : '';
    items.push({
      kind: 'open',
      line: `${_statusLabel(t.status)} · ${t.title}${pri}${t.playbook ? ` · ${t.playbook}` : ''} · ${_ago(t.updatedMs, now)}`,
      spoken: `${t.title}, ${_statusLabel(t.status).toLowerCase()}.`,
    });
  }
  for (const g of groups.slice(0, 2)) {
    const distinct = [...new Set(g.stages)];
    items.push({
      kind: 'stages',
      line: `${g.playbook} · ${g.stages.length} build stage ticket${g.stages.length !== 1 ? 's' : ''} open (${distinct.join(', ')})`,
      spoken: `${g.playbook} has ${g.stages.length} build stage ticket${g.stages.length !== 1 ? 's' : ''} open.`,
    });
  }

  const counts = {
    open: all.length,
    blocked: blocked.length,
    regular: regular.length,
    stages: stages.length,
    playbooksWithStages: groups.length,
    graph: (graphRows || []).length,
    tms: (kvRows || []).length,
  };
  let headline;
  if (all.length === 0) headline = 'No open tickets';
  else {
    headline = `${all.length} open ticket${all.length !== 1 ? 's' : ''}`;
    if (stages.length === all.length) headline += ', all of them pipeline build stages';
    else if (stages.length) headline += ` (${stages.length} pipeline build stages)`;
    headline += blocked.length ? `, ${blocked.length} blocked` : ', none blocked';
  }
  const lines = [
    `${headline}${groups.length ? ` across ${groups.length} playbook${groups.length !== 1 ? 's' : ''}` : ''}.`,
  ];
  if (items.length) {
    lines.push('Open items (blocked first, then most recent):');
    for (const it of items) lines.push(`- ${it.line}`);
  }
  if (groups.length > 2) {
    lines.push(
      `Other playbooks with open build stages: ${groups
        .slice(2)
        .map((g) => `${g.playbook} (${g.stages.length})`)
        .join(', ')}.`
    );
  }
  return { headline, content: lines.join('\n'), items, counts };
}

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
  // Daily-brief budget: graph read + KV read measured 3.5 s (2026-09-15).
  briefingTimeoutMs: 8000,
  dataSources: ['edison-kv', 'neon-graph'],

  /**
   * Daily-brief contribution: the user's open tickets (NEON :Ticket nodes
   * scoped to the user + the Agentic TMS KV store), compressed to a few
   * { line, spoken } items. Read-only.
   */
  async getBriefing() {
    const section = 'Tickets';
    try {
      const deps = _briefDeps || {};
      // resolveUserId reads the keychain; bound it so a stalled keychain
      // never holds the whole brief.
      const userId =
        deps.userId !== undefined
          ? deps.userId
          : await Promise.race([
              tickets.resolveUserId().catch(() => null),
              new Promise((resolve) => {
                const t = setTimeout(() => resolve(null), 2500);
                if (typeof t.unref === 'function') t.unref();
              }),
            ]);
      if (!userId) {
        return {
          section,
          priority: 6,
          content: "Tickets: I can't tell which tickets are yours yet -- no signed-in OneReach email.",
          items: [],
        };
      }
      const read = deps.read || require('../../lib/neon-read-client').neonRead;
      let graphRows = [];
      let graphError = null;
      try {
        graphRows = await read(OPEN_TICKETS_FOR_USER, { user: userId, statuses: OPEN_STATUSES });
      } catch (err) {
        graphError = err.message;
        log.warn('tickets-agent', 'brief: ticket graph read failed', { error: err.message });
      }
      let kvRows = [];
      try {
        const kvAll = deps.kvAll ? deps.kvAll(userId) : tickets.getAllTickets(userId);
        const all = await Promise.race([
          kvAll,
          new Promise((_, rej) => {
            setTimeout(() => rej(new Error('KV ticket read timed out')), KV_READ_TIMEOUT_MS).unref?.();
          }),
        ]);
        kvRows = (all || []).filter((t) => t && !t.isCompleted);
      } catch (err) {
        log.info('tickets-agent', 'brief: KV ticket read skipped', { error: err.message });
      }
      if (graphError && kvRows.length === 0) {
        return { section, priority: 6, content: 'Tickets are unavailable right now (ticket graph unreachable).', items: [] };
      }
      const summary = compressTickets(graphRows, kvRows, { now: deps.now || Date.now() });
      return { section, priority: 6, content: summary.content, headline: summary.headline, items: summary.items, counts: summary.counts };
    } catch (err) {
      log.warn('tickets-agent', 'getBriefing failed', { error: err.message });
      return { section, priority: 6, content: null };
    }
  },

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

// Test seams for the daily-brief read path.
ticketsAgent._setBriefDepsForTests = _setBriefDepsForTests;
ticketsAgent._compressTickets = compressTickets;
ticketsAgent._OPEN_TICKETS_FOR_USER = OPEN_TICKETS_FOR_USER;

module.exports = ticketsAgent;
