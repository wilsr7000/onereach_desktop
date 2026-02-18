/**
 * ContactStore - Shared Contact Management for Meeting Guests
 *
 * Provides a centralized contact book with a fast synchronous in-memory API
 * backed by DuckDB for persistent canonical storage and meeting analytics.
 *
 * Architecture:
 *   - In-memory array for sync reads (search, resolve, suggest)
 *   - DuckDB write-through on mutations (add, update, delete, recordUsage)
 *   - DuckDB is source of truth; JSON file is a fallback cache
 *   - Meeting attendance tracking via DuckDB (who attends which meetings)
 *
 * Storage:
 *   - DuckDB: ~/Documents/OR-Spaces/contact-store/contacts.duckdb
 *   - JSON fallback: ~/Documents/OR-Spaces/contact-store/contacts.json
 *
 * @module ContactStore
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getLogQueue } = require('./log-event-queue');
const log = getLogQueue();

// DuckDB backend for canonical storage and analytics
const { getContactDB } = require('./contact-db');

// ─── Constants ───────────────────────────────────────────────────────────────

const STORE_DIR_NAME = 'contact-store';
const CONTACTS_FILE = 'contacts.json';
const SPACES_BASE = path.join(process.env.HOME || process.env.USERPROFILE || '.', 'Documents', 'OR-Spaces');

// Email validation: practical pattern that catches most real emails
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function uuid() {
  return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
}

/**
 * Normalize a name for comparison (lowercase, collapse whitespace, strip titles).
 */
