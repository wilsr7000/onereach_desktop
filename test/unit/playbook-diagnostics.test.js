import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockAIService } from '../mocks/conversion-mocks.js';

vi.mock('../../lib/ai-service', () => ({ default: null }));
vi.mock('../../lib/log-event-queue', () => ({
  getLogQueue: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const { diagnosePlaybook } = require('../../lib/converters/playbook-diagnostics');

describe('diagnosePlaybook', () => {
  let mockAI;

  beforeEach(() => {
    mockAI = createMockAIService();
  });

  it('returns diagnosis object for structural failures', async () => {
    const playbook = {};
    const validationResult = {
      valid: false,
      score: 0,
      layers: {
        structural: {
          pass: false,
          errors: [
            { field: 'title', code: 'MISSING_FIELD', message: 'Required field "title" is missing' },
            { field: 'content', code: 'MISSING_FIELD', message: 'Required field "content" is missing' },
          ],
        },
        frameworkQuality: { pass: false, score: 0, pillarScores: {} },
        contentQuality: { pass: false, score: 0 },
        graphReadiness: {
          pass: false,
          errors: [{ field: 'title', code: 'MISSING_GRAPH_FIELD', message: 'Graph node field "title" is missing' }],
        },
      },
    };

    const result = await diagnosePlaybook(playbook, validationResult, 'some source content');
    expect(result.diagnosis).toBeDefined();
    expect(result.diagnosis.rootCause).toBeDefined();
    expect(typeof result.diagnosis.rootCause).toBe('string');
    expect(result.diagnosis.severity).toBe('critical');
    expect(result.diagnosis.fixes.length).toBeGreaterThan(0);
  });

  it('includes fix suggestions matching known error codes', async () => {
    const playbook = { title: 'Test' };
    const validationResult = {
      valid: false,
      score: 25,
      layers: {
        structural: {
          pass: false,
          errors: [
            { field: 'content', code: 'MISSING_FIELD', message: 'Required field "content" is missing' },
            { field: 'keywords', code: 'WRONG_TYPE', message: 'Field "keywords" should be an array' },
          ],
        },
        frameworkQuality: { pass: false, score: 0, pillarScores: {} },
        contentQuality: { pass: false, score: 0 },
        graphReadiness: { pass: false, errors: [] },
      },
    };

    const result = await diagnosePlaybook(playbook, validationResult);
    const fixes = result.diagnosis.fixes;
    expect(fixes.length).toBeGreaterThanOrEqual(2);
    // MISSING_FIELD -> action: 'regenerate'
    expect(fixes.some((f) => f.action === 'regenerate')).toBe(true);
    // WRONG_TYPE -> action: 'coerce-type'
    expect(fixes.some((f) => f.action === 'coerce-type')).toBe(true);
    // All fixes should have a confidence score
    expect(fixes.every((f) => typeof f.confidence === 'number' && f.confidence > 0)).toBe(true);
  });

  it('includes fix for EMPTY_KEYWORDS error code', async () => {
    const validationResult = {
      valid: false,
      score: 40,
      layers: {
        structural: { pass: true, errors: [] },
        frameworkQuality: { pass: true, score: 70, pillarScores: {} },
        contentQuality: { pass: true, score: 70 },
        graphReadiness: {
          pass: false,
          errors: [{ field: 'keywords', code: 'EMPTY_KEYWORDS', message: 'Keywords array is empty' }],
        },
      },
    };

    const result = await diagnosePlaybook({ keywords: [] }, validationResult);
    expect(result.diagnosis.fixes.some((f) => f.action === 'extract-keywords')).toBe(true);
  });

  it('includes fix for MISSING_FRAMEWORK error code', async () => {
    const validationResult = {
      valid: false,
      score: 30,
      layers: {
        structural: { pass: true, errors: [] },
        frameworkQuality: { pass: false, score: 0, pillarScores: {} },
        contentQuality: { pass: true, score: 70 },
        graphReadiness: {
          pass: false,
          errors: [{ field: 'framework', code: 'MISSING_FRAMEWORK', message: 'Framework is missing' }],
        },
      },
    };

    const result = await diagnosePlaybook({ title: 'Test' }, validationResult);
    expect(result.diagnosis.fixes.some((f) => f.action === 'regenerate-framework')).toBe(true);
  });

  it('works with mock AI for LLM-driven diagnosis', async () => {
    mockAI.json.mockResolvedValueOnce({
      rootCause: 'Source content too short for meaningful extraction',
      fixes: [
        {
          id: 'llm-fix-1',
          description: 'Expand source content',
          action: 'edit',
          automated: false,
          params: {},
          confidence: 0.6,
        },
      ],
      alternativePipeline: 'Use template strategy instead',
    });

    const playbook = { title: 'Test' };
    const validationResult = {
      valid: false,
      score: 30,
      layers: {
        structural: {
          pass: false,
          errors: [{ field: 'content', code: 'MISSING_FIELD', message: 'Required field "content" is missing' }],
        },
        frameworkQuality: { pass: false, score: 0, pillarScores: {} },
        contentQuality: { pass: false, score: 0 },
        graphReadiness: { pass: false, errors: [] },
      },
    };

    const result = await diagnosePlaybook(playbook, validationResult, 'short source', { ai: mockAI });
    expect(result.diagnosis.rootCause).toBe('Source content too short for meaningful extraction');
    expect(result.diagnosis.alternativePipeline).toBe('Use template strategy instead');
    // LLM fix should be merged alongside known fixes
    expect(result.diagnosis.fixes.some((f) => f.id === 'llm-fix-1')).toBe(true);
    // Known fix for MISSING_FIELD should also be present
    expect(result.diagnosis.fixes.some((f) => f.action === 'regenerate')).toBe(true);
  });

  it('determines critical severity for structural failures', async () => {
    const result = await diagnosePlaybook(
      {},
      {
        valid: false,
        score: 10,
        layers: {
          structural: { pass: false, errors: [{ field: 'title', code: 'MISSING_FIELD', message: 'Missing' }] },
          frameworkQuality: { pass: false, score: 0, pillarScores: {} },
          contentQuality: { pass: false, score: 0 },
          graphReadiness: { pass: false, errors: [] },
        },
      }
    );
    expect(result.diagnosis.severity).toBe('critical');
  });

  it('determines high severity for low score with structural pass', async () => {
    const result = await diagnosePlaybook(
      { title: 'T', content: 'C', keywords: [], framework: {} },
      {
        valid: false,
        score: 40,
        layers: {
          structural: { pass: true, errors: [] },
          frameworkQuality: { pass: false, score: 30, pillarScores: { who: 20, why: 30, what: 40, where: 30 } },
          contentQuality: { pass: false, score: 40 },
          graphReadiness: { pass: false, errors: [] },
        },
      }
    );
    expect(result.diagnosis.severity).toBe('high');
  });

  it('identifies affected framework pillars from errors', async () => {
    const validationResult = {
      valid: false,
      score: 40,
      layers: {
        structural: {
          pass: false,
          errors: [
            { field: 'framework.who.primary', code: 'MISSING_FIELD', message: 'Missing' },
            { field: 'framework.why.coreValue', code: 'EMPTY_FIELD', message: 'Empty' },
          ],
        },
        frameworkQuality: {
          pass: false,
          score: 30,
          pillarScores: { who: 20, why: 30, what: 80, where: 70 },
        },
        contentQuality: { pass: true, score: 70 },
        graphReadiness: { pass: true, errors: [] },
      },
    };

    const result = await diagnosePlaybook({ title: 'Test', framework: {} }, validationResult);
    expect(result.diagnosis.affectedPillars).toContain('who');
    expect(result.diagnosis.affectedPillars).toContain('why');
    // 'what' and 'where' scored above 50, should not be affected
    expect(result.diagnosis.affectedPillars).not.toContain('what');
    expect(result.diagnosis.affectedPillars).not.toContain('where');
  });

  it('suggests alternative pipeline for critical failures', async () => {
    const result = await diagnosePlaybook(
      {},
      {
        valid: false,
        score: 5,
        layers: {
          structural: { pass: false, errors: [{ field: 'playbook', code: 'NOT_OBJECT', message: 'Not object' }] },
          frameworkQuality: { pass: false, score: 0, pillarScores: {} },
          contentQuality: { pass: false, score: 0 },
          graphReadiness: { pass: false, errors: [] },
        },
      }
    );
    expect(result.diagnosis.alternativePipeline).toBeDefined();
    expect(typeof result.diagnosis.alternativePipeline).toBe('string');
    expect(result.diagnosis.alternativePipeline.length).toBeGreaterThan(0);
  });

  it('suggests alternative pipeline for high severity', async () => {
    const result = await diagnosePlaybook(
      {},
      {
        valid: false,
        score: 40,
        layers: {
          structural: { pass: true, errors: [] },
          frameworkQuality: { pass: false, score: 20, pillarScores: { who: 10, why: 20, what: 30, where: 20 } },
          contentQuality: { pass: false, score: 30 },
          graphReadiness: { pass: false, errors: [{ field: 'keywords', code: 'EMPTY_KEYWORDS', message: 'Empty' }] },
        },
      }
    );
    expect(result.diagnosis.alternativePipeline).toBeDefined();
  });

  it('returns null alternative pipeline for low-severity issues', async () => {
    const result = await diagnosePlaybook(
      {},
      {
        valid: false,
        score: 75,
        layers: {
          structural: { pass: true, errors: [] },
          frameworkQuality: { pass: true, score: 80, pillarScores: {} },
          contentQuality: { pass: true, score: 70 },
          graphReadiness: { pass: true, errors: [] },
        },
      }
    );
    expect(result.diagnosis.alternativePipeline).toBeNull();
  });

  it('sorts fixes by confidence descending', async () => {
    const validationResult = {
      valid: false,
      score: 20,
      layers: {
        structural: {
          pass: false,
          errors: [
            { field: 'content', code: 'MISSING_FIELD', message: 'Missing' },
            { field: 'keywords', code: 'WRONG_TYPE', message: 'Wrong type' },
          ],
        },
        frameworkQuality: { pass: false, score: 0, pillarScores: {} },
        contentQuality: { pass: false, score: 0 },
        graphReadiness: { pass: false, errors: [] },
      },
    };

    const result = await diagnosePlaybook({}, validationResult);
    const fixes = result.diagnosis.fixes;
    for (let i = 1; i < fixes.length; i++) {
      expect(fixes[i].confidence).toBeLessThanOrEqual(fixes[i - 1].confidence);
    }
  });

  it('handles no errors gracefully', async () => {
    const validationResult = {
      valid: true,
      score: 90,
      layers: {
        structural: { pass: true, errors: [] },
        frameworkQuality: { pass: true, score: 90, pillarScores: {} },
        contentQuality: { pass: true, score: 90 },
        graphReadiness: { pass: true, errors: [] },
      },
    };

    const result = await diagnosePlaybook({}, validationResult);
    expect(result.diagnosis).toBeDefined();
    expect(result.diagnosis.rootCause).toBe('No errors detected');
    expect(result.diagnosis.fixes).toEqual([]);
  });
});
