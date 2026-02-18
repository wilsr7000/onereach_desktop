/**
 * Unit tests for ContactDB (DuckDB-backed canonical contact store)
 *
 * Covers: upsert, aliases, name resolution, meeting attendance,
 * analytics (frequency, co-attendees), search, import, and edge cases.
 *
 * Uses a temp directory per test so DuckDB creates a fresh database.
 *
 * Run:  npx vitest run test/unit/contact-db.test.js
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';

// Mock log-event-queue
vi.mock('../../lib/log-event-queue', () => ({
  getLogQueue: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

let ContactDB, isValidEmail, normalizeName, nameFromEmail;
let DuckDBAvailable = false;
let tmpDir;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'contact-db-test-'));

  try {
    const mod = await import('../../lib/contact-db.js');
    ContactDB = mod.ContactDB;
    isValidEmail = mod.isValidEmail;
    normalizeName = mod.normalizeName;
    nameFromEmail = mod.nameFromEmail;

    // Test if DuckDB is actually available by creating an instance
    const testDb = new ContactDB(tmpDir);
    const ok = await testDb.init();
    DuckDBAvailable = ok;
    await testDb.close();
  } catch {
    DuckDBAvailable = false;
  }
});

afterEach(async () => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function createDB() {
  return new ContactDB(tmpDir);
}

// Skip all DuckDB-dependent tests if native module isn't available
const describeDB = DuckDBAvailable ? describe : describe.skip;

// ─── Utility Functions ───────────────────────────────────────────────────────

describe('ContactDB Utilities', () => {
  it('isValidEmail should validate correctly', () => {
    expect(isValidEmail('john@example.com')).toBe(true);
    expect(isValidEmail('bad')).toBe(false);
    expect(isValidEmail(null)).toBe(false);
  });

  it('normalizeName should strip titles and lowercase', () => {
    expect(normalizeName('Dr. John Smith')).toBe('john smith');
    expect(normalizeName('  Alice  ')).toBe('alice');
  });

  it('nameFromEmail should derive display names', () => {
    expect(nameFromEmail('john.smith@acme.com')).toBe('John Smith');
    expect(nameFromEmail('alice@example.com')).toBe('Alice');
    expect(nameFromEmail('bob-wilson@corp.org')).toBe('Bob Wilson');
  });
});

// ─── DuckDB Contact CRUD ─────────────────────────────────────────────────────

describeDB('ContactDB CRUD', () => {
  it('should upsert a new contact', async () => {
    const db = createDB();
    await db.init();

    const contact = await db.upsertContact({
      name: 'John Smith',
      email: 'john@example.com',
      company: 'Acme',
    });

    expect(contact).toBeTruthy();
    expect(contact.canonical_name).toBe('John Smith');
    expect(contact.email).toBe('john@example.com');
    expect(contact.company).toBe('Acme');

    await db.close();
  });

  it('should merge on duplicate email', async () => {
    const db = createDB();
    await db.init();

    await db.upsertContact({ name: 'John', email: 'john@example.com' });
    const merged = await db.upsertContact({
      name: 'John Smith',
      email: 'john@example.com',
      company: 'Acme',
    });

    // Longer name should win
    expect(merged.canonical_name).toBe('John Smith');
    expect(merged.company).toBe('Acme');

    // Should only have one contact
    const all = await db.getAllContacts();
    expect(all).toHaveLength(1);

    await db.close();
  });

  it('should normalize email to lowercase', async () => {
    const db = createDB();
    await db.init();

    await db.upsertContact({ name: 'John', email: 'JOHN@Example.COM' });
    const found = await db.getByEmail('john@example.com');
    expect(found).toBeTruthy();

    await db.close();
  });

  it('should reject invalid email', async () => {
    const db = createDB();
    await db.init();

    await expect(db.upsertContact({ name: 'X', email: 'bad' })).rejects.toThrow('Invalid email');

    await db.close();
  });

  it('should delete a contact and its aliases', async () => {
    const db = createDB();
    await db.init();

    const contact = await db.upsertContact({ name: 'Jane', email: 'jane@example.com' });
    await db.addAlias(contact.id, 'Janie');
    await db.deleteContact(contact.id);

    const found = await db.getByEmail('jane@example.com');
    expect(found).toBeNull();

    await db.close();
  });

  it('should sort contacts by name, recent, or frequent', async () => {
    const db = createDB();
    await db.init();

    await db.upsertContact({ name: 'Charlie', email: 'charlie@example.com' });
    await db.upsertContact({ name: 'Alice', email: 'alice@example.com' });
    await db.upsertContact({ name: 'Bob', email: 'bob@example.com' });

    const byName = await db.getAllContacts('name');
    expect(byName.map((c) => c.canonical_name)).toEqual(['Alice', 'Bob', 'Charlie']);

    await db.close();
  });
});

// ─── Name Resolution & Aliases ───────────────────────────────────────────────

describeDB('ContactDB Name Resolution', () => {
  it('should resolve by exact email', async () => {
    const db = createDB();
    await db.init();

    await db.upsertContact({ name: 'John', email: 'john@example.com' });
    const result = await db.resolve('john@example.com');

    expect(result.confidence).toBe('exact');
    expect(result.contact.email).toBe('john@example.com');

    await db.close();
  });

  it('should resolve by exact name alias', async () => {
    const db = createDB();
    await db.init();

    await db.upsertContact({ name: 'John Smith', email: 'john@example.com' });
    const result = await db.resolve('John Smith');

    expect(result.confidence).toBe('exact');
    expect(result.contact.email).toBe('john@example.com');

    await db.close();
  });

  it('should resolve by first name via prefix match', async () => {
    const db = createDB();
    await db.init();

    await db.upsertContact({ name: 'Bob Wilson', email: 'bob@test.com' });
    const result = await db.resolve('Bob');

    expect(result.confidence === 'exact' || result.confidence === 'high').toBe(true);
    expect(result.contact.email).toBe('bob@test.com');

    await db.close();
  });

  it('should register additional aliases', async () => {
    const db = createDB();
    await db.init();

    const contact = await db.upsertContact({ name: 'Robert Wilson', email: 'bob@test.com' });
    await db.addAlias(contact.id, 'Bob');
    await db.addAlias(contact.id, 'Bobby');

    const result = await db.resolve('Bobby');
    expect(result.contact.email).toBe('bob@test.com');

    await db.close();
  });

  it('should use fuzzy matching for misspellings', async () => {
    const db = createDB();
    await db.init();

    await db.upsertContact({ name: 'Sarah Johnson', email: 'sarah@example.com' });
    const result = await db.resolve('Sara Johnson'); // missing 'h'

    expect(result.contact).toBeTruthy();
    expect(result.contact.email).toBe('sarah@example.com');

    await db.close();
  });

  it('should return none for completely unknown names', async () => {
    const db = createDB();
    await db.init();

    await db.upsertContact({ name: 'John', email: 'john@example.com' });
    const result = await db.resolve('Zaphod Beeblebrox');

    expect(result.confidence).toBe('none');

    await db.close();
  });

  it('should resolve a guest list', async () => {
    const db = createDB();
    await db.init();

    await db.upsertContact({ name: 'John Smith', email: 'john@acme.com' });
    await db.upsertContact({ name: 'Sarah Jones', email: 'sarah@example.org' });

    const result = await db.resolveGuests('John Smith, sarah@example.org, Unknown');

    expect(result.resolved).toHaveLength(2);
    expect(result.unresolved.length + result.ambiguous.length).toBeGreaterThan(0);

    await db.close();
  });
});

// ─── Meeting Attendance ──────────────────────────────────────────────────────

describeDB('ContactDB Meeting Attendance', () => {
  it('should record attendance and auto-create contact', async () => {
    const db = createDB();
    await db.init();

    await db.recordAttendance({
      meetingTitle: 'Team Standup',
      meetingDate: '2026-02-10T09:00:00Z',
      contactEmail: 'alice@example.com',
    });

    // Should have auto-created the contact
    const contact = await db.getByEmail('alice@example.com');
    expect(contact).toBeTruthy();
    expect(contact.usage_count).toBe(1);

    await db.close();
  });

  it('should deduplicate attendance for same meeting', async () => {
    const db = createDB();
    await db.init();

    const data = {
      meetingTitle: 'Team Standup',
      meetingDate: '2026-02-10T09:00:00Z',
      contactEmail: 'alice@example.com',
    };

    await db.recordAttendance(data);
    await db.recordAttendance(data); // duplicate

    const meetings = await db.getContactMeetings('alice@example.com');
    expect(meetings).toHaveLength(1);

    await db.close();
  });

  it('should ingest events with attendees', async () => {
    const db = createDB();
    await db.init();

    const events = [
      {
        title: 'Project Review',
        startTime: '2026-02-10T14:00:00Z',
        endTime: '2026-02-10T15:00:00Z',
        attendees: [
          { email: 'alice@example.com', displayName: 'Alice Wonderland' },
          { email: 'bob@corp.com', displayName: 'Bob Builder' },
        ],
      },
      {
        title: 'Sprint Planning',
        startTime: '2026-02-11T10:00:00Z',
        guests: ['alice@example.com', 'charlie@example.com'],
      },
    ];

    const result = await db.ingestEvents(events);
    expect(result.processed).toBe(2);
    expect(result.contacts).toBeGreaterThan(0);

    // Alice should have displayName as canonical name
    const alice = await db.getByEmail('alice@example.com');
    expect(alice.canonical_name).toBe('Alice Wonderland');

    await db.close();
  });

  it('should track meeting history per contact', async () => {
    const db = createDB();
    await db.init();

    await db.upsertContact({ name: 'Alice', email: 'alice@example.com' });

    await db.recordAttendance({
      meetingTitle: 'Meeting A',
      meetingDate: '2026-02-10T09:00:00Z',
      contactEmail: 'alice@example.com',
    });
    await db.recordAttendance({
      meetingTitle: 'Meeting B',
      meetingDate: '2026-02-11T14:00:00Z',
      contactEmail: 'alice@example.com',
    });

    const meetings = await db.getContactMeetings('alice@example.com');
    expect(meetings).toHaveLength(2);
    // Should be ordered by date descending
    expect(meetings[0].meeting_title).toBe('Meeting B');

    await db.close();
  });
});

// ─── Analytics ───────────────────────────────────────────────────────────────

describeDB('ContactDB Analytics', () => {
  let db;

  beforeEach(async () => {
    db = createDB();
    await db.init();

    // Set up test data: Alice attends 3 meetings, Bob attends 2
    await db.upsertContact({ name: 'Alice', email: 'alice@example.com' });
    await db.upsertContact({ name: 'Bob', email: 'bob@example.com' });
    await db.upsertContact({ name: 'Charlie', email: 'charlie@example.com' });

    // Meeting 1: Alice + Bob
    await db.recordAttendance({
      meetingTitle: 'Standup',
      meetingDate: '2026-02-10T09:00:00Z',
      contactEmail: 'alice@example.com',
    });
    await db.recordAttendance({
      meetingTitle: 'Standup',
      meetingDate: '2026-02-10T09:00:00Z',
      contactEmail: 'bob@example.com',
    });

    // Meeting 2: Alice + Charlie
    await db.recordAttendance({
      meetingTitle: 'Review',
      meetingDate: '2026-02-11T14:00:00Z',
      contactEmail: 'alice@example.com',
    });
    await db.recordAttendance({
      meetingTitle: 'Review',
      meetingDate: '2026-02-11T14:00:00Z',
      contactEmail: 'charlie@example.com',
    });

    // Meeting 3: Alice only
    await db.recordAttendance({
      meetingTitle: 'Solo Sync',
      meetingDate: '2026-02-12T10:00:00Z',
      contactEmail: 'alice@example.com',
    });
  });

  afterEach(async () => {
    await db.close();
  });

  it('should return contacts by meeting frequency', async () => {
    const frequent = await db.getFrequentContacts({ limit: 10 });

    expect(frequent.length).toBeGreaterThan(0);
    // Alice should be first (3 meetings)
    expect(frequent[0].email).toBe('alice@example.com');
    expect(frequent[0].meeting_count).toBe(3);
  });

  it('should find co-attendees', async () => {
    const coAttendees = await db.getCoAttendees('alice@example.com', 10);

    // Bob and Charlie both attended meetings with Alice
    expect(coAttendees.length).toBe(2);
    const emails = coAttendees.map((c) => c.email);
    expect(emails).toContain('bob@example.com');
    expect(emails).toContain('charlie@example.com');
  });

  it('should return correct stats', async () => {
    const stats = await db.getStats();

    expect(stats.totalContacts).toBe(3);
    expect(stats.totalAttendanceRecords).toBe(5);
    expect(stats.totalAliases).toBeGreaterThan(0);
  });
});

// ─── Search ──────────────────────────────────────────────────────────────────

describeDB('ContactDB Search', () => {
  it('should search by name', async () => {
    const db = createDB();
    await db.init();

    await db.upsertContact({ name: 'John Smith', email: 'john@acme.com', company: 'Acme' });
    await db.upsertContact({ name: 'Sarah Jones', email: 'sarah@example.com' });

    const results = await db.search('John');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].email).toBe('john@acme.com');

    await db.close();
  });

  it('should search by email prefix', async () => {
    const db = createDB();
    await db.init();

    await db.upsertContact({ name: 'Alice', email: 'alice.wonder@example.com' });

    const results = await db.search('alice');
    expect(results.length).toBeGreaterThan(0);

    await db.close();
  });

  it('should suggest contacts for autocomplete', async () => {
    const db = createDB();
    await db.init();

    await db.upsertContact({ name: 'Alice', email: 'alice@example.com' });
    await db.upsertContact({ name: 'Bob', email: 'bob@example.com' });

    const suggestions = await db.suggest('Ali');
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions[0].email).toBe('alice@example.com');

    await db.close();
  });

  it('should exclude emails from suggestions', async () => {
    const db = createDB();
    await db.init();

    await db.upsertContact({ name: 'Alice', email: 'alice@example.com' });
    await db.upsertContact({ name: 'Bob', email: 'bob@example.com' });

    const suggestions = await db.suggest('', { exclude: ['alice@example.com'] });
    expect(suggestions.every((s) => s.email !== 'alice@example.com')).toBe(true);

    await db.close();
  });
});

// ─── Import ──────────────────────────────────────────────────────────────────

describeDB('ContactDB Import', () => {
  it('should import from legacy markdown', async () => {
    const db = createDB();
    await db.init();

    const markdown = `*Add contacts here*
- John Smith: john@example.com
- Sarah Jones: sarah@example.org | calendar: https://cal.example.com/sarah`;

    const result = await db.importFromMemory(markdown);
    expect(result.imported).toBe(2);

    const sarah = await db.getByEmail('sarah@example.org');
    expect(sarah.calendar_url).toBe('https://cal.example.com/sarah');

    await db.close();
  });

  it('should import from JSON contacts array', async () => {
    const db = createDB();
    await db.init();

    const contacts = [
      { name: 'John', email: 'john@example.com', aliases: ['Johnny'], company: 'Acme' },
      { name: 'Sarah', email: 'sarah@example.com' },
    ];

    const result = await db.importFromJSON(contacts);
    expect(result.imported).toBe(2);

    // Aliases should be registered
    const resolved = await db.resolve('Johnny');
    expect(resolved.contact.email).toBe('john@example.com');

    await db.close();
  });
});
