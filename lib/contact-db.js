/**
 * ContactDB - DuckDB-backed Canonical Contact & Meeting Attendance Database
 *
 * Persistent embedded database that maintains:
 *   - A canonical contact list (deduplicated by email, with name aliases)
 *   - Meeting attendance history (who was at which meeting)
 *   - Frequency and recency analytics (who do you meet with most?)
 *
 * Schema:
 *   contacts       - Canonical contact records (one per unique email)
 *   name_aliases   - Maps name variations to a canonical contact
 *   meeting_attendance - Log of who attended which meeting and when
 *
 * Storage: ~/Documents/OR-Spaces/contact-store/contacts.duckdb
 *
 * @module ContactDB
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { getLogQueue } = require('./log-event-queue');
const log = getLogQueue();

let DuckDB;
try {
  DuckDB = require('@duckdb/node-api');
} catch (_e) {
  console.warn('[ContactDB] @duckdb/node-api not installed');
  DuckDB = null;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const SPACES_BASE = path.join(process.env.HOME || process.env.USERPROFILE || '.', 'Documents', 'OR-Spaces');
const STORE_DIR = path.join(SPACES_BASE, 'contact-store');
const DB_FILE = 'contacts.duckdb';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function uuid() {
  return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
}

function isValidEmail(str) {
  return typeof str === 'string' && EMAIL_RE.test(str.trim());
}

/**
 * Normalize a name for comparison: lowercase, collapse whitespace, strip titles.
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
 * Derive a display name from an email prefix.
 * john.smith@acme.com -> John Smith
 */
