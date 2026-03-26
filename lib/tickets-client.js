/**
 * Tickets Client
 *
 * Read/write client for the Agentic TMS ticket data stored in Edison Key/Value.
 * Follows the same wire protocol as the Tickets SDK (@onereach/tickets-sdk)
 * so both apps see the same data.
 *
 * KV endpoint: https://em.edison.api.onereach.ai/http/{accountId}/keyvalue
 * Namespace:   tms:tickets:{userId}
 * Keys:        "index" (string[] of ticket IDs), "ticket:{id}" (full ticket)
 */

'use strict';

const crypto = require('crypto');
const { getLogQueue } = require('./log-event-queue');
const log = getLogQueue();

const TICKETS_ACCOUNT_ID = '35254342-4a2e-475b-aec1-18547e517e29';
const TOKEN_TTL_MS = 50 * 60 * 1000; // 50 minutes

const VALID_PRIORITIES = ['urgent', 'normal', 'low'];
const VALID_STATUSES = ['pending', 'running', 'completed', 'blocked'];
const VALID_SECTIONS = ['inbox', 'next-actions', 'waiting', 'someday'];

// ---------------------------------------------------------------------------
// Auth -- call refresh_token directly (same as the Tickets web app)
// ---------------------------------------------------------------------------

let _tokenCache = null; // { token, expiresAt }

function getAccountId() {
  const sm = global.settingsManager;
  if (sm) {
    const all = sm.getAll();
    if (all.ticketsAccountId) return all.ticketsAccountId;
  }
  return TICKETS_ACCOUNT_ID;
}

async function getAuthToken() {
  if (_tokenCache && Date.now() < _tokenCache.expiresAt) {
    return _tokenCache.token;
  }

  const accountId = getAccountId();
  const url = `https://em.edison.api.onereach.ai/http/${accountId}/refresh_token`;

  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`Token refresh failed (${resp.status}). Ensure the refresh_token flow is deployed for account ${accountId}.`);
  }

  const data = await resp.json();
  let token = data.token || data.access_token || '';
  if (!token) throw new Error('No token in refresh_token response');

  token = token.startsWith('FLOW ') ? token : `FLOW ${token}`;

  _tokenCache = { token, expiresAt: Date.now() + TOKEN_TTL_MS };
  log.info('tickets-client', 'Token acquired via refresh_token');
  return token;
}

function getKVUrl() {
  return `https://em.edison.api.onereach.ai/http/${getAccountId()}/keyvalue`;
}

function collectionId(userId) {
  return `tms:tickets:${userId}`;
}

async function kvGet(collection, key) {
  const token = await getAuthToken();
  const url = `${getKVUrl()}?id=${encodeURIComponent(collection)}&key=${encodeURIComponent(key)}`;

  const resp = await fetch(url, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json', Authorization: token },
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`KV GET failed (${resp.status}): ${text}`);
  }

  const text = await resp.text();
  if (!text || text === 'null' || text === '""') return null;

  const parsed = JSON.parse(text);
  if (parsed?.Status === 'No data found.' || parsed?.status === 'No data found.') return null;

  let value = parsed.get?.value ?? parsed.value ?? parsed.data?.value ?? parsed;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { /* keep as string */ }
  }
  return value;
}

async function kvPut(collection, key, value) {
  const token = await getAuthToken();
  const url = `${getKVUrl()}?id=${encodeURIComponent(collection)}&key=${encodeURIComponent(key)}`;

  const resp = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: token },
    body: JSON.stringify({ id: collection, key, value }),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`KV PUT failed (${resp.status}): ${text}`);
  }
}

async function kvDelete(collection, key) {
  const token = await getAuthToken();
  const url = `${getKVUrl()}?id=${encodeURIComponent(collection)}&key=${encodeURIComponent(key)}`;

  const resp = await fetch(url, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', Authorization: token },
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`KV DELETE failed (${resp.status}): ${text}`);
  }
}

// ---------------------------------------------------------------------------
// ID generation (matches SDK format: tsk_ + 9 random alphanumeric)
// ---------------------------------------------------------------------------

function generateTicketId() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.randomBytes(9);
  let id = 'tsk_';
  for (let i = 0; i < 9; i++) id += chars[bytes[i] % chars.length];
  return id;
}

function generateActivityId() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.randomBytes(9);
  let id = 'act_';
  for (let i = 0; i < 9; i++) id += chars[bytes[i] % chars.length];
  return id;
}

