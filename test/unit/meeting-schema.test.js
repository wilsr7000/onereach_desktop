/**
 * Meeting Schema + Templates — Unit Tests
 *
 * Covers: object creation, validation, lifecycle mutations, iCal export,
 * Space item conversion, template registry, and custom templates.
 *
 * Run:  npx vitest run test/unit/meeting-schema.test.js
 */

import { describe, it, expect, beforeEach } from 'vitest';

// Direct imports (no mocks needed — pure logic modules)
const {
  SCHEMA_VERSION,
  createMeetingObject,
  createFromTemplate,
  validate,
  startMeeting,
  completeMeeting,
  addParticipant,
  addActionItem,
  toICS,
  toSpaceItem,
  fromSpaceItem,
} = require('../../lib/meeting-schema');

const {
  BUILT_IN_TEMPLATES,
  getTemplate,
  getAllTemplates,
  getTemplatesByCategory,
  createCustomTemplate,
  customTemplateToSpaceItem,
  customTemplateFromSpaceItem,
  mergeTemplates,
} = require('../../lib/meeting-templates');

// ─── Meeting Object Creation ───────────────────────────────────────────────────

describe('Meeting Object Creation', () => {
  it('creates a valid object with minimal options', () => {
    const m = createMeetingObject({ spaceId: 'space-1' });
    const { valid, errors } = validate(m);
    expect(valid).toBe(true);
    expect(errors).toHaveLength(0);
    expect(m.schemaVersion).toBe(SCHEMA_VERSION);
    expect(m.spaceId).toBe('space-1');
    expect(m.status).toBe('active');
    expect(m.pre).toBeDefined();
    expect(m.during).toBeDefined();
    expect(m.post).toBeDefined();
  });

  it('embeds iCal calendar node with correct structure', () => {
    const m = createMeetingObject({
      spaceId: 'space-1',
      title: 'Sprint Review',
      hostName: 'Alice',
      hostEmail: 'alice@co.com',
    });
    expect(m.calendar.vcalendar.version).toBe('2.0');
    expect(m.calendar.vevent.summary).toBe('Sprint Review');
    expect(m.calendar.vevent.organizer.cn).toBe('Alice');
    expect(m.calendar.vevent.organizer.email).toBe('alice@co.com');
    expect(m.calendar.vevent.uid).toContain('@wiser');
  });

  it('populates attendees and contacts from options', () => {
    const m = createMeetingObject({
      spaceId: 'space-1',
      attendees: [
        { displayName: 'Jamie', email: 'jamie@co.com' },
        { displayName: 'Alex', email: 'alex@co.com' },
      ],
    });
    expect(m.calendar.vevent.attendees).toHaveLength(2);
    expect(m.calendar.vevent.attendees[0].cn).toBe('Jamie');
    expect(m.contacts).toHaveLength(2);
    expect(m.contacts[1].displayName).toBe('Alex');
  });

  it('sets scheduled status for future start times', () => {
    const future = new Date(Date.now() + 86400000).toISOString();
    const m = createMeetingObject({ spaceId: 'space-1', startTime: future });
    expect(m.status).toBe('scheduled');
  });

  it('calculates end time from duration', () => {
    const start = '2026-03-26T14:00:00.000Z';
    const m = createMeetingObject({ spaceId: 'space-1', startTime: start, duration: 45 });
    expect(m.calendar.vevent.dtend).toBe('2026-03-26T14:45:00.000Z');
  });

  it('initializes all three checkpoint sections', () => {
    const m = createMeetingObject({ spaceId: 'space-1' });
    expect(m.pre.checkpoints).toBeDefined();
    expect(m.pre.checkpoints.agendaSet).toBe(false);
    expect(m.during.checkpoints).toBeDefined();
    expect(m.during.checkpoints.allAudioWorking).toBe(false);
    expect(m.post.checkpoints).toBeDefined();
    expect(m.post.checkpoints.recordingSaved).toBe(false);
  });

  it('marks agendaSet when agenda is provided', () => {
    const m = createMeetingObject({
      spaceId: 'space-1',
      agenda: [{ item: 'Review PRs', owner: null, duration: 10 }],
    });
    expect(m.pre.checkpoints.agendaSet).toBe(true);
    expect(m.pre.agenda).toHaveLength(1);
  });
});

// ─── Template Creation ─────────────────────────────────────────────────────────