function nameFromEmail(email) {
  const prefix = email.split('@')[0];
  return prefix
    .replace(/[._-]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

// ─── ContactDB Class ─────────────────────────────────────────────────────────

class ContactDB {
  constructor(storeDir) {
    this._storeDir = storeDir || STORE_DIR;
    this._dbPath = path.join(this._storeDir, DB_FILE);
    this._instance = null;
    this._conn = null;
    this._ready = false;
    this._initPromise = null;
  }

  // ─── Initialization ──────────────────────────────────────────────────────

  /**
   * Initialize the DuckDB instance and create tables if needed.
   * Safe to call multiple times (idempotent).
   */
  async init() {
    if (this._initPromise) return this._initPromise;
    this._initPromise = this._doInit();
    return this._initPromise;
  }

  async _doInit() {
    if (!DuckDB) {
      log.warn('contact-db', 'DuckDB not available - contact DB disabled');
      return false;
    }

    try {
      fs.mkdirSync(this._storeDir, { recursive: true });

      this._instance = await DuckDB.DuckDBInstance.create(this._dbPath);
      this._conn = await this._instance.connect();

      await this._createSchema();
      this._ready = true;
      log.info('contact-db', 'ContactDB initialized', { path: this._dbPath });
      return true;
    } catch (err) {
      log.error('contact-db', 'Failed to initialize ContactDB', { error: err.message });
      this._ready = false;
      return false;
    }
  }

  async _createSchema() {
    // Canonical contacts: one row per unique email
    await this._conn.run(`
      CREATE TABLE IF NOT EXISTS contacts (
        id            VARCHAR PRIMARY KEY,
        canonical_name VARCHAR NOT NULL,
        email         VARCHAR UNIQUE NOT NULL,
        company       VARCHAR,
        calendar_url  VARCHAR,
        notes         VARCHAR,
        source        VARCHAR DEFAULT 'manual',
        usage_count   INTEGER DEFAULT 0,
        last_used     TIMESTAMP,
        created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Name aliases: maps name variations to a canonical contact
    await this._conn.run(`
      CREATE TABLE IF NOT EXISTS name_aliases (
        id          VARCHAR PRIMARY KEY,
        alias       VARCHAR NOT NULL,
        alias_norm  VARCHAR NOT NULL,
        contact_id  VARCHAR NOT NULL,
        confidence  DOUBLE DEFAULT 1.0,
        source      VARCHAR DEFAULT 'manual',
        created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Meeting attendance log
    await this._conn.run(`
      CREATE TABLE IF NOT EXISTS meeting_attendance (
        id             VARCHAR PRIMARY KEY,
        meeting_title  VARCHAR NOT NULL,
        meeting_date   TIMESTAMP NOT NULL,
        meeting_end    TIMESTAMP,
        contact_id     VARCHAR NOT NULL,
        contact_email  VARCHAR NOT NULL,
        source         VARCHAR DEFAULT 'calendar',
        created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Index for fast name lookups
    await this._conn.run(`
      CREATE INDEX IF NOT EXISTS idx_alias_norm ON name_aliases(alias_norm)
    `);
    await this._conn.run(`
      CREATE INDEX IF NOT EXISTS idx_attendance_contact ON meeting_attendance(contact_id)
    `);
    await this._conn.run(`
      CREATE INDEX IF NOT EXISTS idx_attendance_date ON meeting_attendance(meeting_date)
    `);
  }

  // ─── Contact CRUD ────────────────────────────────────────────────────────

  /**
   * Upsert a contact. If the email already exists, merge/update.
   * Also registers the name as an alias.
   *
   * @param {Object} data
   * @param {string} data.name - Display name
   * @param {string} data.email - Email address
   * @param {string} [data.company]
   * @param {string} [data.calendarUrl]
   * @param {string} [data.notes]
   * @param {string} [data.source] - 'manual' | 'calendar' | 'voice' | 'email'
   * @returns {Object} The contact row
   */
  async upsertContact(data) {
    if (!this._ready) await this.init();
    if (!data.name || !data.email) throw new Error('Contact requires name and email');

    const email = data.email.trim().toLowerCase();
    if (!isValidEmail(email)) throw new Error(`Invalid email: ${data.email}`);

    const name = data.name.trim();
    const nameNorm = normalizeName(name);
    const source = data.source || 'manual';

    // Check if contact already exists by email
    const existing = await this._queryOne(`SELECT * FROM contacts WHERE email = '${this._esc(email)}'`);

    let contact;
    if (existing) {
      // Merge: update name if new one is longer, fill in missing fields
      const updates = [];
      if (name.length > (existing.canonical_name || '').length) {
        updates.push(`canonical_name = '${this._esc(name)}'`);
      }
      if (data.company && !existing.company) {
        updates.push(`company = '${this._esc(data.company)}'`);
      }
      if (data.calendarUrl && !existing.calendar_url) {
        updates.push(`calendar_url = '${this._esc(data.calendarUrl)}'`);
      }
      if (data.notes && !existing.notes) {
        updates.push(`notes = '${this._esc(data.notes)}'`);
      }
      if (updates.length > 0) {
        updates.push(`updated_at = CURRENT_TIMESTAMP`);
        await this._conn.run(`UPDATE contacts SET ${updates.join(', ')} WHERE id = '${this._esc(existing.id)}'`);
      }
      contact = await this._queryOne(`SELECT * FROM contacts WHERE id = '${this._esc(existing.id)}'`);
    } else {
      // Insert new contact
      const id = uuid();
      await this._conn.run(`
        INSERT INTO contacts (id, canonical_name, email, company, calendar_url, notes, source)
        VALUES (
          '${this._esc(id)}',
          '${this._esc(name)}',
          '${this._esc(email)}',
          ${data.company ? `'${this._esc(data.company)}'` : 'NULL'},
          ${data.calendarUrl ? `'${this._esc(data.calendarUrl)}'` : 'NULL'},
          ${data.notes ? `'${this._esc(data.notes)}'` : 'NULL'},
          '${this._esc(source)}'
        )
      `);
      contact = await this._queryOne(`SELECT * FROM contacts WHERE id = '${this._esc(id)}'`);
    }

    // Register the name as an alias (if not already known for this contact)
    if (contact) {
      await this._registerAlias(nameNorm, name, contact.id, source);
    }

    return contact;
  }

  /**
   * Register a name alias for a contact (deduplicated).
   */
  async _registerAlias(aliasNorm, aliasDisplay, contactId, source = 'manual') {
    if (!aliasNorm) return;

    const existing = await this._queryOne(`
      SELECT id FROM name_aliases
      WHERE alias_norm = '${this._esc(aliasNorm)}' AND contact_id = '${this._esc(contactId)}'
    `);

    if (!existing) {
      await this._conn.run(`
        INSERT INTO name_aliases (id, alias, alias_norm, contact_id, confidence, source)
        VALUES (
          '${this._esc(uuid())}',
          '${this._esc(aliasDisplay)}',
          '${this._esc(aliasNorm)}',
          '${this._esc(contactId)}',
          1.0,
          '${this._esc(source)}'
        )
      `);
    }
  }

  /**
   * Add an additional alias for an existing contact.
   */
  async addAlias(contactId, alias, source = 'manual') {
    if (!this._ready) await this.init();
    const aliasNorm = normalizeName(alias);
    await this._registerAlias(aliasNorm, alias.trim(), contactId, source);
  }

  /**
   * Delete a contact and all its aliases and attendance records.
   */
  async deleteContact(id) {
    if (!this._ready) await this.init();
    await this._conn.run(`DELETE FROM meeting_attendance WHERE contact_id = '${this._esc(id)}'`);
    await this._conn.run(`DELETE FROM name_aliases WHERE contact_id = '${this._esc(id)}'`);
    await this._conn.run(`DELETE FROM contacts WHERE id = '${this._esc(id)}'`);
  }

  /**
   * Get a contact by email.
   */
  async getByEmail(email) {
    if (!this._ready) await this.init();
    if (!email) return null;
    return this._queryOne(`SELECT * FROM contacts WHERE email = '${this._esc(email.trim().toLowerCase())}'`);
  }

  /**
   * Get a contact by ID.
   */
  async getById(id) {
    if (!this._ready) await this.init();
    return this._queryOne(`SELECT * FROM contacts WHERE id = '${this._esc(id)}'`);
  }

  /**
   * Get all contacts, sorted by name, recency, or frequency.
   */
  async getAllContacts(sortBy = 'name') {
    if (!this._ready) await this.init();

    let orderClause;
    switch (sortBy) {
      case 'recent':
        orderClause = 'ORDER BY last_used DESC NULLS LAST, canonical_name ASC';
        break;
      case 'frequent':
        orderClause = 'ORDER BY usage_count DESC, canonical_name ASC';
        break;
      default:
        orderClause = 'ORDER BY canonical_name ASC';
    }

    return this._query(`SELECT * FROM contacts ${orderClause}`);
  }

  // ─── Name Resolution ─────────────────────────────────────────────────────

  /**
   * Resolve a name or email to a canonical contact.
   * Checks: exact email -> exact alias -> prefix match -> fuzzy match.
   *
   * @param {string} input - Name or email
   * @returns {{ contact: Object|null, confidence: string, aliases: string[] }}
   */
  async resolve(input) {
    if (!this._ready) await this.init();
    if (!input || !input.trim()) return { contact: null, confidence: 'none', aliases: [] };

    const trimmed = input.trim();

    // 1. Direct email match
    if (isValidEmail(trimmed)) {
      const contact = await this.getByEmail(trimmed);
      return { contact, confidence: contact ? 'exact' : 'none', aliases: [] };
    }

    const inputNorm = normalizeName(trimmed);

    // 2. Exact alias match
    const exactAlias = await this._queryOne(`
      SELECT c.*, na.alias, na.confidence as alias_confidence
      FROM name_aliases na
      JOIN contacts c ON na.contact_id = c.id
      WHERE na.alias_norm = '${this._esc(inputNorm)}'
      ORDER BY na.confidence DESC
      LIMIT 1
    `);

    if (exactAlias) {
      const aliases = await this._getAliases(exactAlias.id);
      return { contact: exactAlias, confidence: 'exact', aliases };
    }

    // 3. Prefix match on alias (e.g., "John" matches "john smith")
    const prefixMatches = await this._query(`
      SELECT c.*, na.alias, na.alias_norm
      FROM name_aliases na
      JOIN contacts c ON na.contact_id = c.id
      WHERE na.alias_norm LIKE '${this._esc(inputNorm)}%'
         OR na.alias_norm LIKE '% ${this._esc(inputNorm)}%'
      ORDER BY length(na.alias_norm) ASC
      LIMIT 5
    `);

    if (prefixMatches.length === 1) {
      const aliases = await this._getAliases(prefixMatches[0].id);
      return { contact: prefixMatches[0], confidence: 'high', aliases };
    }
    if (prefixMatches.length > 1) {
      // Multiple matches - ambiguous
      return { contact: prefixMatches[0], confidence: 'low', aliases: prefixMatches.map((m) => m.alias) };
    }

    // 4. Fuzzy match using DuckDB's jaro_winkler_similarity
    const fuzzyMatches = await this._query(`
      SELECT c.*, na.alias, na.alias_norm,
             jaro_winkler_similarity('${this._esc(inputNorm)}', na.alias_norm) AS sim
      FROM name_aliases na
      JOIN contacts c ON na.contact_id = c.id
      WHERE jaro_winkler_similarity('${this._esc(inputNorm)}', na.alias_norm) > 0.75
      ORDER BY sim DESC
      LIMIT 5
    `);

    if (fuzzyMatches.length > 0) {
      const top = fuzzyMatches[0];
      const conf = top.sim >= 0.9 ? 'high' : 'low';
      return { contact: top, confidence: conf, aliases: fuzzyMatches.map((m) => m.alias) };
    }

    return { contact: null, confidence: 'none', aliases: [] };
  }

  /**
   * Resolve a list of guests (names or emails) to canonical contacts.
   *
   * @param {string|string[]} guests - Comma-separated or array
   * @returns {{ resolved: Object[], unresolved: Object[], ambiguous: Object[] }}
   */
  async resolveGuests(guests) {
    if (!this._ready) await this.init();

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
      const result = await this.resolve(guest);

      if (result.confidence === 'exact' || result.confidence === 'high') {
        resolved.push({
          input: guest,
          name: result.contact.canonical_name,
          email: result.contact.email,
          contact: result.contact,
        });
      } else if (result.confidence === 'low') {
        ambiguous.push({
          input: guest,
          candidates: result.aliases,
          topMatch: result.contact,
        });
      } else {
        unresolved.push({ input: guest });
      }
    }

    return { resolved, unresolved, ambiguous };
  }

  /**
   * Get all known aliases for a contact.
   */
  async _getAliases(contactId) {
    const rows = await this._query(`SELECT alias FROM name_aliases WHERE contact_id = '${this._esc(contactId)}'`);
    return rows.map((r) => r.alias);
  }

  // ─── Meeting Attendance ──────────────────────────────────────────────────

  /**
   * Record that a contact attended a meeting.
   * Deduplicates: same contact + same meeting title + same date = one record.
   *
   * @param {Object} data
   * @param {string} data.meetingTitle - Event title
   * @param {string|Date} data.meetingDate - Start time
   * @param {string|Date} [data.meetingEnd] - End time
   * @param {string} data.contactEmail - Attendee email
   * @param {string} [data.source] - 'calendar' | 'manual' | 'voice'
   */
  async recordAttendance(data) {
    if (!this._ready) await this.init();
    if (!data.meetingTitle || !data.meetingDate || !data.contactEmail) return;

    const email = data.contactEmail.trim().toLowerCase();
    if (!isValidEmail(email)) return;

    // Ensure the contact exists (auto-create if not)
    let contact = await this.getByEmail(email);
    if (!contact) {
      contact = await this.upsertContact({
        name: nameFromEmail(email),
        email,
        source: data.source || 'calendar',
      });
    }

    if (!contact) return;

    const meetDate = new Date(data.meetingDate).toISOString();
    const meetEnd = data.meetingEnd ? new Date(data.meetingEnd).toISOString() : null;

    // Dedup check: same contact + same meeting within 1 hour window
    const existing = await this._queryOne(`
      SELECT id FROM meeting_attendance
      WHERE contact_id = '${this._esc(contact.id)}'
        AND meeting_title = '${this._esc(data.meetingTitle)}'
        AND abs(epoch(meeting_date::TIMESTAMP) - epoch('${this._esc(meetDate)}'::TIMESTAMP)) < 3600
    `);

    if (existing) return; // Already recorded

    await this._conn.run(`
      INSERT INTO meeting_attendance (id, meeting_title, meeting_date, meeting_end, contact_id, contact_email, source)
      VALUES (
        '${this._esc(uuid())}',
        '${this._esc(data.meetingTitle)}',
        '${this._esc(meetDate)}',
        ${meetEnd ? `'${this._esc(meetEnd)}'` : 'NULL'},
        '${this._esc(contact.id)}',
        '${this._esc(email)}',
        '${this._esc(data.source || 'calendar')}'
      )
    `);

    // Update usage count
    await this._conn.run(`
      UPDATE contacts
      SET usage_count = usage_count + 1,
          last_used = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = '${this._esc(contact.id)}'
    `);
  }

  /**
   * Ingest attendees from a calendar event. Calls recordAttendance for each guest.
   *
   * @param {Object} event - Calendar event with guests or attendees
   */
  async ingestEvent(event) {
    if (!this._ready) await this.init();
    if (!event) return;

    const guests = event.guests || event.attendees || [];
    const title = event.title || event.summary || 'Untitled';
    const startTime = event.startTime || event.start?.dateTime || event.start?.date;
    const endTime = event.endTime || event.end?.dateTime || event.end?.date;

    if (!startTime) return;

    for (const guest of guests) {
      const email = typeof guest === 'string' ? guest : guest.email || null;
      const displayName = typeof guest === 'object' ? guest.displayName : null;

      if (!email || !isValidEmail(email)) continue;

      // Upsert the contact with display name if available
      if (displayName) {
        await this.upsertContact({ name: displayName, email, source: 'calendar' });
      }

      await this.recordAttendance({
        meetingTitle: title,
        meetingDate: startTime,
        meetingEnd: endTime,
        contactEmail: email,
        source: 'calendar',
      });
    }
  }

  /**
   * Batch ingest events from a calendar sync.
   *
   * @param {Object[]} events - Array of calendar events
   * @returns {{ processed: number, contacts: number, attendance: number }}
   */
  async ingestEvents(events) {
    if (!this._ready) await this.init();
    if (!Array.isArray(events)) return { processed: 0, contacts: 0, attendance: 0 };

    const contactsBefore = (await this._queryOne('SELECT COUNT(*) as cnt FROM contacts'))?.cnt || 0;
    const attendanceBefore = (await this._queryOne('SELECT COUNT(*) as cnt FROM meeting_attendance'))?.cnt || 0;

    let processed = 0;
    for (const event of events) {
      await this.ingestEvent(event);
      processed++;
    }

    const contactsAfter = (await this._queryOne('SELECT COUNT(*) as cnt FROM contacts'))?.cnt || 0;
    const attendanceAfter = (await this._queryOne('SELECT COUNT(*) as cnt FROM meeting_attendance'))?.cnt || 0;

    const result = {
      processed,
      contacts: contactsAfter - contactsBefore,
      attendance: attendanceAfter - attendanceBefore,
    };

    log.info('contact-db', 'Event ingestion complete', result);
    return result;
  }

  // ─── Analytics ────────────────────────────────────────────────────────────

  /**
   * Get contacts ranked by meeting frequency.
   * "Who do I meet with the most?"
   *
   * @param {Object} [opts]
   * @param {number} [opts.limit] - Max results (default 20)
   * @param {string} [opts.since] - ISO date to filter from
   * @returns {Object[]} Array of { contact, meeting_count, last_met, first_met }
   */
  async getFrequentContacts(opts = {}) {
    if (!this._ready) await this.init();

    const limit = opts.limit || 20;
    const sinceClause = opts.since ? `WHERE ma.meeting_date >= '${this._esc(opts.since)}'` : '';

    return this._query(`
      SELECT
        c.*,
        COUNT(DISTINCT ma.id) as meeting_count,
        MAX(ma.meeting_date) as last_met,
        MIN(ma.meeting_date) as first_met
      FROM contacts c
      JOIN meeting_attendance ma ON c.id = ma.contact_id
      ${sinceClause}
      GROUP BY c.id, c.canonical_name, c.email, c.company, c.calendar_url,
               c.notes, c.source, c.usage_count, c.last_used, c.created_at, c.updated_at
      ORDER BY meeting_count DESC
      LIMIT ${limit}
    `);
  }

  /**
   * Get meeting history for a specific contact.
   *
   * @param {string} contactIdOrEmail - Contact ID or email
   * @param {Object} [opts]
   * @param {number} [opts.limit] - Max results (default 50)
   * @returns {Object[]} Array of meeting attendance records
   */
  async getContactMeetings(contactIdOrEmail, opts = {}) {
    if (!this._ready) await this.init();
    const limit = opts.limit || 50;

    // Try email first, then ID
    const whereClause = isValidEmail(contactIdOrEmail)
      ? `contact_email = '${this._esc(contactIdOrEmail.toLowerCase())}'`
      : `contact_id = '${this._esc(contactIdOrEmail)}'`;

    return this._query(`
      SELECT * FROM meeting_attendance
      WHERE ${whereClause}
      ORDER BY meeting_date DESC
      LIMIT ${limit}
    `);
  }

  /**
   * Get people you meet with together (co-attendees).
   * "Who do I typically see at meetings with John?"
   *
   * @param {string} contactEmail - The contact to check
   * @param {number} [limit] - Max results
   * @returns {Object[]} Array of { contact, shared_meetings }
   */
  async getCoAttendees(contactEmail, limit = 10) {
    if (!this._ready) await this.init();
    if (!contactEmail) return [];

    const email = contactEmail.trim().toLowerCase();

    return this._query(`
      SELECT
        c.id, c.canonical_name, c.email, c.company,
        COUNT(DISTINCT ma2.meeting_title || ma2.meeting_date::VARCHAR) as shared_meetings
      FROM meeting_attendance ma1
      JOIN meeting_attendance ma2
        ON ma1.meeting_title = ma2.meeting_title
        AND abs(epoch(ma1.meeting_date) - epoch(ma2.meeting_date)) < 3600
        AND ma1.contact_email != ma2.contact_email
      JOIN contacts c ON ma2.contact_id = c.id
      WHERE ma1.contact_email = '${this._esc(email)}'
      GROUP BY c.id, c.canonical_name, c.email, c.company
      ORDER BY shared_meetings DESC
      LIMIT ${limit}
    `);
  }

  /**
   * Get overall stats.
   */
  async getStats() {
    if (!this._ready) await this.init();

    const contacts = await this._queryOne('SELECT COUNT(*) as cnt FROM contacts');
    const aliases = await this._queryOne('SELECT COUNT(*) as cnt FROM name_aliases');
    const attendance = await this._queryOne('SELECT COUNT(*) as cnt FROM meeting_attendance');
    const sources = await this._query(`
      SELECT source, COUNT(*) as cnt FROM contacts GROUP BY source ORDER BY cnt DESC
    `);

    return {
      totalContacts: contacts?.cnt || 0,
      totalAliases: aliases?.cnt || 0,
      totalAttendanceRecords: attendance?.cnt || 0,
      contactsBySource: Object.fromEntries(sources.map((r) => [r.source || 'unknown', r.cnt])),
    };
  }

  /**
   * Full-text search across contacts and aliases.
   *
   * @param {string} query - Search string
   * @param {number} [limit] - Max results (default 10)
   * @returns {Object[]} Matched contacts with relevance info
   */
  async search(query, limit = 10) {
    if (!this._ready) await this.init();
    if (!query || !query.trim()) return [];

    const q = this._esc(normalizeName(query));

    return this._query(`
      SELECT DISTINCT c.*,
        COALESCE(
          MAX(jaro_winkler_similarity('${q}', na.alias_norm)),
          jaro_winkler_similarity('${q}', lower(c.canonical_name))
        ) as relevance
      FROM contacts c
      LEFT JOIN name_aliases na ON c.id = na.contact_id
      WHERE jaro_winkler_similarity('${q}', lower(c.canonical_name)) > 0.6
         OR na.alias_norm LIKE '%${q}%'
         OR c.email LIKE '%${q}%'
         OR jaro_winkler_similarity('${q}', na.alias_norm) > 0.6
      GROUP BY c.id, c.canonical_name, c.email, c.company, c.calendar_url,
               c.notes, c.source, c.usage_count, c.last_used, c.created_at, c.updated_at
      ORDER BY relevance DESC, c.usage_count DESC
      LIMIT ${limit}
    `);
  }

  /**
   * Suggest contacts for autocomplete.
   *
   * @param {string} partial - Partial input
   * @param {Object} [opts]
   * @param {number} [opts.limit]
   * @param {string[]} [opts.exclude] - Emails to exclude
   * @returns {Object[]}
   */
  async suggest(partial, opts = {}) {
    if (!this._ready) await this.init();
    const limit = opts.limit || 5;
    const excludeClause =
      opts.exclude && opts.exclude.length > 0
        ? `AND c.email NOT IN (${opts.exclude.map((e) => `'${this._esc(e.toLowerCase())}'`).join(',')})`
        : '';

    if (!partial || !partial.trim()) {
      // No input: return most recently used
      return this._query(`
        SELECT * FROM contacts c
        WHERE 1=1 ${excludeClause}
        ORDER BY last_used DESC NULLS LAST, usage_count DESC
        LIMIT ${limit}
      `);
    }

    const q = this._esc(normalizeName(partial));

    return this._query(`
      SELECT DISTINCT c.*
      FROM contacts c
      LEFT JOIN name_aliases na ON c.id = na.contact_id
      WHERE (na.alias_norm LIKE '${q}%'
         OR na.alias_norm LIKE '% ${q}%'
         OR c.email LIKE '${q}%'
         OR c.canonical_name ILIKE '%${this._esc(partial.trim())}%')
        ${excludeClause}
      ORDER BY c.usage_count DESC, c.canonical_name ASC
      LIMIT ${limit}
    `);
  }

  // ─── Import / Migration ──────────────────────────────────────────────────

  /**
   * Import contacts from the legacy agent memory markdown format.
   *
   * @param {string} markdown - Raw markdown section content
   * @returns {{ imported: number, skipped: number }}
   */
  async importFromMemory(markdown) {
    if (!this._ready) await this.init();
    if (!markdown) return { imported: 0, skipped: 0 };

    const lines = markdown.split('\n');
    let imported = 0;
    let skipped = 0;

    for (const line of lines) {
      if (line.trim().startsWith('*') || !line.trim()) continue;

      // "- Name: email | calendar: URL"
      const calMatch = line.match(/^-?\s*(.+?):\s*([^\s|]+@[^\s|]+)\s*\|\s*calendar:\s*(\S+)/i);
      if (calMatch) {
        try {
          await this.upsertContact({
            name: calMatch[1].trim(),
            email: calMatch[2].trim(),
            calendarUrl: calMatch[3].trim(),
            source: 'legacy-import',
          });
          imported++;
        } catch {
          skipped++;
        }
        continue;
      }

      // "- Name: email"
      const basicMatch = line.match(/^-?\s*(.+?):\s*([^\s|]+@[^\s|]+)/i);
      if (basicMatch) {
        try {
          await this.upsertContact({
            name: basicMatch[1].trim(),
            email: basicMatch[2].trim(),
            source: 'legacy-import',
          });
          imported++;
        } catch {
          skipped++;
        }
      }
    }

    return { imported, skipped };
  }

  /**
   * Import contacts from the JSON contact-store file.
   *
   * @param {Object[]} contacts - Array from contacts.json
   * @returns {{ imported: number, skipped: number }}
   */
  async importFromJSON(contacts) {
    if (!this._ready) await this.init();
    if (!Array.isArray(contacts)) return { imported: 0, skipped: 0 };

    let imported = 0;
    let skipped = 0;

    for (const c of contacts) {
      try {
        const contact = await this.upsertContact({
          name: c.name,
          email: c.email,
          company: c.company,
          calendarUrl: c.calendarUrl,
          notes: c.notes,
          source: c.source || 'json-import',
        });

        // Import aliases
        if (c.aliases && Array.isArray(c.aliases)) {
          for (const alias of c.aliases) {
            await this.addAlias(contact.id, alias, 'json-import');
          }
        }

        imported++;
      } catch {
        skipped++;
      }
    }

    return { imported, skipped };
  }

  // ─── Query Helpers ────────────────────────────────────────────────────────

  /**
   * Escape a string for SQL (prevent injection).
   */
  _esc(str) {
    if (str == null) return '';
    return String(str).replace(/'/g, "''");
  }

  /**
   * Run a query and return all rows as plain objects.
   */
  async _query(sql) {
    if (!this._conn) return [];
    try {
      const result = await this._conn.run(sql);
      const rows = await result.getRows();
      if (!rows || rows.length === 0) return [];
      // Convert DuckDB row arrays to plain objects, coercing BigInt to Number
      const columns = result.columnNames();
      return rows.map((row) => {
        const obj = {};
        columns.forEach((col, i) => {
          const val = row[i];
          obj[col] = typeof val === 'bigint' ? Number(val) : val;
        });
        return obj;
      });
    } catch (err) {
      log.error('contact-db', 'Query failed', { sql: sql.slice(0, 200), error: err.message });
      return [];
    }
  }

  /**
   * Run a query and return the first row.
   */
  async _queryOne(sql) {
    const rows = await this._query(sql);
    return rows.length > 0 ? rows[0] : null;
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  async close() {
    if (this._conn) {
      try {
        this._conn.disconnectSync();
      } catch {
        /* ignore */
      }
      this._conn = null;
    }
    if (this._instance) {
      try {
        this._instance.closeSync();
      } catch {
        /* ignore */
      }
      this._instance = null;
    }
    this._ready = false;
    this._initPromise = null;
  }
}

// ─── Singleton ───────────────────────────────────────────────────────────────

let _instance = null;

function getContactDB() {
  if (!_instance) {
    _instance = new ContactDB();
  }
  return _instance;
}

module.exports = {
  ContactDB,
  getContactDB,
  isValidEmail,
  normalizeName,
  nameFromEmail,
};