// ---------------------------------------------------------------------------
// Key listing (fallback when index is missing)
// ---------------------------------------------------------------------------

async function kvListKeys(collection) {
  const token = await getAuthToken();
  const resp = await fetch(getKVUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: token },
    body: JSON.stringify({ id: collection }),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`KV POST (list keys) failed (${resp.status}): ${text}`);
  }

  const data = await resp.json();
  const records = data?.getStorageData?.records || data?.records || data?.data?.records || data;
  if (!Array.isArray(records)) return [];

  return records
    .map((r) => (typeof r === 'string' ? r : r?.key))
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Read operations
// ---------------------------------------------------------------------------

async function getTicketIndex(userId) {
  const idx = await kvGet(collectionId(userId), 'index');
  if (Array.isArray(idx) && idx.length > 0) return idx;

  // Fallback: list all keys and extract ticket IDs
  const keys = await kvListKeys(collectionId(userId));
  const ticketIds = keys
    .filter((k) => k.startsWith('ticket:'))
    .map((k) => k.replace('ticket:', ''));

  if (ticketIds.length > 0) {
    log.info('tickets-client', 'Index missing, rebuilt from key listing', { count: ticketIds.length });
    // Repair the index so future lookups are fast
    await kvPut(collectionId(userId), 'index', ticketIds).catch((err) => {
      log.warn('tickets-client', 'Failed to repair index', { error: err.message });
    });
  }

  return ticketIds;
}

async function getTicket(userId, ticketId) {
  return kvGet(collectionId(userId), `ticket:${ticketId}`);
}

async function getAllTickets(userId) {
  const ids = await getTicketIndex(userId);
  if (ids.length === 0) return [];

  const tickets = await Promise.all(ids.map((id) => getTicket(userId, id)));
  return tickets.filter(Boolean);
}

async function getTicketsByFilter(userId, opts = {}) {
  const all = await getAllTickets(userId);
  return all.filter((t) => {
    if (opts.status && t.status !== opts.status) return false;
    if (opts.priority && t.priority !== opts.priority) return false;
    if (opts.section && t.section !== opts.section) return false;
    if (opts.assignedTo && t.assignedTo !== opts.assignedTo) return false;
    if (opts.isBlocked !== undefined && t.isBlocked !== opts.isBlocked) return false;
    if (opts.isCompleted !== undefined && t.isCompleted !== opts.isCompleted) return false;
    return true;
  });
}

// ---------------------------------------------------------------------------
// Write operations
// ---------------------------------------------------------------------------

async function createTicket(userId, input) {
  if (!input.title || !input.title.trim()) throw new Error('Ticket title is required');
  if (!input.description) input.description = '';

  const id = generateTicketId();
  const now = new Date().toISOString();

  const ticket = {
    id,
    title: input.title.trim(),
    description: (input.description || '').trim(),
    priority: VALID_PRIORITIES.includes(input.priority) ? input.priority : 'normal',
    status: VALID_STATUSES.includes(input.status) ? input.status : 'pending',
    section: VALID_SECTIONS.includes(input.section) ? input.section : 'inbox',
    tags: Array.isArray(input.tags) ? input.tags : [],
    isCompleted: false,
    isBlocked: false,
    isTwoMinute: !!input.isTwoMinute,
    potentialCoins: typeof input.potentialCoins === 'number' ? input.potentialCoins : 10,
    preFlightChecklist: [],
    completionChecklist: [],
    activityLog: [
      {
        id: generateActivityId(),
        type: 'created',
        description: 'Ticket created via agent',
        timestamp: now,
        userId,
      },
    ],
    assets: [],
    createdBy: userId,
    createdAt: now,
    updatedAt: now,
  };

  if (input.assignedTo) ticket.assignedTo = input.assignedTo;
  if (input.objectiveId) ticket.objectiveId = input.objectiveId;
  if (input.timeEstimate) ticket.timeEstimate = input.timeEstimate;
  if (input.collectionPoint) ticket.collectionPoint = input.collectionPoint;

  const col = collectionId(userId);
  await kvPut(col, `ticket:${id}`, ticket);

  const index = await getTicketIndex(userId);
  if (!index.includes(id)) {
    index.push(id);
    await kvPut(col, 'index', index);
  }

  log.info('tickets-client', 'Ticket created', { ticketId: id, title: ticket.title });
  return ticket;
}

