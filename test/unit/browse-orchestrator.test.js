import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('BrowseOrchestrator', () => {
  let orchestrator;

  beforeEach(async () => {
    vi.clearAllMocks();
    orchestrator = await import('../../lib/browse-orchestrator.js');
  });

  describe('resolveStepVariables()', () => {
    it('should replace ${varName} with context values', () => {
      const step = { name: 'test', url: 'https://example.com/${page}' };
      const context = { page: 'about' };
      const result = orchestrator.resolveStepVariables(step, context, []);
      expect(result.url).toBe('https://example.com/about');
    });

    it('should replace ${varName.prop} with nested context values', () => {
      const step = { name: 'test', query: 'weather in ${location.city}' };
      const context = { location: { city: 'Austin', state: 'TX' } };
      const result = orchestrator.resolveStepVariables(step, context, []);
      expect(result.query).toBe('weather in Austin');
    });

    it('should replace ${prev} with previous step data', () => {
      const step = { name: 'test', prompt: 'Summarize: ${prev}' };
      const context = {};
      const prevResults = [{ data: 'Previous step result text' }];
      const result = orchestrator.resolveStepVariables(step, context, prevResults);
      expect(result.prompt).toContain('Previous step result text');
    });

    it('should replace ${prev.field} with specific previous result fields', () => {
      const step = { name: 'test', url: '${prev.url}' };
      const context = {};
      const prevResults = [{ url: 'https://found.com', text: 'content' }];
      const result = orchestrator.resolveStepVariables(step, context, prevResults);
      expect(result.url).toBe('https://found.com');
    });

    it('should handle missing variables gracefully', () => {
      const step = { name: 'test', url: 'https://example.com/${missing}' };
      const result = orchestrator.resolveStepVariables(step, {}, []);
      expect(result.url).toBe('https://example.com/');
    });

    it('should not modify non-string properties', () => {
      const step = { name: 'test', maxActions: 10, deepExtract: true };
      const result = orchestrator.resolveStepVariables(step, {}, []);
      expect(result.maxActions).toBe(10);
      expect(result.deepExtract).toBe(true);
    });
  });
});
