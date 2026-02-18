/**
 * Unit tests for meeting link extraction and join_meeting handler
 *
 * Tests extractMeetingLink and identifyProvider from the calendar format layer.
 */
import { describe, it, expect } from 'vitest';
import { extractMeetingLink, identifyProvider, findMeetingUrl } from '../../lib/calendar-format.js';

// ==================== TESTS ====================

describe('Meeting Link Extraction', () => {
  // ---- identifyProvider ----
  describe('identifyProvider', () => {
    it('should identify Zoom', () => {
      expect(identifyProvider('https://us02web.zoom.us/j/123456')).toBe('Zoom');
    });
    it('should identify Google Meet', () => {
      expect(identifyProvider('https://meet.google.com/abc-defg-hij')).toBe('Google Meet');
    });
    it('should identify Microsoft Teams', () => {
      expect(identifyProvider('https://teams.microsoft.com/l/meetup-join/abc')).toBe('Microsoft Teams');
    });
    it('should identify Webex', () => {
      expect(identifyProvider('https://acme.webex.com/meet/room123')).toBe('Webex');
    });
    it('should identify GoToMeeting', () => {
      expect(identifyProvider('https://www.gotomeeting.com/join/123456')).toBe('GoToMeeting');
    });
    it('should identify Amazon Chime', () => {
      expect(identifyProvider('https://chime.aws/1234567')).toBe('Amazon Chime');
    });
    it('should identify BlueJeans', () => {
      expect(identifyProvider('https://bluejeans.com/123456')).toBe('BlueJeans');
    });
    it('should return Video Call for unknown URLs', () => {
      expect(identifyProvider('https://some-other-service.com/meeting')).toBe('Video Call');
    });
    it('should return Video Call for null', () => {
      expect(identifyProvider(null)).toBe('Video Call');
    });
  });

  // ---- findMeetingUrl ----
  describe('findMeetingUrl', () => {
    it('should find Zoom link in text', () => {
      const text = 'Join us at https://us02web.zoom.us/j/83849294 for the standup';
      expect(findMeetingUrl(text)).toBe('https://us02web.zoom.us/j/83849294');
    });
    it('should find Google Meet link in text', () => {
      const text = 'Click https://meet.google.com/abc-defg-hij to join';
      expect(findMeetingUrl(text)).toBe('https://meet.google.com/abc-defg-hij');
    });
    it('should find Teams link in text', () => {
      const text = 'Join: https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc123';
      expect(findMeetingUrl(text)).toBe('https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc123');
    });
    it('should find Webex link in text', () => {
      const text = 'Meeting: https://acme.webex.com/acme/j.php?MTID=12345';
      expect(findMeetingUrl(text)).toBe('https://acme.webex.com/acme/j.php?MTID=12345');
    });
    it('should strip trailing HTML/quote characters', () => {
      const text = '<a href="https://us02web.zoom.us/j/123456">';
      expect(findMeetingUrl(text)).toBe('https://us02web.zoom.us/j/123456');
    });
    it('should return null for text with no meeting links', () => {
      expect(findMeetingUrl('No meeting here, just a regular day.')).toBeNull();
    });
    it('should return null for null input', () => {
      expect(findMeetingUrl(null)).toBeNull();
    });
    it('should return null for empty string', () => {
      expect(findMeetingUrl('')).toBeNull();
    });
    it('should find link among other URLs', () => {
      const text =
        'Docs: https://docs.google.com/doc/abc\nMeeting: https://meet.google.com/xyz-abc-123\nSlides: https://slides.google.com/s/1';
      expect(findMeetingUrl(text)).toBe('https://meet.google.com/xyz-abc-123');
    });
  });

  // ---- extractMeetingLink ----
  describe('extractMeetingLink', () => {
    it('should return null for null event', () => {
      const result = extractMeetingLink(null);
      expect(result.url).toBeNull();
    });

    it('should return null for event with no link data', () => {
      const event = { summary: 'Standup', start: { dateTime: '2026-02-12T09:00:00' } };
      const result = extractMeetingLink(event);
      expect(result.url).toBeNull();
    });

    it('should extract hangoutLink (Google Meet)', () => {
      const event = {
        summary: 'Team Sync',
        hangoutLink: 'https://meet.google.com/abc-defg-hij',
      };
      const result = extractMeetingLink(event);
      expect(result.url).toBe('https://meet.google.com/abc-defg-hij');
      expect(result.provider).toBe('Google Meet');
      expect(result.label).toBe('Join Google Meet');
    });

    it('should extract conferenceData entry point (Zoom)', () => {
      const event = {
        summary: 'Design Review',
        conferenceData: {
          entryPoints: [
            { entryPointType: 'phone', uri: 'tel:+1-555-123-4567' },
            { entryPointType: 'video', uri: 'https://us02web.zoom.us/j/83849294?pwd=abc123' },
          ],
        },
      };
      const result = extractMeetingLink(event);
      expect(result.url).toBe('https://us02web.zoom.us/j/83849294?pwd=abc123');
      expect(result.provider).toBe('Zoom');
    });

    it('should extract link from location field', () => {
      const event = {
        summary: 'All Hands',
        location: 'https://us04web.zoom.us/j/77777777',
      };
      const result = extractMeetingLink(event);
      expect(result.url).toBe('https://us04web.zoom.us/j/77777777');
      expect(result.provider).toBe('Zoom');
    });

    it('should extract link from description field', () => {
      const event = {
        summary: '1:1 with Sarah',
        description: 'Weekly check-in. Join at https://meet.google.com/xyz-uvw-123',
      };
      const result = extractMeetingLink(event);
      expect(result.url).toBe('https://meet.google.com/xyz-uvw-123');
      expect(result.provider).toBe('Google Meet');
    });

    it('should prefer hangoutLink over conferenceData', () => {
      const event = {
        summary: 'Dual Link Event',
        hangoutLink: 'https://meet.google.com/preferred',
        conferenceData: {
          entryPoints: [{ entryPointType: 'video', uri: 'https://us02web.zoom.us/j/fallback' }],
        },
      };
      const result = extractMeetingLink(event);
      expect(result.url).toBe('https://meet.google.com/preferred');
      expect(result.provider).toBe('Google Meet');
    });

    it('should prefer conferenceData over location', () => {
      const event = {
        summary: 'Priority Test',
        conferenceData: {
          entryPoints: [{ entryPointType: 'video', uri: 'https://us02web.zoom.us/j/99999' }],
        },
        location: 'https://meet.google.com/location-link',
      };
      const result = extractMeetingLink(event);
      expect(result.url).toBe('https://us02web.zoom.us/j/99999');
      expect(result.provider).toBe('Zoom');
    });

    it('should prefer location over description', () => {
      const event = {
        summary: 'Loc vs Desc',
        location: 'https://us04web.zoom.us/j/11111',
        description: 'Join: https://meet.google.com/desc-link',
      };
      const result = extractMeetingLink(event);
      expect(result.url).toBe('https://us04web.zoom.us/j/11111');
      expect(result.provider).toBe('Zoom');
    });

    it('should not match non-meeting URLs in location', () => {
      const event = {
        summary: 'Lunch',
        location: 'https://maps.google.com/place/restaurant',
      };
      const result = extractMeetingLink(event);
      expect(result.url).toBeNull();
    });

    it('should handle Teams link in description', () => {
      const event = {
        summary: 'Sprint Planning',
        description:
          'Click here to join: https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc123%40thread.tacv2/0?context=xyz',
      };
      const result = extractMeetingLink(event);
      expect(result.url).toContain('teams.microsoft.com');
      expect(result.provider).toBe('Microsoft Teams');
    });
  });

  // ---- handleJoinMeeting logic ----
  describe('handleJoinMeeting logic', () => {
    function buildEvents() {
      const now = new Date();
      return [
        {
          id: 'past-1',
          summary: 'Past Meeting',
          start: { dateTime: new Date(now.getTime() - 7200000).toISOString() },
          end: { dateTime: new Date(now.getTime() - 3600000).toISOString() },
          hangoutLink: 'https://meet.google.com/past-link',
        },
        {
          id: 'current-1',
          summary: 'Active Standup',
          start: { dateTime: new Date(now.getTime() - 600000).toISOString() },
          end: { dateTime: new Date(now.getTime() + 600000).toISOString() },
          hangoutLink: 'https://meet.google.com/active-standup',
        },
        {
          id: 'next-1',
          summary: 'Design Review',
          start: { dateTime: new Date(now.getTime() + 1800000).toISOString() },
          end: { dateTime: new Date(now.getTime() + 5400000).toISOString() },
          location: 'https://us04web.zoom.us/j/design-review',
        },
        {
          id: 'next-2',
          summary: 'Sprint Planning',
          start: { dateTime: new Date(now.getTime() + 7200000).toISOString() },
          end: { dateTime: new Date(now.getTime() + 10800000).toISOString() },
          // No meeting link
        },
      ];
    }

    // Simulate the selection logic from _handleJoinMeeting
    function findMeeting(events, searchText) {
      const now = new Date();
      let target = null;

      if (searchText) {
        const search = searchText.toLowerCase();
        target = events.find((e) => {
          const title = (e.summary || '').toLowerCase();
          return title.includes(search) || search.includes(title);
        });
      }

      if (!target) {
        // Current meeting
        target = events.find((e) => {
          if (!e.start?.dateTime) return false;
          const start = new Date(e.start.dateTime);
          const end = new Date(e.end?.dateTime || start.getTime() + 3600000);
          return start <= now && end > now;
        });
      }

      if (!target) {
        // Next upcoming
        const upcoming = events
          .filter((e) => e.start?.dateTime && new Date(e.start.dateTime) > now)
          .sort((a, b) => new Date(a.start.dateTime) - new Date(b.start.dateTime));
        target = upcoming[0] || null;
      }

      return target;
    }

    it('should find the current meeting when one is active', () => {
      const events = buildEvents();
      const target = findMeeting(events, null);
      expect(target.id).toBe('current-1');
    });

    it('should find a specific meeting by name', () => {
      const events = buildEvents();
      const target = findMeeting(events, 'design review');
      expect(target.id).toBe('next-1');
    });

    it('should extract link from the found meeting', () => {
      const events = buildEvents();
      const target = findMeeting(events, null);
      const link = extractMeetingLink(target);
      expect(link.url).toBe('https://meet.google.com/active-standup');
      expect(link.provider).toBe('Google Meet');
    });

    it('should return null link for meeting without video', () => {
      const events = buildEvents();
      const target = findMeeting(events, 'sprint planning');
      const link = extractMeetingLink(target);
      expect(link.url).toBeNull();
    });

    it('should fall through to next meeting when no current meeting', () => {
      const now = new Date();
      const events = [
        {
          id: 'future-1',
          summary: 'Next Call',
          start: { dateTime: new Date(now.getTime() + 300000).toISOString() },
          end: { dateTime: new Date(now.getTime() + 3900000).toISOString() },
          hangoutLink: 'https://meet.google.com/next-call',
        },
      ];
      const target = findMeeting(events, null);
      expect(target.id).toBe('future-1');
      const link = extractMeetingLink(target);
      expect(link.url).toBe('https://meet.google.com/next-call');
    });

    it('should return null when no events at all', () => {
      const target = findMeeting([], null);
      expect(target).toBeNull();
    });
  });
});
