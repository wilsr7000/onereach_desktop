import { describe, it, expect, vi } from 'vitest';

vi.mock('../../lib/ai-service', () => ({ default: null }));
vi.mock('../../lib/log-event-queue', () => ({
  getLogQueue: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const {
  validatePlaybook,
  validateStructural,
  validateGraphReadiness,
} = require('../../lib/converters/playbook-validator');

/**
 * Create a fully valid playbook object for testing.
 */
function createValidPlaybook() {
  return {
    title: 'Test Playbook',
    content: 'This is the main content of the playbook with sufficient detail for validation.',
    keywords: ['test', 'example', 'playbook'],
    status: 'draft',
    stage: 'creation',
    framework: {
      who: {
        primary: 'Content creators',
        characteristics: ['tech-savvy', 'creative'],
        context: 'Digital marketing environment',
      },
      why: {
        coreValue: 'Efficiency in content creation',
        emotionalHook: 'Reduce creative friction',
        practicalBenefit: 'Save 50% of content creation time',
      },
      what: {
        primaryAction: 'Create structured content',
        secondaryActions: ['Review', 'Publish'],
        successLooksLike: 'Consistent, high-quality output',
      },
      where: {
        platform: 'Web application',
        format: 'Digital document',
      },
    },
  };
}

describe('validateStructural', () => {
  it('passes a valid playbook', () => {
    const result = validateStructural(createValidPlaybook());
    expect(result.pass).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('fails when playbook is null', () => {
    const result = validateStructural(null);
    expect(result.pass).toBe(false);
    expect(result.errors[0].code).toBe('NOT_OBJECT');
  });

  it('fails when playbook is not an object', () => {
    const result = validateStructural('not an object');
    expect(result.pass).toBe(false);
    expect(result.errors[0].code).toBe('NOT_OBJECT');
  });

  it('fails when title is missing', () => {
    const pb = createValidPlaybook();
    delete pb.title;
    const result = validateStructural(pb);
    expect(result.pass).toBe(false);
    expect(result.errors.some((e) => e.field === 'title' && e.code === 'MISSING_FIELD')).toBe(true);
  });

  it('fails when title is null', () => {
    const pb = createValidPlaybook();
    pb.title = null;
    const result = validateStructural(pb);
    expect(result.pass).toBe(false);
    expect(result.errors.some((e) => e.field === 'title' && e.code === 'MISSING_FIELD')).toBe(true);
  });

  it('fails when content is empty', () => {
    const pb = createValidPlaybook();
    pb.content = '   ';
    const result = validateStructural(pb);
    expect(result.pass).toBe(false);
    expect(result.errors.some((e) => e.field === 'content' && e.code === 'EMPTY_FIELD')).toBe(true);
  });

  it('fails when content is missing', () => {
    const pb = createValidPlaybook();
    delete pb.content;
    const result = validateStructural(pb);
    expect(result.pass).toBe(false);
    expect(result.errors.some((e) => e.field === 'content' && e.code === 'MISSING_FIELD')).toBe(true);
  });

  it('fails when framework is missing', () => {
    const pb = createValidPlaybook();
    delete pb.framework;
    const result = validateStructural(pb);
    expect(result.pass).toBe(false);
    expect(result.errors.some((e) => e.field === 'framework' && e.code === 'MISSING_FIELD')).toBe(true);
  });

  it('fails when keywords is wrong type', () => {
    const pb = createValidPlaybook();
    pb.keywords = 'not-an-array';
    const result = validateStructural(pb);
    expect(result.pass).toBe(false);
    expect(result.errors.some((e) => e.field === 'keywords' && e.code === 'WRONG_TYPE')).toBe(true);
  });

  it('fails when framework is an array instead of object', () => {
    const pb = createValidPlaybook();
    pb.framework = ['not', 'an', 'object'];
    const result = validateStructural(pb);
    expect(result.pass).toBe(false);
    expect(result.errors.some((e) => e.field === 'framework' && e.code === 'WRONG_TYPE')).toBe(true);
  });

  it('detects missing framework pillar fields', () => {
    const pb = createValidPlaybook();
    delete pb.framework.who.primary;
    const result = validateStructural(pb);
    expect(result.pass).toBe(false);
    expect(result.errors.some((e) => e.field === 'framework.who.primary' && e.code === 'MISSING_FIELD')).toBe(true);
  });

  it('detects empty framework pillar string', () => {
    const pb = createValidPlaybook();
    pb.framework.why.coreValue = '   ';
    const result = validateStructural(pb);
    expect(result.pass).toBe(false);
    expect(result.errors.some((e) => e.field === 'framework.why.coreValue' && e.code === 'EMPTY_FIELD')).toBe(true);
  });

  it('detects wrong type on framework pillar array field', () => {
    const pb = createValidPlaybook();
    pb.framework.who.characteristics = 'not-an-array';
    const result = validateStructural(pb);
    expect(result.pass).toBe(false);
    expect(result.errors.some((e) => e.field === 'framework.who.characteristics' && e.code === 'WRONG_TYPE')).toBe(
      true
    );
  });

  it('collects multiple errors', () => {
    const pb = createValidPlaybook();
    delete pb.title;
    delete pb.content;
    const result = validateStructural(pb);
    expect(result.pass).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(2);
    expect(result.errors.some((e) => e.field === 'title')).toBe(true);
    expect(result.errors.some((e) => e.field === 'content')).toBe(true);
  });
});

describe('validateGraphReadiness', () => {
  it('passes a complete playbook with all graph fields', () => {
    const result = validateGraphReadiness(createValidPlaybook());
    expect(result.pass).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('fails when playbook is not an object', () => {
    const result = validateGraphReadiness(null);
    expect(result.pass).toBe(false);
    expect(result.errors[0].code).toBe('NOT_OBJECT');
  });

  it('fails when status is missing', () => {
    const pb = createValidPlaybook();
    delete pb.status;
    const result = validateGraphReadiness(pb);
    expect(result.pass).toBe(false);
    expect(result.errors.some((e) => e.field === 'status' && e.code === 'MISSING_GRAPH_FIELD')).toBe(true);
  });

  it('fails when stage is missing', () => {
    const pb = createValidPlaybook();
    delete pb.stage;
    const result = validateGraphReadiness(pb);
    expect(result.pass).toBe(false);
    expect(result.errors.some((e) => e.field === 'stage' && e.code === 'MISSING_GRAPH_FIELD')).toBe(true);
  });

  it('fails when keywords array is empty', () => {
    const pb = createValidPlaybook();
    pb.keywords = [];
    const result = validateGraphReadiness(pb);
    expect(result.pass).toBe(false);
    expect(result.errors.some((e) => e.code === 'EMPTY_KEYWORDS')).toBe(true);
  });

  it('fails when framework is missing', () => {
    const pb = createValidPlaybook();
    delete pb.framework;
    const result = validateGraphReadiness(pb);
    expect(result.pass).toBe(false);
    expect(result.errors.some((e) => e.code === 'MISSING_FRAMEWORK')).toBe(true);
  });

  it('collects multiple graph readiness errors', () => {
    const pb = createValidPlaybook();
    delete pb.status;
    delete pb.stage;
    pb.keywords = [];
    const result = validateGraphReadiness(pb);
    expect(result.pass).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(3);
  });
});

describe('validatePlaybook', () => {
  it('returns valid result for a complete playbook (skipLLM)', async () => {
    const result = await validatePlaybook(createValidPlaybook(), { skipLLM: true });
    expect(result.valid).toBe(true);
    expect(result.score).toBeGreaterThan(0);
    expect(result.layers).toBeDefined();
    expect(result.layers.structural.pass).toBe(true);
    expect(result.layers.graphReadiness.pass).toBe(true);
  });

  it('returns invalid result for empty playbook', async () => {
    const result = await validatePlaybook({}, { skipLLM: true });
    expect(result.valid).toBe(false);
    expect(result.layers.structural.pass).toBe(false);
  });

  it('includes all four validation layers', async () => {
    const result = await validatePlaybook(createValidPlaybook(), { skipLLM: true });
    expect(result.layers.structural).toBeDefined();
    expect(result.layers.frameworkQuality).toBeDefined();
    expect(result.layers.contentQuality).toBeDefined();
    expect(result.layers.graphReadiness).toBeDefined();
  });

  it('returns a numeric score', async () => {
    const result = await validatePlaybook(createValidPlaybook(), { skipLLM: true });
    expect(typeof result.score).toBe('number');
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
  });

  it('gives lower score for structurally invalid playbook', async () => {
    const validResult = await validatePlaybook(createValidPlaybook(), { skipLLM: true });
    const invalidResult = await validatePlaybook({ title: 'Only Title' }, { skipLLM: true });
    expect(invalidResult.score).toBeLessThan(validResult.score);
  });

  it('uses default score for framework/content quality when LLM skipped', async () => {
    const result = await validatePlaybook(createValidPlaybook(), { skipLLM: true });
    // When LLM is skipped and structural passes, default scores of 70 are used
    expect(result.layers.frameworkQuality.score).toBe(70);
    expect(result.layers.contentQuality.score).toBe(70);
  });
});
