/**
 * User Profile Store
 *
 * Global cross-agent persistent memory about the user.
 * All agents can read from this to personalize responses,
 * and write to it when they learn new facts.
 *
 * Stored in gsx-agent/user-profile.md via Spaces API.
 *
 * @module UserProfileStore
 */

// Reuse the markdown parsing utilities from agent-memory-store
const { AgentMemoryStore, _getAgentMemory } = require('./agent-memory-store');
const { getLogQueue } = require('./log-event-queue');
const log = getLogQueue();

// Singleton instance
let profileInstance = null;

class UserProfileStore {
  constructor() {
    // Delegate to AgentMemoryStore with a special ID
    this._store = new AgentMemoryStore('user-profile', {
      displayName: 'User Profile',
    });
    this._loaded = false;
  }

  /**
   * Load the user profile from Spaces
   * Creates default sections if the profile doesn't exist yet
   * @returns {Promise<boolean>}
   */
  async load() {
    if (this._loaded) return true;

    const ok = await this._store.load();
    if (ok) {
      this._ensureSections();
      this._loaded = true;
    }
    return ok;
  }

  /**
   * Ensure all required sections exist (never overwrites existing data)
   * @private
   */
  _ensureSections() {
    const sections = this._store.getSectionNames();

    // Only create missing sections -- never overwrite existing ones
    if (!sections.includes('Identity')) {
      this._store.updateSection('Identity', '- Name: (not yet learned)');
    }
    if (!sections.includes('Locations')) {
      this._store.updateSection('Locations', '- Home: (not yet learned)\n- Work: (not yet learned)');
    }
    if (!sections.includes('Preferences')) {
      this._store.updateSection('Preferences', '- Temperature Units: Fahrenheit\n- Time Format: 12-hour');
    }
    if (!sections.includes('Key Facts')) {
      this._store.updateSection(
        'Key Facts',
        '*No facts learned yet. Agents will populate this as they learn about you.*'
      );
    }
    if (!sections.includes('Session Context')) {
      this._store.updateSection('Session Context', `- Last active: ${new Date().toISOString()}\n- Sessions today: 0`);
    }

    // Safety check: log a warning if Identity has no real name
    // This helps detect if the profile was accidentally reset
    const identity = this._store.parseSectionAsKeyValue('Identity');
    if (identity.Name && identity.Name.includes('not yet learned') && sections.length > 5) {
      log.warn('agent', 'User profile may have been reset -- Identity has default name but many sections exist');
    }

    if (this._store.isDirty()) {
      this._store.save();
    }
  }

  /**
   * Save the profile to Spaces
   * @returns {Promise<boolean>}
   */
  async save() {
    return this._store.save();
  }

  /**
   * Get a section by name
   * @param {string} sectionName
   * @returns {string|null}
   */
  getSection(sectionName) {
    return this._store.getSection(sectionName);
  }

  /**
   * Get all facts from a section as key-value pairs
   * @param {string} sectionName - defaults to all profile sections
   * @returns {Object} key-value pairs
   */
  getFacts(sectionName) {
    if (sectionName) {
      return this._store.parseSectionAsKeyValue(sectionName);
    }
    // Merge Identity + Locations + Preferences + Key Facts
    return {
      ...this._store.parseSectionAsKeyValue('Identity'),
      ...this._store.parseSectionAsKeyValue('Locations'),
      ...this._store.parseSectionAsKeyValue('Preferences'),
      ...this._store.parseSectionAsKeyValue('Key Facts'),
    };
  }

  /**
   * Update a single fact in the appropriate section
   * Automatically routes to the correct section based on key name
   * @param {string} key - Fact key (e.g., "Home", "Name", "Temperature Units")
   * @param {string} value - Fact value
   */
  updateFact(key, value) {
    if (!value || value.trim() === '' || value.includes('not yet learned')) return;

    const normalizedKey = key.trim();
    const normalizedValue = value.trim();

    // Reject ephemeral temporal facts -- these go stale immediately
    // and pollute the profile. Live date/time is injected by getContextString().
    const EPHEMERAL_KEYS = /^(Current Time|Date|Day|Current Date|Current Day|Time|Today)$/i;
    if (EPHEMERAL_KEYS.test(normalizedKey)) return;

    // Determine which section this fact belongs to
    const section = this._routeFactToSection(normalizedKey);

    // Get current section data, update, save
    const current = this._store.parseSectionAsKeyValue(section);
    current[normalizedKey] = normalizedValue;
    this._store.updateSectionAsKeyValue(section, current);

    log.info('settings', 'Updated >', {
      section: section,
      normalizedKey: normalizedKey,
      normalizedValue: normalizedValue,
    });
  }

