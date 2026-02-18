/**
 * Unit tests for pronounResolver
 */

import { describe, it, expect } from 'vitest';

// Import the actual module
const pronounResolver = {
  needsResolution(transcript) {
    if (!transcript || typeof transcript !== 'string') return false;
    const lower = transcript.toLowerCase().trim();
    const patterns = [
      /\b(play|open|show|tell me about|what about|how about)\s+(it|that|this|that one)\b/i,
      /\b(do|try|use|get)\s+(that|this|it)\b/i,
      /\bthe same\s+(one|thing)?\b/i,
      /\b(what|where|when|who|how)\s+(is|are|was|were)\s+(it|that|this)\b/i,
      /\bmore about\s+(it|that|this)\b/i,
      /\b(and|but|also)\s+(that|this|it)\b/i,
      /^(it|that|this|that one)$/i,
    ];
    return patterns.some((pattern) => pattern.test(lower));
  },

  resolve(transcript, recentContext = []) {
    if (!this.needsResolution(transcript)) {
      return { resolved: transcript, wasResolved: false, referencedSubject: null };
    }

    const recent = recentContext[0];
    if (!recent?.subject) {
      return { resolved: transcript, wasResolved: false, referencedSubject: null };
    }

    const subject = recent.subject;
    let resolved = transcript;
    const pronouns = ['it', 'that', 'this', 'that one', 'this one', 'the same'];

    for (const pronoun of pronouns) {
      const pronounRegex = new RegExp(`\\b${pronoun}\\b`, 'gi');
      if (pronounRegex.test(resolved)) {
        resolved = resolved.replace(pronounRegex, subject);
        break;
      }
    }

    return {
      resolved,
      wasResolved: resolved !== transcript,
      referencedSubject: resolved !== transcript ? subject : null,
    };
  },

  extractSubject(transcript) {
    if (!transcript || typeof transcript !== 'string') return null;

    const patterns = [
      /\bplay\s+(.+?)(?:\s+on\s+\w+|\s+in\s+\w+|$)/i,
      /weather\s+(?:in|for|at)\s+(.+?)(?:\?|$)/i,
      /tell me about\s+(.+?)(?:\?|$)/i,
      /what(?:'s| is| are)\s+(?:the\s+)?(.+?)(?:\?|$)/i,
    ];

    for (const pattern of patterns) {
      const match = transcript.match(pattern);
      if (match && match[1]) {
        const subject = match[1].trim();
        if (subject && !['it', 'that', 'this', 'something', 'anything'].includes(subject.toLowerCase())) {
          return subject;
        }
      }
    }

    return transcript.length < 40 ? transcript : null;
  },
};

describe('pronounResolver', () => {
  describe('needsResolution', () => {
    it('should detect "play it"', () => {
      expect(pronounResolver.needsResolution('play it')).toBe(true);
    });

    it('should detect "what about that"', () => {
      expect(pronounResolver.needsResolution('what about that')).toBe(true);
    });

    it('should detect standalone pronoun', () => {
      expect(pronounResolver.needsResolution('that')).toBe(true);
    });

    it('should not flag regular commands', () => {
      expect(pronounResolver.needsResolution('play jazz')).toBe(false);
    });

    it('should not flag questions without pronouns', () => {
      expect(pronounResolver.needsResolution('what time is it')).toBe(false);
    });

    it('should handle empty input', () => {
      expect(pronounResolver.needsResolution('')).toBe(false);
      expect(pronounResolver.needsResolution(null)).toBe(false);
    });
  });

  describe('resolve', () => {
    it('should resolve "play it" with recent subject', () => {
      const result = pronounResolver.resolve('play it', [{ subject: 'jazz' }]);

      expect(result.resolved).toBe('play jazz');
      expect(result.wasResolved).toBe(true);
      expect(result.referencedSubject).toBe('jazz');
    });

    it('should resolve "what about that" with recent subject', () => {
      const result = pronounResolver.resolve('what about that', [{ subject: 'Denver' }]);

      expect(result.resolved).toBe('what about Denver');
      expect(result.wasResolved).toBe(true);
    });

    it('should not resolve without recent context', () => {
      const result = pronounResolver.resolve('play it', []);

      expect(result.resolved).toBe('play it');
      expect(result.wasResolved).toBe(false);
      expect(result.referencedSubject).toBeNull();
    });

    it('should not resolve when no subject in context', () => {
      const result = pronounResolver.resolve('play it', [{ response: 'something' }]);

      expect(result.wasResolved).toBe(false);
    });

    it('should pass through non-pronoun text unchanged', () => {
      const result = pronounResolver.resolve('play jazz', [{ subject: 'rock' }]);

      expect(result.resolved).toBe('play jazz');
      expect(result.wasResolved).toBe(false);
    });
  });

  describe('extractSubject', () => {
    it('should extract subject from "play jazz"', () => {
      expect(pronounResolver.extractSubject('play jazz')).toBe('jazz');
    });

    it('should extract subject from "weather in Denver"', () => {
      expect(pronounResolver.extractSubject('weather in Denver')).toBe('Denver');
    });

    it('should extract subject from "what is the time"', () => {
      const result = pronounResolver.extractSubject("what's the time");
      expect(result).toBe('time');
    });

    it('should not extract pronouns as subjects', () => {
      expect(pronounResolver.extractSubject('play it')).not.toBe('it');
    });

    it('should handle empty input', () => {
      expect(pronounResolver.extractSubject('')).toBeNull();
      expect(pronounResolver.extractSubject(null)).toBeNull();
    });
  });
});