async function updateTicket(userId, ticketId, updates) {
  const existing = await getTicket(userId, ticketId);
  if (!existing) throw new Error(`Ticket not found: ${ticketId}`);

  const now = new Date().toISOString();
  const activityLog = [...(existing.activityLog || [])];

  if (updates.status && updates.status !== existing.status) {
    activityLog.push({
      id: generateActivityId(),
      type: 'status_changed',
      description: `Status changed from ${existing.status} to ${updates.status}`,
      timestamp: now,
      userId,
      metadata: { from: existing.status, to: updates.status },
    });
  }

  if (updates.assignedTo && updates.assignedTo !== existing.assignedTo) {
    activityLog.push({
      id: generateActivityId(),
      type: 'assigned',
      description: `Assigned to ${updates.assignedTo}`,
      timestamp: now,
      userId,
      metadata: { from: existing.assignedTo, to: updates.assignedTo },
    });
  }

  if (updates.isBlocked && !existing.isBlocked) {
    activityLog.push({
      id: generateActivityId(),
      type: 'blocked',
      description: updates.blockedReason || 'Ticket blocked',
      timestamp: now,
      userId,
    });
  }

  if (updates.isBlocked === false && existing.isBlocked) {
    activityLog.push({
      id: generateActivityId(),
      type: 'unblocked',
      description: 'Ticket unblocked',
      timestamp: now,
      userId,
    });
  }

  const updated = {
    ...existing,
    ...updates,
    id: ticketId,
    activityLog,
    updatedAt: now,
  };

  if (updates.isCompleted && !existing.isCompleted) {
    updated.completedAt = now;
  }

  await kvPut(collectionId(userId), `ticket:${ticketId}`, updated);
  log.info('tickets-client', 'Ticket updated', { ticketId, updates: Object.keys(updates) });
  return updated;
}

async function deleteTicket(userId, ticketId) {
  const col = collectionId(userId);
  await kvDelete(col, `ticket:${ticketId}`);

  const index = await getTicketIndex(userId);
  const filtered = index.filter((id) => id !== ticketId);
  await kvPut(col, 'index', filtered);

  log.info('tickets-client', 'Ticket deleted', { ticketId });
  return true;
}

// ---------------------------------------------------------------------------
// Stats helper
// ---------------------------------------------------------------------------

async function getTicketStats(userId) {
  const all = await getAllTickets(userId);
  const stats = {
    total: all.length,
    byStatus: {},
    byPriority: {},
    bySection: {},
    blocked: 0,
    completed: 0,
    open: 0,
  };

  for (const t of all) {
    stats.byStatus[t.status] = (stats.byStatus[t.status] || 0) + 1;
    stats.byPriority[t.priority] = (stats.byPriority[t.priority] || 0) + 1;
    stats.bySection[t.section] = (stats.bySection[t.section] || 0) + 1;
    if (t.isBlocked) stats.blocked++;
    if (t.isCompleted) stats.completed++;
    if (!t.isCompleted && !t.isBlocked) stats.open++;
  }

  return stats;
}

// ---------------------------------------------------------------------------
// userId resolution
// ---------------------------------------------------------------------------

let _cachedUserId = null;

async function resolveUserId() {
  if (_cachedUserId) return _cachedUserId;

  // 1. Explicit setting takes priority
  const sm = global.settingsManager;
  if (sm) {
    const all = sm.getAll();
    if (all.ticketsUserId) {
      _cachedUserId = all.ticketsUserId;
      return _cachedUserId;
    }
  }

  // 2. Derive from OneReach credentials email (the Tickets app uses email as userId)
  try {
    const credentialManager = require('../credential-manager');
    const creds = await credentialManager.getOneReachCredentials();
    if (creds && creds.email) {
      _cachedUserId = creds.email;
      log.info('tickets-client', 'Resolved userId from credentials', { userId: creds.email });
      return _cachedUserId;
    }
  } catch (err) {
    log.warn('tickets-client', 'Could not read credentials for userId', { error: err.message });
  }

  return null;
}

function clearUserIdCache() {
  _cachedUserId = null;
}

module.exports = {
  getTicket,
  getTicketIndex,
  getAllTickets,
  getTicketsByFilter,
  getTicketStats,
  createTicket,
  updateTicket,
  deleteTicket,
  resolveUserId,
  clearUserIdCache,
  VALID_PRIORITIES,
  VALID_STATUSES,
  VALID_SECTIONS,
};