function normalizeName(name) {
  if (!name) return '';
  return name
    .toLowerCase()
    .replace(/\b(mr|mrs|ms|dr|prof)\b\.?\s*/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Calculate a simple similarity score between two strings (0-1).
 * Uses longest common subsequence ratio.
 */
function similarity(a, b) {
  if (!a || !b) return 0;
  const al = a.toLowerCase();
  const bl = b.toLowerCase();
  if (al === bl) return 1;
  if (al.includes(bl) || bl.includes(al)) return 0.8;

  // LCS-based similarity
  const m = al.length;
  const n = bl.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = al[i - 1] === bl[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return (2 * dp[m][n]) / (m + n);
}

/**
 * Check if a string is a valid email address.
 */
function isValidEmail(email) {
  return typeof email === 'string' && EMAIL_RE.test(email.trim());
}

// ─── ContactStore ────────────────────────────────────────────────────────────

class ContactStore {
  constructor(storeDir) {
    this._storeDir = storeDir || path.join(SPACES_BASE, STORE_DIR_NAME);
    this._filePath = path.join(this._storeDir, CONTACTS_FILE);
    this._contacts = [];
    this._loaded = false;
    this._dirty = false;
    this._dbInitStarted = false;
    this._dbReady = false;
  }

  // ─── Persistence ─────────────────────────────────────────────────────────

  /**
   * Ensure storage directory exists and load contacts from disk.
   * Also kicks off DuckDB initialization in the background.
   */
  _ensureLoaded() {
    if (this._loaded) return;
    try {
      fs.mkdirSync(this._storeDir, { recursive: true });
      if (fs.existsSync(this._filePath)) {
        const raw = fs.readFileSync(this._filePath, 'utf8');
        const parsed = JSON.parse(raw);
        this._contacts = Array.isArray(parsed) ? parsed : [];
      }
    } catch (err) {
      log.error('contact-store', 'Failed to load contacts', { error: err.message });
      this._contacts = [];
    }
    this._loaded = true;

    // Kick off DuckDB init in background (non-blocking)
    if (!this._dbInitStarted) {
      this._dbInitStarted = true;
      this._initDB().catch((err) => console.warn('[contact-store] initDB background:', err.message));
    }
  }

  /**
   * Initialize DuckDB backend and migrate JSON contacts into it.
   */
  async _initDB() {
    try {
      const db = getContactDB();
      const ok = await db.init();
      if (!ok) return;

      this._dbReady = true;

      // Migrate existing JSON contacts to DuckDB (one-time)
      if (this._contacts.length > 0) {
        const result = await db.importFromJSON(this._contacts);
        if (result.imported > 0) {
          log.info('contact-store', `Migrated ${result.imported} contacts from JSON to DuckDB`);
        }
      }
    } catch (err) {
      log.warn('contact-store', 'DuckDB init failed, using JSON-only mode', { error: err.message });
    }
  }

  /**
   * Persist contacts to JSON (fallback cache) and write-through to DuckDB.
   */
  _save() {
    if (!this._dirty) return;
    try {
      fs.mkdirSync(this._storeDir, { recursive: true });
      fs.writeFileSync(this._filePath, JSON.stringify(this._contacts, null, 2), 'utf8');
      this._dirty = false;
    } catch (err) {
      log.error('contact-store', 'Failed to save contacts', { error: err.message });
    }
  }

  /**
   * Write-through a contact to DuckDB (fire-and-forget).
   */
  _syncToDB(contact) {
    if (!this._dbReady) return;
    getContactDB()
      .upsertContact({
        name: contact.name,
        email: contact.email,
        company: contact.company,
        calendarUrl: contact.calendarUrl,
        notes: contact.notes,
        source: contact.source,
      })
      .catch((err) => {
        log.warn('contact-store', 'DuckDB write-through failed', { error: err.message });
      });
  }

  /**
   * Record meeting attendance in DuckDB for a calendar event.
   * Call this after creating an event with guests.
   *
   * @param {Object} event - Event with title, startTime, endTime, guests[]
   */
  async ingestMeetingAttendees(event) {
    if (!this._dbReady) {
      // Queue for later if DB not ready yet
      try {
        const db = getContactDB();
        await db.init();
        this._dbReady = true;
      } catch {
        return;
      }
    }
    await getContactDB().ingestEvent(event);
  }

  /**
   * Batch ingest calendar events to build the meeting attendance history.
   *
   * @param {Object[]} events - Array of calendar events
   * @returns {{ processed: number, contacts: number, attendance: number }}
   */
  async ingestCalendarEvents(events) {
    if (!this._dbReady) {
      try {
        const db = getContactDB();
        await db.init();
        this._dbReady = true;
      } catch {
        return { processed: 0, contacts: 0, attendance: 0 };
      }
    }
    return getContactDB().ingestEvents(events);
  }

  /**
   * Get contacts ranked by meeting frequency.
   *
   * @param {Object} [opts] - { limit, since }
   * @returns {Promise<Object[]>}
   */
  async getFrequentContacts(opts = {}) {
    if (!this._dbReady) return [];
    return getContactDB().getFrequentContacts(opts);
  }

  /**
   * Get meeting history for a contact.
   *
   * @param {string} contactEmailOrId
   * @param {Object} [opts]
   * @returns {Promise<Object[]>}
   */
  async getContactMeetings(contactEmailOrId, opts = {}) {
    if (!this._dbReady) return [];
    return getContactDB().getContactMeetings(contactEmailOrId, opts);
  }

  /**
   * Get co-attendees for a contact.
   *
   * @param {string} contactEmail
   * @param {number} [limit]
   * @returns {Promise<Object[]>}
   */
  async getCoAttendees(contactEmail, limit) {
    if (!this._dbReady) return [];
    return getContactDB().getCoAttendees(contactEmail, limit);
  }

  // ─── CRUD ────────────────────────────────────────────────────────────────

  /**
   * Add or update a contact. If a contact with the same email exists, merge.
   *
   * @param {Object} data
   * @param {string} data.name - Display name (required)
   * @param {string} data.email - Email address (required, must be valid)
   * @param {string[]} [data.aliases] - Alternative names (e.g. nicknames)
   * @param {string} [data.calendarUrl] - External calendar API URL
   * @param {string} [data.company] - Company / organization
   * @param {string} [data.notes] - Free-form notes
   * @param {string} [data.source] - Where this contact was learned ('manual' | 'calendar' | 'email' | 'voice')
   * @returns {Object} The created or updated contact
   */
  addContact(data) {
    this._ensureLoaded();

    if (!data.name || !data.email) {
      throw new Error('Contact requires both name and email');
    }

    const email = data.email.trim().toLowerCase();
    if (!isValidEmail(email)) {
      throw new Error(`Invalid email address: ${data.email}`);
    }

    // Check for existing contact with same email
    const existing = this._contacts.find((c) => c.email === email);
    if (existing) {
      return this._mergeContact(existing, data);
    }

    const contact = {
      id: uuid(),
      name: data.name.trim(),
      email,
      aliases: (data.aliases || []).map((a) => a.trim()).filter(Boolean),
      calendarUrl: data.calendarUrl || null,
      company: data.company || null,
      notes: data.notes || null,
      source: data.source || 'manual',
      usageCount: 0,
      lastUsed: null,
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
    };

    this._contacts.push(contact);
    this._dirty = true;
    this._save();
    this._syncToDB(contact);

    log.info('contact-store', 'Contact added', { name: contact.name, email: contact.email });
    return contact;
  }

  /**
   * Merge new data into an existing contact.
   */
  _mergeContact(existing, data) {
    let changed = false;

    // Update name if the new one looks more complete
    if (data.name && data.name.trim().length > existing.name.length) {
      existing.name = data.name.trim();
      changed = true;
    }

    // Merge aliases (deduplicate)
    if (data.aliases && data.aliases.length > 0) {
      const current = new Set(existing.aliases.map((a) => a.toLowerCase()));
      for (const alias of data.aliases) {
        if (alias && !current.has(alias.toLowerCase())) {
          existing.aliases.push(alias.trim());
          changed = true;
        }
      }
    }

    // Update calendar URL if not set
    if (data.calendarUrl && !existing.calendarUrl) {
      existing.calendarUrl = data.calendarUrl;
      changed = true;
    }

    // Update company if not set
    if (data.company && !existing.company) {
      existing.company = data.company;
      changed = true;
    }

    if (changed) {
      existing.updated = new Date().toISOString();
      this._dirty = true;
      this._save();
      this._syncToDB(existing);
    }

    return existing;
  }

  /**
   * Get a contact by ID.
   */
  getContact(id) {
    this._ensureLoaded();
    return this._contacts.find((c) => c.id === id) || null;
  }

  /**
   * Get a contact by exact email.
   */
  getByEmail(email) {
    this._ensureLoaded();
    if (!email) return null;
    const normalized = email.trim().toLowerCase();
    return this._contacts.find((c) => c.email === normalized) || null;
  }

  /**
   * Update a contact by ID.
   *
   * @param {string} id - Contact ID
   * @param {Object} changes - Fields to update
   * @returns {Object|null} Updated contact or null if not found
   */
  updateContact(id, changes) {
    this._ensureLoaded();
    const contact = this._contacts.find((c) => c.id === id);
    if (!contact) return null;

    const allowed = ['name', 'email', 'aliases', 'calendarUrl', 'company', 'notes'];
    for (const key of allowed) {
      if (changes[key] !== undefined) {
        if (key === 'email') {
          const email = changes.email.trim().toLowerCase();
          if (!isValidEmail(email)) {
            throw new Error(`Invalid email address: ${changes.email}`);
          }
          contact.email = email;
        } else {
          contact[key] = changes[key];
        }
      }
    }

    contact.updated = new Date().toISOString();
    this._dirty = true;
    this._save();
    return contact;
  }

  /**
   * Delete a contact by ID.
   */
  deleteContact(id) {
    this._ensureLoaded();
    const idx = this._contacts.findIndex((c) => c.id === id);
    if (idx === -1) return false;
    this._contacts.splice(idx, 1);
    this._dirty = true;
    this._save();
    return true;
  }

  /**
   * Get all contacts, optionally sorted.
   *
   * @param {Object} [opts]
   * @param {string} [opts.sortBy] - 'name' | 'recent' | 'frequent' (default: 'name')
   * @returns {Object[]}
   */
  getAllContacts(opts = {}) {
    this._ensureLoaded();
    const sorted = [...this._contacts];
    const sortBy = opts.sortBy || 'name';

    if (sortBy === 'recent') {
      sorted.sort((a, b) => {
        if (!a.lastUsed && !b.lastUsed) return 0;
        if (!a.lastUsed) return 1;
        if (!b.lastUsed) return -1;
        return new Date(b.lastUsed) - new Date(a.lastUsed);
      });
    } else if (sortBy === 'frequent') {
      sorted.sort((a, b) => (b.usageCount || 0) - (a.usageCount || 0));
    } else {
      sorted.sort((a, b) => a.name.localeCompare(b.name));
    }

    return sorted;
  }

  // ─── Search & Suggestions ────────────────────────────────────────────────

  /**
   * Search contacts by name, alias, email, or company.
   * Returns results ranked by relevance.
   *
   * @param {string} query - Search query
   * @param {Object} [opts]
   * @param {number} [opts.limit] - Max results (default: 10)
   * @param {number} [opts.minScore] - Minimum similarity score (default: 0.3)
   * @returns {Object[]} Array of { contact, score, matchField }
   */
  search(query, opts = {}) {
    this._ensureLoaded();
    if (!query || !query.trim()) return [];

    const q = normalizeName(query);
    const limit = opts.limit || 10;
    const minScore = opts.minScore || 0.3;
    const results = [];

    for (const contact of this._contacts) {
      let bestScore = 0;
      let matchField = 'name';

      // Check name
      const nameScore = similarity(q, normalizeName(contact.name));
      if (nameScore > bestScore) {
        bestScore = nameScore;
        matchField = 'name';
      }

      // Check aliases
      for (const alias of contact.aliases || []) {
        const aliasScore = similarity(q, normalizeName(alias));
        if (aliasScore > bestScore) {
          bestScore = aliasScore;
          matchField = 'alias';
        }
      }

      // Check email prefix (before @)
      const emailPrefix = contact.email.split('@')[0];
      const emailScore = similarity(q, emailPrefix) * 0.9; // slight discount
      if (emailScore > bestScore) {
        bestScore = emailScore;
        matchField = 'email';
      }

      // Check company
      if (contact.company) {
        const companyScore = similarity(q, normalizeName(contact.company)) * 0.7;
        if (companyScore > bestScore) {
          bestScore = companyScore;
          matchField = 'company';
        }
      }

      // Boost score for frequently used contacts (meaningful boost per use)
      const usageBoost = Math.min(0.15, (contact.usageCount || 0) * 0.03);
      bestScore = Math.min(1, bestScore + usageBoost);

      if (bestScore >= minScore) {
        results.push({ contact, score: bestScore, matchField });
      }
    }

    // Sort by score descending, then by usage
    results.sort((a, b) => {
      const scoreDiff = b.score - a.score;
      if (Math.abs(scoreDiff) > 0.05) return scoreDiff;
      return (b.contact.usageCount || 0) - (a.contact.usageCount || 0);
    });

    return results.slice(0, limit);
  }

  /**
   * Resolve a guest string (name or email) to an email address.
   *
   * @param {string} guest - Name, email, or partial match
   * @returns {{ email: string|null, contact: Object|null, confidence: string }}
   *   confidence: 'exact' | 'high' | 'low' | 'none'
   */
  resolveGuest(guest) {
    this._ensureLoaded();
    if (!guest || !guest.trim()) return { email: null, contact: null, confidence: 'none' };

    const g = guest.trim();

    // Already an email
    if (isValidEmail(g)) {
      const contact = this.getByEmail(g);
      return { email: g.toLowerCase(), contact, confidence: 'exact' };
    }

    // Search by name
    const results = this.search(g, { limit: 3, minScore: 0.5 });
    if (results.length === 0) {
      return { email: null, contact: null, confidence: 'none' };
    }

    const top = results[0];
    if (top.score >= 0.9) {
      return { email: top.contact.email, contact: top.contact, confidence: 'exact' };
    }
    if (top.score >= 0.7) {
      return { email: top.contact.email, contact: top.contact, confidence: 'high' };
    }
    return { email: top.contact.email, contact: top.contact, confidence: 'low' };
  }

  /**
   * Resolve a list of guest strings. Returns detailed resolution results
   * for each guest, including suggestions for ambiguous matches.
   *
   * @param {string|string[]} guests - Comma-separated string or array of names/emails
   * @returns {Object} { resolved, unresolved, ambiguous }
   *   - resolved: [{ name, email, contact }]
   *   - unresolved: [{ name, suggestions: [] }]
   *   - ambiguous: [{ name, candidates: [{ contact, score }] }]
   */
  resolveGuests(guests) {
    this._ensureLoaded();

    let guestList = [];
    if (Array.isArray(guests)) {
      guestList = guests;
    } else if (typeof guests === 'string') {
      guestList = guests
        .split(',')
        .map((g) => g.trim())
        .filter(Boolean);
    }

    const resolved = [];
    const unresolved = [];
    const ambiguous = [];

    for (const guest of guestList) {
      const result = this.resolveGuest(guest);

      if (result.confidence === 'exact' || result.confidence === 'high') {
        resolved.push({
          name: result.contact ? result.contact.name : guest,
          email: result.email,
          contact: result.contact,
        });
      } else if (result.confidence === 'low') {
        // Low confidence - show as ambiguous with alternatives
        const candidates = this.search(guest, { limit: 3, minScore: 0.3 });
        ambiguous.push({
          name: guest,
          candidates: candidates.map((c) => ({
            contact: c.contact,
            score: c.score,
          })),
        });
      } else {
        // No match at all
        const suggestions = this.search(guest, { limit: 3, minScore: 0.2 });
        unresolved.push({
          name: guest,
          suggestions: suggestions.map((s) => s.contact),
        });
      }
    }

    return { resolved, unresolved, ambiguous };
  }

  /**
   * Suggest guests for autocomplete. Returns contacts matching the partial
   * input, with recently used contacts prioritized.
   *
   * @param {string} partial - Partial name or email to complete
   * @param {Object} [opts]
   * @param {number} [opts.limit] - Max suggestions (default: 5)
   * @param {string[]} [opts.exclude] - Emails to exclude (already added)
   * @returns {Object[]} Array of contact objects
   */
  suggest(partial, opts = {}) {
    this._ensureLoaded();
    const limit = opts.limit || 5;
    const exclude = new Set((opts.exclude || []).map((e) => e.toLowerCase()));

    if (!partial || !partial.trim()) {
      // No input - return most recently used contacts
      return this.getAllContacts({ sortBy: 'recent' })
        .filter((c) => !exclude.has(c.email))
        .slice(0, limit);
    }

    const results = this.search(partial, { limit: limit + exclude.size, minScore: 0.25 });
    return results
      .map((r) => r.contact)
      .filter((c) => !exclude.has(c.email))
      .slice(0, limit);
  }

  // ─── Usage Tracking ──────────────────────────────────────────────────────

  /**
   * Record that a contact was used (e.g. added to a meeting).
   * Increments usage count and updates lastUsed timestamp.
   *
   * @param {string} emailOrId - Email address or contact ID
   */
  recordUsage(emailOrId) {
    this._ensureLoaded();
    const contact = this._contacts.find((c) => c.email === emailOrId?.toLowerCase() || c.id === emailOrId);
    if (!contact) return;

    contact.usageCount = (contact.usageCount || 0) + 1;
    contact.lastUsed = new Date().toISOString();
    this._dirty = true;
    this._save();
  }

  // ─── Bulk Operations ─────────────────────────────────────────────────────

  /**
   * Import contacts from the legacy agent memory format.
   * Parses lines like "- Name: email" or "- Name: email | calendar: URL"
   *
   * @param {string} markdownSection - Raw markdown from agent memory Contacts section
   * @param {string} [source] - Source tag (default: 'legacy-import')
   * @returns {{ imported: number, skipped: number, errors: string[] }}
   */
  importFromMemory(markdownSection, source = 'legacy-import') {
    if (!markdownSection) return { imported: 0, skipped: 0, errors: [] };

    const lines = markdownSection.split('\n');
    let imported = 0;
    let skipped = 0;
    const errors = [];

    for (const line of lines) {
      // Skip comments and empty lines
      if (line.trim().startsWith('*') || !line.trim()) continue;

      // Format: "- Name: email | calendar: URL"
      const calMatch = line.match(/^-?\s*(.+?):\s*([^\s|]+@[^\s|]+)\s*\|\s*calendar:\s*(\S+)/i);
      if (calMatch) {
        try {
          this.addContact({
            name: calMatch[1].trim(),
            email: calMatch[2].trim(),
            calendarUrl: calMatch[3].trim(),
            source,
          });
          imported++;
        } catch (err) {
          errors.push(`${calMatch[1].trim()}: ${err.message}`);
          skipped++;
        }
        continue;
      }

      // Format: "- Name: email"
      const basicMatch = line.match(/^-?\s*(.+?):\s*([^\s|]+@[^\s|]+)/i);
      if (basicMatch) {
        try {
          this.addContact({
            name: basicMatch[1].trim(),
            email: basicMatch[2].trim(),
            source,
          });
          imported++;
        } catch (err) {
          errors.push(`${basicMatch[1].trim()}: ${err.message}`);
          skipped++;
        }
      }
    }

    return { imported, skipped, errors };
  }

  /**
   * Learn contacts from calendar event guest lists.
   * Extracts email addresses and tries to derive names from them.
   *
   * @param {Object[]} events - Array of events from CalendarStore
   * @returns {{ learned: number, existing: number }}
   */
  learnFromEvents(events) {
    if (!Array.isArray(events)) return { learned: 0, existing: 0 };

    let learned = 0;
    let existing = 0;

    for (const event of events) {
      const guests = event.guests || event.attendees || [];
      for (const guest of guests) {
        const email = typeof guest === 'string' ? guest : guest.email || null;
        if (!email || !isValidEmail(email)) continue;

        // Check if already known
        if (this.getByEmail(email)) {
          existing++;
          continue;
        }

        // Derive name from email or attendee object
        let name;
        if (typeof guest === 'object' && guest.displayName) {
          name = guest.displayName;
        } else {
          // Derive from email: john.smith@company.com -> John Smith
          const prefix = email.split('@')[0];
          name = prefix
            .replace(/[._-]/g, ' ')
            .replace(/\b\w/g, (c) => c.toUpperCase())
            .trim();
        }

        try {
          this.addContact({ name, email, source: 'calendar' });
          learned++;
        } catch {
          // Skip invalid
        }
      }
    }

    return { learned, existing };
  }

  /**
   * Build a formatted guest prompt for the user.
   * Generates a helpful message listing resolved, ambiguous, and unresolved guests.
   *
   * @param {Object} resolution - Output of resolveGuests()
   * @returns {{ prompt: string, allResolved: boolean, resolvedEmails: string[] }}
   */
  buildGuestPrompt(resolution) {
    const { resolved, unresolved, ambiguous } = resolution;
    const lines = [];
    const resolvedEmails = resolved.map((r) => r.email);

    if (resolved.length > 0) {
      const names = resolved.map((r) => `${r.name} (${r.email})`);
      lines.push(`Found: ${names.join(', ')}`);
    }

    if (ambiguous.length > 0) {
      for (const a of ambiguous) {
        const options = a.candidates.map((c, i) => `${i + 1}. ${c.contact.name} (${c.contact.email})`).join(', ');
        lines.push(`Did you mean for "${a.name}"? ${options}`);
      }
    }

    if (unresolved.length > 0) {
      const names = unresolved.map((u) => u.name);
      if (unresolved.some((u) => u.suggestions.length > 0)) {
        for (const u of unresolved) {
          if (u.suggestions.length > 0) {
            const sugg = u.suggestions.map((s) => s.name).join(', ');
            lines.push(`I don't have an email for "${u.name}". Similar contacts: ${sugg}. Please provide their email.`);
          } else {
            lines.push(`I don't have an email for "${u.name}". Please provide their email.`);
          }
        }
      } else {
        lines.push(`I need email addresses for: ${names.join(', ')}.`);
      }
    }

    return {
      prompt: lines.join('\n'),
      allResolved: unresolved.length === 0 && ambiguous.length === 0,
      resolvedEmails,
    };
  }

  // ─── Stats ───────────────────────────────────────────────────────────────

  /**
   * Get contact store stats.
   */
  getStats() {
    this._ensureLoaded();
    const total = this._contacts.length;
    const withCalendar = this._contacts.filter((c) => c.calendarUrl).length;
    const sources = {};
    for (const c of this._contacts) {
      sources[c.source || 'unknown'] = (sources[c.source || 'unknown'] || 0) + 1;
    }
    return { total, withCalendar, sources };
  }
}

// ─── Singleton & Exports ─────────────────────────────────────────────────────

let _instance = null;

function getContactStore() {
  if (!_instance) {
    _instance = new ContactStore();
  }
  return _instance;
}

module.exports = {
  ContactStore,
  getContactStore,
  isValidEmail,
  normalizeName,
  similarity,
};
