/**
 * DJ Agent - Unit Tests
 *
 * Tests the DJ agent's core logic:
 * - Pattern cache matching (common control commands)
 * - Mood detection
 * - Time-based recommendations
 * - Agent definition and metadata
 * - Control action routing
 * - Multi-turn conversation state
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../lib/agent-memory-store', () => ({
  getAgentMemory: vi.fn(() => ({
    load: vi.fn(),
    save: vi.fn(),
    isDirty: vi.fn(() => false),
    getSectionNames: vi.fn(() => [
      'Time-Based Preferences',
      'Speaker Preferences',
      'Favorite Artists',
      'Custom AppleScripts',
    ]),
    getSection: vi.fn(() => ''),
    updateSection: vi.fn(),
    appendToSection: vi.fn(),
    parseSectionAsKeyValue: vi.fn(() => ({})),
    isLoaded: vi.fn(() => true),
  })),
}));

vi.mock('../../lib/thinking-agent', () => ({
  getTimeContext: vi.fn(() => ({
    partOfDay: 'afternoon',
    timestamp: new Date().toISOString(),
  })),
  learnFromInteraction: vi.fn(),
}));

vi.mock('./media-agent', () => ({
  listAirPlayDevices: vi.fn(() => []),
  setAirPlayDevice: vi.fn(),
}));

vi.mock('./circuit-breaker', () => ({
  getCircuit: vi.fn(() => ({
    execute: vi.fn((fn) => fn()),
  })),
}));

vi.mock('../../lib/ai-service', () => ({
  chat: vi.fn(() => ({
    content: JSON.stringify({
      understood: true,
      action: 'play',
      searchTerms: ['chill vibes'],
      message: 'Playing chill vibes',
    }),
  })),
}));

vi.mock('../../lib/log-event-queue', () => ({
  getLogQueue: vi.fn(() => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  })),
}));

vi.mock('./applescript-helper', () => ({
  getFullMusicStatus: vi.fn(() => ({
    running: true,
    state: 'playing',
    track: 'Test Song',
    artist: 'Test Artist',
    volume: 50,
  })),
  runScript: vi.fn(() => ({ output: '50' })),
  smartPlayGenre: vi.fn(() => ({ success: true, source: 'library' })),
  smartPlayWithSearchTerms: vi.fn(() => ({ success: true })),
  createMoodPlaylist: vi.fn(() => ({ success: true, trackCount: 20 })),
  getRecentlyPlayed: vi.fn(() => []),
  getTopGenres: vi.fn(() => []),
  getPodcastStatus: vi.fn(() => ({ running: false, playing: false, subscriptions: [] })),
  playPodcast: vi.fn(() => ({ success: true })),
  searchAndPlayPodcast: vi.fn(() => ({ success: true })),
  controlPodcast: vi.fn(() => ({ success: true })),
}));

const djAgent = require('../../packages/agents/dj-agent');

describe('DJ Agent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    djAgent.memory = null;
  });

  describe('Agent Definition', () => {
    it('should have correct id and name', () => {
      expect(djAgent.id).toBe('dj-agent');
      expect(djAgent.name).toBe('Personal DJ');
    });

    it('should have media-related categories', () => {
      expect(djAgent.categories).toContain('media');
      expect(djAgent.categories).toContain('music');
    });

    it('should have a prompt for LLM bidding', () => {
      expect(djAgent.prompt).toBeTruthy();
      expect(djAgent.prompt).toContain('HIGH CONFIDENCE');
      expect(djAgent.prompt).toContain('LOW CONFIDENCE');
    });

    it('should NOT have a bid() method (uses LLM routing)', () => {
      expect(djAgent.bid).toBeUndefined();
    });

    it('should have capabilities list', () => {
      expect(djAgent.capabilities).toBeTruthy();
      expect(djAgent.capabilities.length).toBeGreaterThan(5);
    });

    it('should have voice and acks configured', () => {
      expect(djAgent.voice).toBeTruthy();
      expect(djAgent.acks).toBeTruthy();
      expect(djAgent.acks.length).toBeGreaterThan(0);
    });
  });

  describe('Pattern Cache - _matchPattern()', () => {
    it('should match "pause" to pause tool', () => {
      const result = djAgent._matchPattern('pause');
      expect(result).toBeTruthy();
      expect(result.tool).toBe('pause');
    });

    it('should match "skip" to nextTrack', () => {
      const result = djAgent._matchPattern('skip');
      expect(result).toBeTruthy();
      expect(result.tool).toBe('nextTrack');
    });

    it('should match "next song" to nextTrack', () => {
      const result = djAgent._matchPattern('next song');
      expect(result).toBeTruthy();
      expect(result.tool).toBe('nextTrack');
    });

    it('should match "turn it up" to adjustVolume +15', () => {
      const result = djAgent._matchPattern('turn it up');
      expect(result).toBeTruthy();
      expect(result.tool).toBe('adjustVolume');
      expect(result.args.delta).toBe(15);
    });

    it('should match "turn it down a bit" to adjustVolume -10', () => {
      const result = djAgent._matchPattern('turn it down a bit');
      expect(result).toBeTruthy();
      expect(result.tool).toBe('adjustVolume');
      expect(result.args.delta).toBe(-10);
    });

    it('should match "mute" to setVolume 0', () => {
      const result = djAgent._matchPattern('mute');
      expect(result).toBeTruthy();
      expect(result.tool).toBe('setVolume');
      expect(result.args.level).toBe(0);
    });

    it('should match "max volume" to setVolume 100', () => {
      const result = djAgent._matchPattern('max volume');
      expect(result).toBeTruthy();
      expect(result.tool).toBe('setVolume');
      expect(result.args.level).toBe(100);
    });

    it('should match "volume to 50%" to setVolume 50', () => {
      const result = djAgent._matchPattern('volume to 50%');
      expect(result).toBeTruthy();
      expect(result.tool).toBe('setVolume');
      expect(result.args.level).toBe(50);
    });

    it('should match "shuffle" to toggleShuffle', () => {
      const result = djAgent._matchPattern('shuffle');
      expect(result).toBeTruthy();
      expect(result.tool).toBe('toggleShuffle');
    });

    it('should match "play jazz music" to play tool (keyword "play" in pattern cache)', () => {
      const result = djAgent._matchPattern('play jazz music');
      expect(result).toBeTruthy();
      expect(result.tool).toBe('play');
    });

    it('should return null for "something chill for working" (no pattern match)', () => {
      const result = djAgent._matchPattern('something chill for working');
      expect(result).toBeNull();
    });

    it('should clamp volume to valid range', () => {
      const result = djAgent._matchPattern('volume to 150%');
      expect(result.args.level).toBe(100);
    });
  });

  describe('Mood Detection - _detectMoodFromRequest()', () => {
    it('should detect "chill" as Relaxing', () => {
      expect(djAgent._detectMoodFromRequest('chill')).toBe('Relaxing');
    });

    it('should detect "jazz" as Jazz', () => {
      expect(djAgent._detectMoodFromRequest('jazz')).toBe('Jazz');
    });

    it('should detect "pump" as Energetic', () => {
      expect(djAgent._detectMoodFromRequest('pump me up')).toBe('Energetic');
    });

    it('should detect "focus" as Focused', () => {
      expect(djAgent._detectMoodFromRequest('focus music')).toBe('Focused');
    });

    it('should detect "lofi" as Focused', () => {
      expect(djAgent._detectMoodFromRequest('lofi beats')).toBe('Focused');
    });

    it('should return null for unrecognized mood', () => {
      expect(djAgent._detectMoodFromRequest('xyzzy')).toBeNull();
    });
  });

  describe('Time-Based Search Terms - _getTimeBasedSearchTerms()', () => {
    it('should return morning-appropriate terms', () => {
      const terms = djAgent._getTimeBasedSearchTerms('morning');
      expect(terms.length).toBeGreaterThan(0);
      expect(terms.some((t) => t.toLowerCase().includes('morning'))).toBe(true);
    });

    it('should return evening-appropriate terms', () => {
      const terms = djAgent._getTimeBasedSearchTerms('evening');
      expect(terms.length).toBeGreaterThan(0);
    });

    it('should fall back to afternoon for unknown time', () => {
      const terms = djAgent._getTimeBasedSearchTerms('unknown');
      const afternoonTerms = djAgent._getTimeBasedSearchTerms('afternoon');
      expect(terms).toEqual(afternoonTerms);
    });
  });

  describe('Option Generation - _generateOptions()', () => {
    it('should generate 3 options', () => {
      const options = djAgent._generateOptions('relaxing', ['Jazz', 'Chill', 'Acoustic'], ['Computer'], {});
      expect(options.length).toBe(3);
    });

    it('should use first speaker for all options when only one speaker', () => {
      const options = djAgent._generateOptions('relaxing', ['Jazz', 'Chill'], ['Computer'], {});
      options.forEach((opt) => {
        expect(opt.speaker).toBe('Computer');
      });
    });

    it('should use second speaker for second option when available', () => {
      const options = djAgent._generateOptions('relaxing', ['Jazz', 'Chill'], ['Computer', 'HomePod'], {});
      expect(options[1].speaker).toBe('HomePod');
    });
  });

  describe('History Parsing - _parseHistory()', () => {
    it('should parse valid history entries', () => {
      const history = '- 2026-01-27 afternoon | energetic | Pop on Living Room | Liked';
      const entries = djAgent._parseHistory(history);
      expect(entries.length).toBe(1);
      expect(entries[0].partOfDay).toBe('afternoon');
      expect(entries[0].mood).toBe('energetic');
      expect(entries[0].genre).toBe('Pop');
      expect(entries[0].speaker).toBe('Living Room');
      expect(entries[0].status).toBe('liked');
    });

    it('should handle empty history', () => {
      expect(djAgent._parseHistory('')).toEqual([]);
      expect(djAgent._parseHistory('*No history yet*')).toEqual([]);
      expect(djAgent._parseHistory(null)).toEqual([]);
    });

    it('should parse multiple entries', () => {
      const history = `- 2026-01-27 morning | focused | Jazz on Computer | Liked
- 2026-01-27 evening | relaxing | Chill on HomePod | Liked`;
      const entries = djAgent._parseHistory(history);
      expect(entries.length).toBe(2);
    });
  });

  describe('Pattern Analysis - _analyzePatterns()', () => {
    it('should count genres and group by time', () => {
      const entries = [
        { date: '2026-01-27', partOfDay: 'morning', mood: 'focused', genre: 'Jazz', speaker: 'Computer', status: 'liked' },
        { date: '2026-01-28', partOfDay: 'morning', mood: 'focused', genre: 'Jazz', speaker: 'Computer', status: 'liked' },
        { date: '2026-01-29', partOfDay: 'morning', mood: 'focused', genre: 'Classical', speaker: 'Computer', status: 'liked' },
      ];
      const patterns = djAgent._analyzePatterns(entries);
      expect(patterns.genreCounts['Jazz']).toBe(2);
      expect(patterns.genreCounts['Classical']).toBe(1);
      expect(patterns.byTime['morning'].count).toBe(3);
    });

    it('should track speaker preferences', () => {
      const entries = [
        { date: '2026-01-27', partOfDay: 'evening', mood: 'relaxing', genre: 'Jazz', speaker: 'HomePod', status: 'liked' },
        { date: '2026-01-28', partOfDay: 'evening', mood: 'relaxing', genre: 'Soul', speaker: 'HomePod', status: 'liked' },
      ];
      const patterns = djAgent._analyzePatterns(entries);
      expect(patterns.bySpeaker['HomePod']).toBeTruthy();
      expect(patterns.bySpeaker['HomePod'].count).toBe(2);
    });

    it('should only count liked entries', () => {
      const entries = [
        { date: '2026-01-27', partOfDay: 'morning', mood: 'focused', genre: 'Jazz', speaker: 'Computer', status: 'liked' },
        { date: '2026-01-28', partOfDay: 'morning', mood: 'focused', genre: 'Pop', speaker: 'Computer', status: 'skipped' },
      ];
      const patterns = djAgent._analyzePatterns(entries);
      expect(patterns.genreCounts['Jazz']).toBe(1);
      expect(patterns.genreCounts['Pop']).toBeUndefined();
    });
  });

  describe('Task Similarity - _tasksAreSimilar()', () => {
    it('should detect similar tasks', () => {
      expect(djAgent._tasksAreSimilar('rate current track 5 stars', 'rate this track 5 stars')).toBe(true);
    });

    it('should detect dissimilar tasks', () => {
      expect(djAgent._tasksAreSimilar('play jazz music', 'rate track 5 stars')).toBe(false);
    });
  });

  describe('Simple Response - _simpleResponse()', () => {
    it('should format volume response', () => {
      const response = djAgent._simpleResponse({ newVolume: 75 }, 'adjustVolume');
      expect(response).toContain('75%');
    });

    it('should format track response', () => {
      const response = djAgent._simpleResponse({ track: 'Bohemian Rhapsody', artist: 'Queen' }, 'nextTrack');
      expect(response).toContain('Bohemian Rhapsody');
      expect(response).toContain('Queen');
    });

    it('should format state response', () => {
      expect(djAgent._simpleResponse({ state: 'playing' }, 'play')).toBe('Playing');
      expect(djAgent._simpleResponse({ state: 'paused' }, 'pause')).toBe('Paused');
    });

    it('should format shuffle response', () => {
      expect(djAgent._simpleResponse({ shuffleEnabled: true }, 'toggleShuffle')).toBe('Shuffle on');
      expect(djAgent._simpleResponse({ shuffleEnabled: false }, 'toggleShuffle')).toBe('Shuffle off');
    });
  });

  describe('Enhance Response - _enhanceResponse()', () => {
    it('should append volume when not in LLM response', () => {
      const result = djAgent._enhanceResponse('Turning it up', { newVolume: 75 });
      expect(result).toContain('75%');
    });

    it('should not duplicate volume when already in response', () => {
      const result = djAgent._enhanceResponse('Volume at 75%', { newVolume: 75 });
      expect(result).toBe('Volume at 75%');
    });

    it('should append track when not mentioned', () => {
      const result = djAgent._enhanceResponse('Skipping', { track: 'Test Song' });
      expect(result).toContain('Test Song');
    });
  });

  describe('Custom Script Tracking', () => {
    it('should parse empty custom scripts section', () => {
      expect(djAgent._parseCustomScriptEntries('*No custom scripts tracked yet*')).toEqual([]);
      expect(djAgent._parseCustomScriptEntries('')).toEqual([]);
    });

    it('should parse JSON custom scripts', () => {
      const json = JSON.stringify([
        { task: 'rate track', successCount: 3, failureCount: 0 },
      ]);
      const entries = djAgent._parseCustomScriptEntries(json);
      expect(entries.length).toBe(1);
      expect(entries[0].task).toBe('rate track');
    });
  });

  describe('Promotion Candidates', () => {
    it('should return empty when no memory', () => {
      djAgent.memory = null;
      expect(djAgent.getPromotionCandidates()).toEqual([]);
    });
  });
});
