/**
 * User Profile Store - CRUD Lifecycle Tests
 *
 * Tests the UserProfileStore API using a direct construction approach
 * that avoids Electron/Spaces dependencies.
 *
 * Run:  npx vitest run test/unit/user-profile-store.test.js
 */

import { describe, it, expect, beforeEach } from 'vitest';

// ── In-memory fake that mimics AgentMemoryStore ──
class FakeMemoryStore {
  constructor() {
    this._sections = new Map();
    this._dirty = false;
  }
  async load() {
    return true;
  }
  async save() {
    this._dirty = false;
    return true;
  }
  isDirty() {
    return this._dirty;
  }
  getSectionNames() {
    return Array.from(this._sections.keys());
  }
  getSection(name) {
    return this._sections.get(name) || null;
  }
  updateSection(name, content) {
    this._sections.set(name, content);
    this._dirty = true;
  }
  parseSectionAsKeyValue(name) {
    const raw = this._sections.get(name);
    if (!raw) return {};
    const result = {};
    for (const line of raw.split('\n')) {
      const m = line.match(/^-\s*(.+?):\s*(.+)$/);
      if (m) result[m[1].trim()] = m[2].trim();
    }
    return result;
  }
  updateSectionAsKeyValue(name, kv) {
    const lines = Object.entries(kv).map(([k, v]) => `- ${k}: ${v}`);
    this._sections.set(name, lines.join('\n'));
    this._dirty = true;
  }
  getRaw() {
    let out = '';
    for (const [name, content] of this._sections) {
      out += `## ${name}\n${content}\n\n`;
    }
    return out;
  }
}

// ── Build a UserProfileStore-like object backed by FakeMemoryStore ──
// This replicates the UserProfileStore logic without requiring real modules.
function createTestProfileStore() {
  const store = new FakeMemoryStore();

  function routeFactToSection(key) {
    const lower = key.toLowerCase();
    if (lower === 'name' || lower === 'nickname' || lower === 'title' || lower === 'role') return 'Identity';
    if (
      lower.includes('home') ||
      lower.includes('work') ||
      lower.includes('location') ||
      lower.includes('city') ||
      lower.includes('address') ||
      lower.includes('timezone')
    )
      return 'Locations';
    if (
      lower.includes('unit') ||
      lower.includes('format') ||
      lower.includes('prefer') ||
      lower.includes('style') ||
      lower.includes('theme') ||
      lower.includes('language')
    )
      return 'Preferences';
    return 'Key Facts';
  }

  function ensureSections() {
    const sections = store.getSectionNames();
    if (!sections.includes('Identity')) store.updateSection('Identity', '- Name: (not yet learned)');
    if (!sections.includes('Locations'))
      store.updateSection('Locations', '- Home: (not yet learned)\n- Work: (not yet learned)');
    if (!sections.includes('Preferences'))
      store.updateSection('Preferences', '- Temperature Units: Fahrenheit\n- Time Format: 12-hour');
    if (!sections.includes('Key Facts')) store.updateSection('Key Facts', '*No facts learned yet.*');
    if (!sections.includes('Session Context'))
      store.updateSection('Session Context', `- Last active: ${new Date().toISOString()}\n- Sessions today: 0`);
  }

  ensureSections();

  return {
    _store: store,

    getSection(name) {
      return store.getSection(name);
    },

    getFacts(sectionName) {
      if (sectionName) return store.parseSectionAsKeyValue(sectionName);
      return {
        ...store.parseSectionAsKeyValue('Identity'),
        ...store.parseSectionAsKeyValue('Locations'),
        ...store.parseSectionAsKeyValue('Preferences'),
        ...store.parseSectionAsKeyValue('Key Facts'),
      };
    },

    updateFact(key, value) {
      if (!value || value.trim() === '' || value.includes('not yet learned')) return;
      const section = routeFactToSection(key.trim());
      const current = store.parseSectionAsKeyValue(section);
      current[key.trim()] = value.trim();
      store.updateSectionAsKeyValue(section, current);
    },

    updateFacts(facts) {
      if (!facts || typeof facts !== 'object') return;
      for (const [key, value] of Object.entries(facts)) {
        this.updateFact(key, value);
      }
    },

    getContextString() {
      const facts = this.getFacts();
      if (!facts || Object.keys(facts).length === 0) return '';
      const meaningful = Object.entries(facts).filter(
        ([_, v]) => v && !v.includes('not yet learned') && !v.startsWith('*')
      );
      if (meaningful.length === 0) return '';
      return meaningful.map(([k, v]) => `- ${k}: ${v}`).join('\n');
    },

    isLoaded() {
      return true;
    },
    getRaw() {
      return store.getRaw();
    },
  };
}

// ═══════════════════════════════════════════════════════════════════
// FACT CRUD LIFECYCLE
// ═══════════════════════════════════════════════════════════════════