describe('Template-based Creation', () => {
  it('creates a meeting from a built-in template', () => {
    const m = createFromTemplate('touch-base', { spaceId: 'space-1' }, getTemplate);
    expect(m.templateId).toBe('touch-base');
    expect(m.pre.template.id).toBe('touch-base');
    expect(m.pre.template.suggestedDuration).toBe(30);
    expect(m.pre.template.layout).toBe('side-by-side');
  });

  it('throws for unknown template', () => {
    expect(() => createFromTemplate('nonexistent', {}, getTemplate)).toThrow('Unknown meeting template');
  });

  it('merges user options with template defaults', () => {
    const m = createFromTemplate('marathon', {
      spaceId: 'space-1',
      title: 'Planning Day',
      duration: 180,
    }, getTemplate);
    expect(m.calendar.vevent.summary).toBe('Planning Day');
    expect(m.pre.template.suggestedDuration).toBe(120);
  });
});

// ─── Validation ────────────────────────────────────────────────────────────────

describe('Validation', () => {
  it('rejects null', () => {
    const { valid } = validate(null);
    expect(valid).toBe(false);
  });

  it('rejects missing spaceId', () => {
    const m = createMeetingObject({});
    m.spaceId = null;
    const { valid, errors } = validate(m);
    expect(valid).toBe(false);
    expect(errors.some(e => e.includes('spaceId'))).toBe(true);
  });

  it('rejects invalid status', () => {
    const m = createMeetingObject({ spaceId: 'space-1' });
    m.status = 'bogus';
    const { valid } = validate(m);
    expect(valid).toBe(false);
  });
});

// ─── Lifecycle Mutations ───────────────────────────────────────────────────────

describe('Lifecycle', () => {
  let meeting;

  beforeEach(() => {
    meeting = createMeetingObject({ spaceId: 'space-1' });
  });

  it('startMeeting sets status and timestamp', () => {
    const started = startMeeting(meeting);
    expect(started.status).toBe('active');
    expect(started.during.startedAt).toBeTruthy();
    expect(started.during.startedAt).not.toBe(meeting.during.startedAt);
  });

  it('completeMeeting sets status, duration, and end time', () => {
    const started = startMeeting(meeting);
    const completed = completeMeeting(started, {
      participants: [{ identity: 'Alice' }],
      recordingItemIds: ['rec-1'],
    });
    expect(completed.status).toBe('completed');
    expect(completed.during.endedAt).toBeTruthy();
    expect(completed.during.actualDuration).toBeTypeOf('number');
    expect(completed.during.participants).toHaveLength(1);
    expect(completed.post.recordingItemIds).toEqual(['rec-1']);
    expect(completed.post.checkpoints.recordingSaved).toBe(true);
  });

  it('addParticipant appends without duplicates', () => {
    let m = addParticipant(meeting, { identity: 'Alice' });
    expect(m.during.participants).toHaveLength(1);
    m = addParticipant(m, { identity: 'Alice' });
    expect(m.during.participants).toHaveLength(1);
    m = addParticipant(m, { identity: 'Bob' });
    expect(m.during.participants).toHaveLength(2);
  });

  it('addActionItem appends to post phase', () => {
    const m = addActionItem(meeting, { text: 'Fix the bug', assignee: 'jamie@co.com' });
    expect(m.post.actionItems).toHaveLength(1);
    expect(m.post.actionItems[0].text).toBe('Fix the bug');
    expect(m.post.actionItems[0].status).toBe('open');
  });
});

// ─── iCal Export ───────────────────────────────────────────────────────────────

describe('iCal Export', () => {
  it('generates valid ICS string', () => {
    const m = createMeetingObject({
      spaceId: 'space-1',
      title: 'Standup',
      hostName: 'Alice',
      hostEmail: 'alice@co.com',
      attendees: [{ displayName: 'Bob', email: 'bob@co.com' }],
    });
    const ics = toICS(m);
    expect(ics).toContain('BEGIN:VCALENDAR');
    expect(ics).toContain('END:VCALENDAR');
    expect(ics).toContain('BEGIN:VEVENT');
    expect(ics).toContain('SUMMARY:Standup');
    expect(ics).toContain('ORGANIZER;CN=Alice:mailto:alice@co.com');
    expect(ics).toContain('ATTENDEE;CN=Bob');
    expect(ics).toContain('PRODID:-//WISER//Meeting//EN');
  });

  it('returns null for missing vevent', () => {
    expect(toICS({})).toBeNull();
  });
});

