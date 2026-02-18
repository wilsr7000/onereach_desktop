/**
 * Unit tests for built-in agents
 */

import { describe, it, expect } from 'vitest';

// Mock time-agent behavior
const timeAgent = {
  id: 'time-agent',

  bid(task) {
    if (!task?.content) return null;
    const lower = task.content.toLowerCase();
    const timeKeywords = ['time', 'clock', 'hour', 'date', 'day', 'month', 'year'];
    if (timeKeywords.some((k) => lower.includes(k))) {
      return { confidence: 0.95 };
    }
    return null;
  },

  async execute(task) {
    const now = new Date();
    const lower = task.content.toLowerCase();

    if (lower.includes('date') || lower.includes('today')) {
      return { success: true, message: `It's ${now.toLocaleDateString()}` };
    }

    return { success: true, message: `It's ${now.toLocaleTimeString()}` };
  },
};

// Mock weather-agent behavior
const weatherAgent = {
  id: 'weather-agent',

  bid(task) {
    if (!task?.content) return null;
    const lower = task.content.toLowerCase();
    if (['weather', 'temperature'].some((k) => lower.includes(k))) {
      return { confidence: 0.9 };
    }
    return null;
  },

  extractLocation(text) {
    const match = text.match(/weather\s+(?:in|for|at)\s+(.+?)(?:\?|$)/i);
    return match ? match[1].trim() : null;
  },

  async execute(task, context = {}) {
    const location = this.extractLocation(task.content) || context?.location;

    if (!location) {
      return {
        success: false,
        needsInput: {
          prompt: 'What city would you like the weather for?',
          field: 'location',
          agentId: 'weather-agent',
          taskId: task.id,
        },
      };
    }

    return { success: true, message: `It's 72 degrees in ${location}` };
  },
};

// Mock help-agent behavior
const helpAgent = {
  id: 'help-agent',

  bid(task) {
    if (!task?.content) return null;
    const lower = task.content.toLowerCase();
    if (lower.includes('help') || lower.includes('what can you do')) {
      return { confidence: 0.95 };
    }
    return null;
  },

  async execute() {
    return {
      success: true,
      message: 'I can help with time, weather, music, and more.',
    };
  },
};

describe('time-agent', () => {
  describe('bid', () => {
    it('should bid on time questions', () => {
      const bid = timeAgent.bid({ content: 'what time is it' });
      expect(bid).toEqual({ confidence: 0.95 });
    });

    it('should bid on date questions', () => {
      const bid = timeAgent.bid({ content: 'what is the date' });
      expect(bid).toEqual({ confidence: 0.95 });
    });

    it('should not bid on unrelated questions', () => {
      const bid = timeAgent.bid({ content: 'play some music' });
      expect(bid).toBeNull();
    });
  });

  describe('execute', () => {
    it('should return time for time questions', async () => {
      const result = await timeAgent.execute({ content: 'what time is it' });

      expect(result.success).toBe(true);
      expect(result.message).toMatch(/It's/);
    });

    it('should return date for date questions', async () => {
      const result = await timeAgent.execute({ content: 'what is the date today' });

      expect(result.success).toBe(true);
      expect(result.message).toMatch(/It's/);
    });
  });
});

describe('weather-agent', () => {
  describe('bid', () => {
    it('should bid on weather questions', () => {
      const bid = weatherAgent.bid({ content: 'what is the weather' });
      expect(bid).toEqual({ confidence: 0.9 });
    });

    it('should not bid on unrelated questions', () => {
      const bid = weatherAgent.bid({ content: 'what time is it' });
      expect(bid).toBeNull();
    });
  });

  describe('extractLocation', () => {
    it('should extract location from "weather in Denver"', () => {
      const location = weatherAgent.extractLocation('weather in Denver');
      expect(location).toBe('Denver');
    });

    it('should extract location from "weather for New York"', () => {
      const location = weatherAgent.extractLocation('weather for New York');
      expect(location).toBe('New York');
    });

    it('should return null when no location specified', () => {
      const location = weatherAgent.extractLocation('what is the weather');
      expect(location).toBeNull();
    });
  });

  describe('execute', () => {
    it('should return needsInput when location is missing', async () => {
      const result = await weatherAgent.execute({
        id: 't1',
        content: 'what is the weather',
      });

      expect(result.success).toBe(false);
      expect(result.needsInput).toBeDefined();
      expect(result.needsInput.field).toBe('location');
      expect(result.needsInput.prompt).toContain('city');
    });

    it('should return weather when location is in content', async () => {
      const result = await weatherAgent.execute({
        id: 't1',
        content: 'weather in Denver',
      });

      expect(result.success).toBe(true);
      expect(result.message).toContain('Denver');
    });

    it('should return weather when location is in context', async () => {
      const result = await weatherAgent.execute({ id: 't1', content: 'what is the weather' }, { location: 'Seattle' });

      expect(result.success).toBe(true);
      expect(result.message).toContain('Seattle');
    });
  });
});

describe('help-agent', () => {
  describe('bid', () => {
    it('should bid on help requests', () => {
      const bid = helpAgent.bid({ content: 'help' });
      expect(bid).toEqual({ confidence: 0.95 });
    });

    it('should bid on capability questions', () => {
      const bid = helpAgent.bid({ content: 'what can you do' });
      expect(bid).toEqual({ confidence: 0.95 });
    });
  });

  describe('execute', () => {
    it('should return capabilities', async () => {
      const result = await helpAgent.execute({ content: 'help' });

      expect(result.success).toBe(true);
      expect(result.message).toContain('help');
    });
  });
});
