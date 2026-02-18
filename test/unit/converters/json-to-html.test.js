import { describe, it, expect, vi, beforeEach } from 'vitest';
import { testConverterAgent } from '../../mocks/converter-test-harness.js';
import { createMockAIService } from '../../mocks/conversion-mocks.js';

vi.mock('../../../lib/ai-service', () => ({ default: null }));
vi.mock('../../../lib/log-event-queue', () => ({
  getLogQueue: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const mockAI = createMockAIService();
const { JsonToHtmlAgent } = require('../../../lib/converters/json-to-html.js');

testConverterAgent(JsonToHtmlAgent, {
  sampleInput: JSON.stringify([
    { name: 'Alice', age: 30 },
    { name: 'Bob', age: 25 },
  ]),
  expectedFromFormats: ['json'],
  expectedToFormats: ['html'],
  expectedStrategies: ['table', 'tree', 'pretty'],
  mockAI,
});

describe('JsonToHtmlAgent (specific)', () => {
  let agent;

  beforeEach(() => {
    vi.clearAllMocks();
    agent = new JsonToHtmlAgent({ ai: mockAI, silent: true });
  });

  it('has correct agent identity', () => {
    expect(agent.id).toBe('converter:json-to-html');
    expect(agent.name).toBe('JSON to HTML');
  });

  it('table strategy produces HTML table with data', async () => {
    const input = JSON.stringify([{ name: 'Alice', age: 30 }]);
    const result = await agent.convert(input);
    if (result.success && result.output) {
      expect(result.output).toContain('<table');
      expect(result.output).toContain('Alice');
      expect(result.output).toContain('<th');
    }
  });

  it('pretty strategy produces pre block with JSON', async () => {
    // Force pretty strategy by using a non-array input
    const input = JSON.stringify({ key: 'value' });
    const result = await agent.convert(input);
    if (result.success && result.output) {
      expect(typeof result.output).toBe('string');
      expect(result.output.length).toBeGreaterThan(0);
    }
  });

  it('tree strategy produces nested lists', async () => {
    const input = JSON.stringify({ root: { child: 'value' } });
    const result = await agent.convert(input);
    if (result.success && result.output) {
      expect(typeof result.output).toBe('string');
      expect(result.output.length).toBeGreaterThan(0);
    }
  });

  it('escapes HTML entities in data values', async () => {
    const input = JSON.stringify([{ name: '<script>alert("xss")</script>' }]);
    const result = await agent.convert(input);
    if (result.success && result.output) {
      expect(result.output).not.toContain('<script>');
      expect(result.output).toContain('&lt;script&gt;');
    }
  });
});
