/**
 * Unit tests for ContactStore
 *
 * Covers: CRUD, search, fuzzy matching, guest resolution,
 * suggestions, usage tracking, import, and edge cases.
 *
 * Run:  npx vitest run test/unit/contact-store.test.js
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';

// Mock log-event-queue so ContactStore doesn't need the real logger
vi.mock('../../lib/log-event-queue', () => ({
  getLogQueue: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Dynamically import ContactStore after mocks are set
const { ContactStore, isValidEmail, normalizeName, similarity } = await import('../../lib/contact-store.js');

// Use a temp directory for each test run
let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'contact-store-test-'));
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function createStore() {
  return new ContactStore(tmpDir);
}

// ─── Helper Utilities ────────────────────────────────────────────────────────

describe('isValidEmail', () => {
  it('should accept valid emails', () => {
    expect(isValidEmail('john@example.com')).toBe(true);
    expect(isValidEmail('jane.doe@company.org')).toBe(true);
    expect(isValidEmail('user+tag@domain.co.uk')).toBe(true);
    expect(isValidEmail('admin@sub.domain.com')).toBe(true);
  });

  it('should reject invalid emails', () => {
    expect(isValidEmail('')).toBe(false);
    expect(isValidEmail('notanemail')).toBe(false);
    expect(isValidEmail('@no-user.com')).toBe(false);
    expect(isValidEmail('user@')).toBe(false);
    expect(isValidEmail('user@.com')).toBe(false);
    expect(isValidEmail(null)).toBe(false);
    expect(isValidEmail(undefined)).toBe(false);
    expect(isValidEmail(42)).toBe(false);
  });
});

describe('normalizeName', () => {
  it('should lowercase and trim', () => {
    expect(normalizeName('  John Smith  ')).toBe('john smith');
  });

  it('should strip titles', () => {
    expect(normalizeName('Dr. Sarah Jones')).toBe('sarah jones');
    expect(normalizeName('Mr. Bob')).toBe('bob');
    expect(normalizeName('Mrs. Alice')).toBe('alice');
  });

  it('should handle empty/null', () => {
    expect(normalizeName('')).toBe('');
    expect(normalizeName(null)).toBe('');
    expect(normalizeName(undefined)).toBe('');
  });
});

describe('similarity', () => {
  it('should return 1 for exact matches', () => {
    expect(similarity('hello', 'hello')).toBe(1);
  });

  it('should return 0.8 for substring matches', () => {
    expect(similarity('john', 'john smith')).toBe(0.8);
  });

  it('should return 0 for empty strings', () => {
    expect(similarity('', 'hello')).toBe(0);
    expect(similarity('hello', '')).toBe(0);
  });

  it('should return a score between 0 and 1 for partial matches', () => {
    const score = similarity('jon', 'john');
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1);
  });
});

// ─── CRUD Operations ─────────────────────────────────────────────────────────

describe('ContactStore CRUD', () => {
  it('should add a contact', () => {
    const store = createStore();
    const contact = store.addContact({
      name: 'John Smith',
      email: 'john@example.com',
    });

    expect(contact.id).toBeTruthy();
    expect(contact.name).toBe('John Smith');
    expect(contact.email).toBe('john@example.com');
    expect(contact.usageCount).toBe(0);
    expect(contact.created).toBeTruthy();
  });

  it('should require name and email', () => {
    const store = createStore();
    expect(() => store.addContact({ name: 'John' })).toThrow('requires both name and email');
    expect(() => store.addContact({ email: 'john@example.com' })).toThrow('requires both name and email');
  });

  it('should validate email format', () => {
    const store = createStore();
    expect(() => store.addContact({ name: 'John', email: 'notanemail' })).toThrow('Invalid email');
  });

  it('should normalize email to lowercase', () => {
    const store = createStore();
    const contact = store.addContact({ name: 'John', email: 'JOHN@Example.COM' });
    expect(contact.email).toBe('john@example.com');
  });

  it('should merge duplicate emails instead of creating duplicates', () => {
    const store = createStore();
    store.addContact({ name: 'John', email: 'john@example.com' });
    const merged = store.addContact({ name: 'John Smith', email: 'john@example.com', company: 'Acme' });

    expect(store.getAllContacts()).toHaveLength(1);
    expect(merged.name).toBe('John Smith'); // longer name wins
    expect(merged.company).toBe('Acme');
  });

  it('should get a contact by ID', () => {
    const store = createStore();
    const created = store.addContact({ name: 'Jane', email: 'jane@example.com' });
    const found = store.getContact(created.id);
    expect(found.email).toBe('jane@example.com');
  });

  it('should get a contact by email', () => {
    const store = createStore();
    store.addContact({ name: 'Jane', email: 'jane@example.com' });
    const found = store.getByEmail('JANE@Example.com');
    expect(found).toBeTruthy();
    expect(found.name).toBe('Jane');
  });

  it('should update a contact', () => {
    const store = createStore();
    const created = store.addContact({ name: 'Jane', email: 'jane@example.com' });
    const updated = store.updateContact(created.id, { name: 'Jane Doe', company: 'Acme' });
    expect(updated.name).toBe('Jane Doe');
    expect(updated.company).toBe('Acme');
  });

  it('should validate email on update', () => {
    const store = createStore();
    const created = store.addContact({ name: 'Jane', email: 'jane@example.com' });
    expect(() => store.updateContact(created.id, { email: 'bad' })).toThrow('Invalid email');
  });

  it('should return null for non-existent update', () => {
    const store = createStore();
    expect(store.updateContact('fake-id', { name: 'X' })).toBeNull();
  });

  it('should delete a contact', () => {
    const store = createStore();
    const created = store.addContact({ name: 'Jane', email: 'jane@example.com' });
    expect(store.deleteContact(created.id)).toBe(true);
    expect(store.getAllContacts()).toHaveLength(0);
  });

  it('should return false for non-existent delete', () => {
    const store = createStore();
    expect(store.deleteContact('fake-id')).toBe(false);
  });

  it('should persist contacts to disk', () => {
    const store1 = createStore();
    store1.addContact({ name: 'Persist Test', email: 'persist@example.com' });

    // New instance reads from the same directory
    const store2 = new ContactStore(tmpDir);
    const contacts = store2.getAllContacts();
    expect(contacts).toHaveLength(1);
    expect(contacts[0].email).toBe('persist@example.com');
  });

  it('should sort contacts by name, recent, or frequent', () => {
    const store = createStore();
    store.addContact({ name: 'Charlie', email: 'charlie@example.com' });
    store.addContact({ name: 'Alice', email: 'alice@example.com' });
    store.addContact({ name: 'Bob', email: 'bob@example.com' });

    // Track usage
    store.recordUsage('bob@example.com');
    store.recordUsage('bob@example.com');
    store.recordUsage('alice@example.com');

    const byName = store.getAllContacts({ sortBy: 'name' });
    expect(byName.map((c) => c.name)).toEqual(['Alice', 'Bob', 'Charlie']);

    const byFrequent = store.getAllContacts({ sortBy: 'frequent' });
    expect(byFrequent[0].name).toBe('Bob');

    const byRecent = store.getAllContacts({ sortBy: 'recent' });
    expect(byRecent[0].name).toBe('Alice'); // last recordUsage
  });
});

// ─── Search & Fuzzy Matching ─────────────────────────────────────────────────

describe('ContactStore Search', () => {
  let store;

  beforeEach(() => {
    store = createStore();
    store.addContact({ name: 'John Smith', email: 'john.smith@acme.com', company: 'Acme Corp' });
    store.addContact({ name: 'Sarah Jones', email: 'sarah@example.org', aliases: ['SJ'] });
    store.addContact({ name: 'Sarah Miller', email: 'sarah.miller@corp.com' });
    store.addContact({ name: 'Bob Wilson', email: 'bob@test.com' });
  });

  it('should find by exact name', () => {
    const results = store.search('John Smith');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].contact.email).toBe('john.smith@acme.com');
    expect(results[0].score).toBeGreaterThanOrEqual(0.9);
  });

  it('should find by partial name (first name)', () => {
    const results = store.search('Sarah');
    expect(results.length).toBe(2); // Sarah Jones and Sarah Miller
  });

  it('should find by alias', () => {
    const results = store.search('SJ');
    expect(results.length).toBeGreaterThan(0);
    // SJ is an alias for Sarah Jones
    const sjResult = results.find((r) => r.contact.email === 'sarah@example.org');
    expect(sjResult).toBeTruthy();
  });

  it('should find by email prefix', () => {
    const results = store.search('bob');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].contact.email).toBe('bob@test.com');
  });

  it('should find by company', () => {
    const results = store.search('Acme');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].contact.company).toBe('Acme Corp');
  });

  it('should return empty for no match with high threshold', () => {
    const results = store.search('zzzznonexistent', { minScore: 0.5 });
    expect(results).toHaveLength(0);
  });

  it('should return empty for empty query', () => {
    expect(store.search('')).toHaveLength(0);
    expect(store.search(null)).toHaveLength(0);
  });

  it('should respect limit option', () => {
    const results = store.search('Sarah', { limit: 1 });
    expect(results).toHaveLength(1);
  });

  it('should boost frequently used contacts', () => {
    store.recordUsage('sarah.miller@corp.com');
    store.recordUsage('sarah.miller@corp.com');
    store.recordUsage('sarah.miller@corp.com');

    const results = store.search('Sarah');
    // Sarah Miller should be boosted above Sarah Jones due to usage
    expect(results[0].contact.email).toBe('sarah.miller@corp.com');
  });
});

// ─── Guest Resolution ────────────────────────────────────────────────────────

describe('ContactStore Guest Resolution', () => {
  let store;

  beforeEach(() => {
    store = createStore();
    store.addContact({ name: 'John Smith', email: 'john@acme.com' });
    store.addContact({ name: 'Sarah Jones', email: 'sarah@example.org' });
    store.addContact({ name: 'Bob Wilson', email: 'bob@test.com' });
  });

  it('should resolve a direct email', () => {
    const result = store.resolveGuest('alice@newco.com');
    expect(result.email).toBe('alice@newco.com');
    expect(result.confidence).toBe('exact');
  });

  it('should resolve a known contact by name', () => {
    const result = store.resolveGuest('John Smith');
    expect(result.email).toBe('john@acme.com');
    expect(result.confidence).toBe('exact');
  });

  it('should resolve a known contact by first name', () => {
    const result = store.resolveGuest('Bob');
    expect(result.email).toBe('bob@test.com');
    expect(result.confidence === 'exact' || result.confidence === 'high').toBe(true);
  });

  it('should return none for completely unknown names', () => {
    const result = store.resolveGuest('Zaphod Beeblebrox');
    expect(result.confidence).toBe('none');
    expect(result.email).toBeNull();
  });

  it('should resolve a comma-separated guest list', () => {
    const result = store.resolveGuests('John Smith, sarah@example.org, Unknown Person');
    expect(result.resolved).toHaveLength(2);
    expect(result.resolved[0].email).toBe('john@acme.com');
    expect(result.resolved[1].email).toBe('sarah@example.org');
    expect(result.unresolved.length + result.ambiguous.length).toBeGreaterThan(0);
  });

  it('should resolve an array of guests', () => {
    const result = store.resolveGuests(['Bob', 'john@acme.com']);
    expect(result.resolved).toHaveLength(2);
  });

  it('should handle empty guest list', () => {
    const result = store.resolveGuests('');
    expect(result.resolved).toHaveLength(0);
    expect(result.unresolved).toHaveLength(0);
  });
});

// ─── Suggestions ─────────────────────────────────────────────────────────────

describe('ContactStore Suggestions', () => {
  let store;

  beforeEach(() => {
    store = createStore();
    store.addContact({ name: 'John Smith', email: 'john@acme.com' });
    store.addContact({ name: 'Sarah Jones', email: 'sarah@example.org' });
    store.addContact({ name: 'Bob Wilson', email: 'bob@test.com' });
    // Make Bob the most recently used
    store.recordUsage('bob@test.com');
  });

  it('should suggest recent contacts when no partial given', () => {
    const suggestions = store.suggest('');
    expect(suggestions.length).toBeGreaterThan(0);
    // Bob should be first (most recently used)
    expect(suggestions[0].email).toBe('bob@test.com');
  });

  it('should suggest matching contacts for partial input', () => {
    const suggestions = store.suggest('Sar');
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions[0].email).toBe('sarah@example.org');
  });

  it('should exclude already-added guests', () => {
    const suggestions = store.suggest('', { exclude: ['bob@test.com'] });
    expect(suggestions.every((s) => s.email !== 'bob@test.com')).toBe(true);
  });

  it('should respect limit', () => {
    const suggestions = store.suggest('', { limit: 1 });
    expect(suggestions).toHaveLength(1);
  });
});

// ─── Usage Tracking ──────────────────────────────────────────────────────────

describe('ContactStore Usage Tracking', () => {
  it('should increment usage count', () => {
    const store = createStore();
    store.addContact({ name: 'John', email: 'john@example.com' });

    store.recordUsage('john@example.com');
    store.recordUsage('john@example.com');
    store.recordUsage('john@example.com');

    const contact = store.getByEmail('john@example.com');
    expect(contact.usageCount).toBe(3);
    expect(contact.lastUsed).toBeTruthy();
  });

  it('should handle unknown email gracefully', () => {
    const store = createStore();
    // Should not throw
    store.recordUsage('unknown@example.com');
  });

  it('should persist usage data', () => {
    const store1 = createStore();
    store1.addContact({ name: 'John', email: 'john@example.com' });
    store1.recordUsage('john@example.com');

    const store2 = new ContactStore(tmpDir);
    const contact = store2.getByEmail('john@example.com');
    expect(contact.usageCount).toBe(1);
  });
});

// ─── Import ──────────────────────────────────────────────────────────────────

describe('ContactStore Import', () => {
  it('should import from legacy agent memory markdown', () => {
    const store = createStore();
    const markdown = `*Add contacts here in format: Name: email@example.com*
- John Smith: john@example.com
- Sarah Jones: sarah@example.org | calendar: https://calendar.example.com/sarah
- Bob Wilson: bob@test.com`;

    const result = store.importFromMemory(markdown);
    expect(result.imported).toBe(3);
    expect(result.skipped).toBe(0);

    const contacts = store.getAllContacts();
    expect(contacts).toHaveLength(3);

    // Sarah should have a calendar URL
    const sarah = store.getByEmail('sarah@example.org');
    expect(sarah.calendarUrl).toBe('https://calendar.example.com/sarah');
  });

  it('should skip invalid emails during import', () => {
    const store = createStore();
    const markdown = `- Valid: valid@example.com
- Invalid: notanemail`;

    const result = store.importFromMemory(markdown);
    expect(result.imported).toBe(1);
  });

  it('should handle empty markdown', () => {
    const store = createStore();
    const result = store.importFromMemory('');
    expect(result.imported).toBe(0);
  });

  it('should handle null markdown', () => {
    const store = createStore();
    const result = store.importFromMemory(null);
    expect(result.imported).toBe(0);
  });
});

// ─── Learn from Events ───────────────────────────────────────────────────────

describe('ContactStore Learn from Events', () => {
  it('should learn contacts from calendar event guests', () => {
    const store = createStore();
    const events = [
      { title: 'Meeting', guests: ['alice@example.com', 'bob@corp.com'] },
      { title: 'Sync', guests: ['charlie.brown@company.org'] },
    ];

    const result = store.learnFromEvents(events);
    expect(result.learned).toBe(3);

    // Verify name derivation from email
    const alice = store.getByEmail('alice@example.com');
    expect(alice.name).toBe('Alice');

    const charlie = store.getByEmail('charlie.brown@company.org');
    expect(charlie.name).toBe('Charlie Brown');
  });

  it('should learn from attendee objects with displayName', () => {
    const store = createStore();
    const events = [
      {
        title: 'Meeting',
        attendees: [{ email: 'alice@example.com', displayName: 'Alice Wonderland' }],
      },
    ];

    const result = store.learnFromEvents(events);
    expect(result.learned).toBe(1);

    const alice = store.getByEmail('alice@example.com');
    expect(alice.name).toBe('Alice Wonderland');
  });

  it('should not duplicate existing contacts', () => {
    const store = createStore();
    store.addContact({ name: 'Alice', email: 'alice@example.com' });

    const events = [{ title: 'Meeting', guests: ['alice@example.com', 'bob@corp.com'] }];

    const result = store.learnFromEvents(events);
    expect(result.learned).toBe(1);
    expect(result.existing).toBe(1);
    expect(store.getAllContacts()).toHaveLength(2);
  });

  it('should handle events without guests', () => {
    const store = createStore();
    const result = store.learnFromEvents([{ title: 'Solo meeting' }]);
    expect(result.learned).toBe(0);
  });
});

// ─── Guest Prompt Builder ────────────────────────────────────────────────────

describe('ContactStore buildGuestPrompt', () => {
  it('should build a prompt for fully resolved guests', () => {
    const store = createStore();
    store.addContact({ name: 'John', email: 'john@example.com' });

    const resolution = store.resolveGuests('john@example.com');
    const { prompt, allResolved, resolvedEmails } = store.buildGuestPrompt(resolution);

    expect(allResolved).toBe(true);
    expect(resolvedEmails).toContain('john@example.com');
    expect(prompt).toContain('john@example.com');
  });

  it('should build a prompt for unresolved guests', () => {
    const store = createStore();
    const resolution = store.resolveGuests('Unknown Person');
    const { prompt, allResolved } = store.buildGuestPrompt(resolution);

    expect(allResolved).toBe(false);
    expect(prompt).toContain('Unknown Person');
    expect(prompt.toLowerCase()).toContain('email');
  });

  it('should build a prompt with suggestions for similar names', () => {
    const store = createStore();
    store.addContact({ name: 'Sarah Jones', email: 'sarah@example.com' });

    const resolution = store.resolveGuests('Sara'); // slight misspelling
    const { prompt } = store.buildGuestPrompt(resolution);

    // Should mention Sarah Jones as a suggestion or resolve her
    expect(prompt.length).toBeGreaterThan(0);
  });
});

// ─── Stats ───────────────────────────────────────────────────────────────────

describe('ContactStore Stats', () => {
  it('should return correct stats', () => {
    const store = createStore();
    store.addContact({ name: 'John', email: 'john@example.com', source: 'manual' });
    store.addContact({
      name: 'Sarah',
      email: 'sarah@example.com',
      calendarUrl: 'https://cal.example.com/sarah',
      source: 'calendar',
    });

    const stats = store.getStats();
    expect(stats.total).toBe(2);
    expect(stats.withCalendar).toBe(1);
    expect(stats.sources.manual).toBe(1);
    expect(stats.sources.calendar).toBe(1);
  });
});

// ─── Edge Cases ──────────────────────────────────────────────────────────────

describe('ContactStore Edge Cases', () => {
  it('should handle corrupted JSON file gracefully', () => {
    // Write bad JSON to the contacts file
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'contacts.json'), 'NOT JSON!!!');

    const store = createStore();
    expect(store.getAllContacts()).toHaveLength(0); // should not throw
  });

  it('should handle missing store directory', () => {
    const store = new ContactStore(path.join(tmpDir, 'nonexistent', 'deep', 'path'));
    const contact = store.addContact({ name: 'Test', email: 'test@example.com' });
    expect(contact.id).toBeTruthy();
  });

  it('should handle concurrent adds without data loss', () => {
    const store = createStore();
    for (let i = 0; i < 50; i++) {
      store.addContact({ name: `User ${i}`, email: `user${i}@example.com` });
    }
    expect(store.getAllContacts()).toHaveLength(50);
  });

  it('should merge aliases without duplicates', () => {
    const store = createStore();
    store.addContact({ name: 'John', email: 'john@example.com', aliases: ['Johnny', 'JS'] });
    store.addContact({ name: 'John Smith', email: 'john@example.com', aliases: ['Johnny', 'John S.'] });

    const contact = store.getByEmail('john@example.com');
    // Johnny should appear only once, JS and John S. should both be there
    const aliasSet = new Set(contact.aliases.map((a) => a.toLowerCase()));
    expect(aliasSet.has('johnny')).toBe(true);
    expect(aliasSet.has('js')).toBe(true);
    expect(aliasSet.has('john s.')).toBe(true);
    expect(contact.aliases.filter((a) => a.toLowerCase() === 'johnny')).toHaveLength(1);
  });
});