// ─── Space Item Conversion ─────────────────────────────────────────────────────

describe('Space Item Conversion', () => {
  it('round-trips through toSpaceItem / fromSpaceItem', () => {
    const original = createMeetingObject({ spaceId: 'space-1', title: 'Review' });
    const item = toSpaceItem(original);

    expect(item.type).toBe('text');
    expect(item.tags).toContain('wiser-meeting');
    expect(item.spaceId).toBe('space-1');
    expect(item.metadata.meetingId).toBe(original.id);

    const parsed = fromSpaceItem(item);
    expect(parsed.id).toBe(original.id);
    expect(parsed.calendar.vevent.summary).toBe('Review');
  });

  it('fromSpaceItem returns null for bad content', () => {
    expect(fromSpaceItem({ content: 'not json' })).toBeNull();
  });
});

// ─── Template Registry ─────────────────────────────────────────────────────────

describe('Template Registry', () => {
  it('has exactly 12 built-in templates', () => {
    expect(BUILT_IN_TEMPLATES).toHaveLength(12);
  });

  it('every template has required fields', () => {
    for (const t of BUILT_IN_TEMPLATES) {
      expect(t.id).toBeTruthy();
      expect(t.name).toBeTruthy();
      expect(t.category).toMatch(/^(live|async|broadcast)$/);
      expect(t.captureMode).toBeTruthy();
      expect(t.sessionType).toMatch(/^(live|solo)$/);
      expect(typeof t.suggestedDuration).toBe('number');
      expect(t.source).toBe('builtin');
    }
  });

  it('getTemplate returns by ID', () => {
    const t = getTemplate('podcast');
    expect(t).toBeTruthy();
    expect(t.name).toBe('Podcast');
  });

  it('getTemplate returns null for unknown', () => {
    expect(getTemplate('nope')).toBeNull();
  });

  it('getTemplatesByCategory groups correctly', () => {
    const cats = getTemplatesByCategory();
    expect(cats.live.length).toBeGreaterThan(0);
    expect(cats.async.length).toBeGreaterThan(0);
    expect(cats.broadcast.length).toBeGreaterThan(0);
    const total = cats.live.length + cats.async.length + cats.broadcast.length;
    expect(total).toBe(12);
  });

  it('all template IDs are unique', () => {
    const ids = BUILT_IN_TEMPLATES.map(t => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// ─── Custom Templates ──────────────────────────────────────────────────────────

describe('Custom Templates', () => {
  it('creates a custom template from a completed meeting', () => {
    let m = createMeetingObject({
      spaceId: 'space-1',
      template: getTemplate('touch-base'),
    });
    m = startMeeting(m);
    m = completeMeeting(m);

    const custom = createCustomTemplate({
      meeting: m,
      name: 'Weekly 1:1',
      description: 'My weekly check-in',
      scope: 'space',
    });

    expect(custom.id).toContain('custom_');
    expect(custom.name).toBe('Weekly 1:1');
    expect(custom.source).toBe('user');
    expect(custom.scope).toBe('space');
    expect(custom.createdFrom).toBe('touch-base');
    expect(custom.useCount).toBe(0);
  });

  it('round-trips through Space item conversion', () => {
    const custom = createCustomTemplate({
      meeting: createMeetingObject({ spaceId: 'space-1' }),
      name: 'Custom A',
    });
    const item = customTemplateToSpaceItem(custom, 'space-1');
    expect(item.tags).toContain('wiser-template');
    expect(item.metadata.templateId).toBe(custom.id);

    const parsed = customTemplateFromSpaceItem(item);
    expect(parsed.name).toBe('Custom A');
  });

  it('mergeTemplates combines built-in + custom without duplicates', () => {
    const custom = [
      { id: 'custom-a', name: 'A', category: 'live', source: 'user' },
      { id: 'touch-base', name: 'My Touch Base', category: 'live', source: 'user' },
    ];
    const merged = mergeTemplates(custom);
    const touchBases = merged.filter(t => t.id === 'touch-base');
    expect(touchBases).toHaveLength(1);
    expect(touchBases[0].source).toBe('user');
    expect(merged.some(t => t.id === 'custom-a')).toBe(true);
  });
});
