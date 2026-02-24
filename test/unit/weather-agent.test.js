/**
 * Weather Agent - Unit Tests
 *
 * Tests the weather agent's core logic:
 * - Location extraction from natural language
 * - Weather data fetching (mocked)
 * - Calendar-aware weather
 * - Memory management
 * - Fallback handling
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../lib/agent-memory-store', () => ({
  getAgentMemory: vi.fn(() => ({
    load: vi.fn(),
    save: vi.fn(),
    isDirty: vi.fn(() => false),
    getSectionNames: vi.fn(() => ['Learned Preferences', 'Favorite Locations']),
    getSection: vi.fn(() => ''),
    updateSection: vi.fn(),
    parseSectionAsKeyValue: vi.fn(() => ({
      'Home Location': '*Not set - will ask*',
      Units: 'Fahrenheit',
    })),
  })),
}));

vi.mock('../../lib/user-profile-store', () => ({
  getUserProfile: vi.fn(() => ({
    isLoaded: vi.fn(() => true),
    load: vi.fn(),
    getFacts: vi.fn(() => ({})),
    updateFact: vi.fn(),
    save: vi.fn(),
  })),
}));

vi.mock('../../lib/thinking-agent', () => ({
  learnFromInteraction: vi.fn(),
  reviewExecution: vi.fn(() => ({
    message: 'Location not found',
  })),
}));

vi.mock('../../lib/ai-service', () => ({
  json: vi.fn(() => ({})),
  complete: vi.fn(() => ''),
}));

vi.mock('../../lib/log-event-queue', () => ({
  getLogQueue: vi.fn(() => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  })),
}));

const weatherAgent = require('../../packages/agents/weather-agent');

describe('Weather Agent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    weatherAgent.memory = null;
  });

  describe('Agent Definition', () => {
    it('should have correct id and name', () => {
      expect(weatherAgent.id).toBe('weather-agent');
      expect(weatherAgent.name).toBe('Weather Agent');
    });

    it('should have weather-related categories and keywords', () => {
      expect(weatherAgent.categories).toContain('weather');
      expect(weatherAgent.keywords).toContain('weather');
      expect(weatherAgent.keywords).toContain('temperature');
      expect(weatherAgent.keywords).toContain('forecast');
    });

    it('should always report as available (no API key required)', () => {
      expect(weatherAgent.isAvailable()).toBe(true);
    });

    it('should have a prompt for LLM bidding', () => {
      expect(weatherAgent.prompt).toBeTruthy();
      expect(weatherAgent.prompt).toContain('HIGH CONFIDENCE');
      expect(weatherAgent.prompt).toContain('LOW CONFIDENCE');
    });

    it('should NOT have a bid() method (uses LLM routing)', () => {
      expect(weatherAgent.bid).toBeUndefined();
    });

    it('should have a getBriefing() method', () => {
      expect(typeof weatherAgent.getBriefing).toBe('function');
    });
  });

  describe('extractLocation()', () => {
    it('should extract city from "weather in NYC"', () => {
      expect(weatherAgent.extractLocation('weather in NYC')).toBe('NYC');
    });

    it('should extract city from "what is the weather in San Francisco?"', () => {
      expect(weatherAgent.extractLocation("what's the weather in San Francisco?")).toBe('San Francisco');
    });

    it('should extract city from "temperature in London"', () => {
      expect(weatherAgent.extractLocation('temperature in London')).toBe('London');
    });

    it('should extract city from "how is weather like in Tokyo?"', () => {
      expect(weatherAgent.extractLocation("how's the weather like in Tokyo?")).toBe('Tokyo');
    });

    it('should return null for bare "what is the weather"', () => {
      expect(weatherAgent.extractLocation('what is the weather')).toBeNull();
    });

    it('should return null for null/undefined input', () => {
      expect(weatherAgent.extractLocation(null)).toBeNull();
      expect(weatherAgent.extractLocation(undefined)).toBeNull();
    });

    it('should reject "today" and "tomorrow" as locations', () => {
      expect(weatherAgent.extractLocation('weather in today')).toBeNull();
    });

    it('should extract from "is it raining in Seattle?"', () => {
      expect(weatherAgent.extractLocation('is it raining in Seattle?')).toBe('Seattle');
    });
  });

  describe('execute() - pending location', () => {
    it('should re-prompt if empty location in awaiting_location state', async () => {
      const result = await weatherAgent.execute(
        {
          content: '',
          context: { pendingState: 'awaiting_location', userInput: '' },
          metadata: {},
        },
        {}
      );

      expect(result.success).toBe(true);
      expect(result.needsInput).toBeTruthy();
      expect(result.needsInput.prompt).toContain('city');
    });
  });

  describe('Briefing interface', () => {
    it('should have getBriefing() that returns section Weather with priority 2', async () => {
      const briefing = await weatherAgent.getBriefing();
      expect(briefing.section).toBe('Weather');
      expect(briefing.priority).toBe(2);
      expect(briefing.content).toBeTruthy();
    });
  });
});