  /**
   * Update multiple facts at once
   * @param {Object} facts - { key: value, ... }
   */
  updateFacts(facts) {
    if (!facts || typeof facts !== 'object') return;

    for (const [key, value] of Object.entries(facts)) {
      this.updateFact(key, value);
    }
  }

  /**
   * Route a fact key to the appropriate section
   * @private
   */
  _routeFactToSection(key) {
    const lower = key.toLowerCase();

    // Identity keys
    if (lower === 'name' || lower === 'nickname' || lower === 'title' || lower === 'role') {
      return 'Identity';
    }
    // Location keys
    if (
      lower.includes('home') ||
      lower.includes('work') ||
      lower.includes('location') ||
      lower.includes('city') ||
      lower.includes('address') ||
      lower.includes('timezone')
    ) {
      return 'Locations';
    }
    // Preference keys
    if (
      lower.includes('unit') ||
      lower.includes('format') ||
      lower.includes('prefer') ||
      lower.includes('style') ||
      lower.includes('theme') ||
      lower.includes('language')
    ) {
      return 'Preferences';
    }
    // Everything else goes to Key Facts
    return 'Key Facts';
  }

  /**
   * Get a formatted text representation for injection into agent context
   * @returns {string}
   */
  getContextString() {
    const facts = this.getFacts();
    if (!facts || Object.keys(facts).length === 0) return '';

    // Ephemeral keys that go stale fast -- replace with live values
    const EPHEMERAL = new Set([
      'Current Time', 'Date', 'Day', 'Current Date',
      'Current Day', 'Time', 'Today',
    ]);

    const now = new Date();
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const months = ['January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December'];
    const liveDate = `${months[now.getMonth()]} ${now.getDate()}, ${now.getFullYear()}`;
    const liveDay = days[now.getDay()];
    const hrs = now.getHours();
    const mins = now.getMinutes();
    const ampm = hrs >= 12 ? 'PM' : 'AM';
    const liveTime = `${((hrs % 12) || 12)}:${String(mins).padStart(2, '0')} ${ampm}`;

    const meaningful = Object.entries(facts).filter(
      ([k, v]) => v && !v.includes('not yet learned') && !v.startsWith('*') && !EPHEMERAL.has(k)
    );

    // Prepend live temporal context
    const lines = [
      `- Date: ${liveDate}`,
      `- Day: ${liveDay}`,
      `- Current Time: ${liveTime}`,
    ];

    for (const [k, v] of meaningful) {
      lines.push(`- ${k}: ${v}`);
    }

    return lines.join('\n');
  }

  /**
   * Update the session context (called on each new session)
   */
  async updateSessionActivity() {
    const now = new Date().toISOString();
    const ctx = this._store.parseSectionAsKeyValue('Session Context') || {};

    // Count sessions today
    const lastActive = ctx['Last active'];
    let sessionsToday = parseInt(ctx['Sessions today'] || '0', 10);

    if (lastActive) {
      const lastDate = new Date(lastActive).toDateString();
      const todayDate = new Date().toDateString();
      if (lastDate !== todayDate) {
        sessionsToday = 0; // New day, reset count
      }
    }

    sessionsToday++;
    this._store.updateSectionAsKeyValue('Session Context', {
      'Last active': now,
      'Sessions today': String(sessionsToday),
    });

    await this.save();
  }

  /**
   * Check if the profile is loaded
   * @returns {boolean}
   */
  isLoaded() {
    return this._loaded;
  }

  /**
   * Get the raw markdown content
   * @returns {string}
   */
  getRaw() {
    return this._store.getRaw();
  }
}

/**
 * Get the global user profile singleton
 * @returns {UserProfileStore}
 */
function getUserProfile() {
  if (!profileInstance) {
    profileInstance = new UserProfileStore();
  }
  return profileInstance;
}

module.exports = { UserProfileStore, getUserProfile };