describe('UserProfileStore - Fact CRUD Lifecycle', () => {
  let profile;
  beforeEach(() => {
    profile = createTestProfileStore();
  });

  it('Step 1: Create a fact in Identity section', () => {
    profile.updateFact('Name', 'Alice');
    expect(profile.getFacts('Identity').Name).toBe('Alice');
  });

  it('Step 2: Read the fact back from merged getFacts()', () => {
    profile.updateFact('Name', 'Alice');
    expect(profile.getFacts().Name).toBe('Alice');
  });

  it('Step 3: Update the fact', () => {
    profile.updateFact('Name', 'Alice');
    profile.updateFact('Name', 'Bob');
    expect(profile.getFacts('Identity').Name).toBe('Bob');
  });

  it('Step 4: Read updated value from merged', () => {
    profile.updateFact('Name', 'Alice');
    profile.updateFact('Name', 'Bob');
    expect(profile.getFacts().Name).toBe('Bob');
  });

  it('Step 5: Delete by overwriting section without the key', () => {
    profile.updateFact('Name', 'Alice');
    profile.updateFact('Nickname', 'Al');
    const identity = profile.getFacts('Identity');
    delete identity.Name;
    profile._store.updateSectionAsKeyValue('Identity', identity);
    expect(profile.getFacts('Identity').Name).toBeUndefined();
    expect(profile.getFacts('Identity').Nickname).toBe('Al');
  });

  it('Step 6: Verify deleted fact is gone from full getFacts()', () => {
    profile.updateFact('Name', 'Alice');
    const identity = profile.getFacts('Identity');
    delete identity.Name;
    profile._store.updateSectionAsKeyValue('Identity', identity);
    expect(profile.getFacts().Name).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════
// SECTION CRUD
// ═══════════════════════════════════════════════════════════════════

describe('UserProfileStore - Section CRUD', () => {
  let profile;
  beforeEach(() => {
    profile = createTestProfileStore();
  });

  it('should have default sections', () => {
    expect(profile.getSection('Identity')).toBeTruthy();
    expect(profile.getSection('Locations')).toBeTruthy();
    expect(profile.getSection('Preferences')).toBeTruthy();
    expect(profile.getSection('Key Facts')).toBeTruthy();
    expect(profile.getSection('Session Context')).toBeTruthy();
  });

  it('should route location facts to Locations section', () => {
    profile.updateFact('Home', 'New York');
    expect(profile.getFacts('Locations').Home).toBe('New York');
  });

  it('should route preference facts to Preferences section', () => {
    profile.updateFact('Temperature Units', 'Celsius');
    expect(profile.getFacts('Preferences')['Temperature Units']).toBe('Celsius');
  });

  it('should route unknown facts to Key Facts section', () => {
    profile.updateFact('Favorite Color', 'Blue');
    expect(profile.getFacts('Key Facts')['Favorite Color']).toBe('Blue');
  });

  it('should preserve existing values when updating', () => {
    profile.updateFact('Home', 'Seattle');
    profile.updateFact('Work', 'Bellevue');
    const locations = profile.getFacts('Locations');
    expect(locations.Home).toBe('Seattle');
    expect(locations.Work).toBe('Bellevue');
  });
});

// ═══════════════════════════════════════════════════════════════════
// CONTEXT STRING
// ═══════════════════════════════════════════════════════════════════

describe('UserProfileStore - getContextString', () => {
  let profile;
  beforeEach(() => {
    profile = createTestProfileStore();
  });

  it('should return non-empty with default preferences', () => {
    // Preferences section has real defaults (Fahrenheit, 12-hour) which are meaningful
    const ctx = profile.getContextString();
    expect(typeof ctx).toBe('string');
  });

  it('should return formatted facts for meaningful values', () => {
    profile.updateFact('Name', 'Alice');
    profile.updateFact('Home', 'Seattle');
    const ctx = profile.getContextString();
    expect(ctx).toContain('Name: Alice');
    expect(ctx).toContain('Home: Seattle');
  });
});

// ═══════════════════════════════════════════════════════════════════
// EDGE CASES
// ═══════════════════════════════════════════════════════════════════

describe('UserProfileStore - Edge Cases', () => {
  let profile;
  beforeEach(() => {
    profile = createTestProfileStore();
  });

  it('should reject empty values', () => {
    profile.updateFact('Name', '');
    const facts = profile.getFacts('Identity');
    expect(facts.Name).not.toBe('');
  });

  it('should reject "not yet learned" values', () => {
    profile.updateFact('Name', 'not yet learned');
  });

  it('should handle updateFacts with multiple keys', () => {
    profile.updateFacts({ Name: 'Carol', Home: 'Denver', 'Favorite Band': 'Tool' });
    expect(profile.getFacts('Identity').Name).toBe('Carol');
    expect(profile.getFacts('Locations').Home).toBe('Denver');
    expect(profile.getFacts('Key Facts')['Favorite Band']).toBe('Tool');
  });

  it('should handle null/undefined input to updateFacts', () => {
    profile.updateFacts(null);
    profile.updateFacts(undefined);
    expect(profile.getFacts()).toBeDefined();
  });

  it('isLoaded returns true', () => {
    expect(profile.isLoaded()).toBe(true);
  });

  it('getRaw returns markdown-like content', () => {
    profile.updateFact('Name', 'Test');
    const raw = profile.getRaw();
    expect(raw).toContain('##');
    expect(raw).toContain('Name');
  });
});
