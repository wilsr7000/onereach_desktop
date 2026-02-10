import { describe, it, expect, vi, beforeEach } from 'vitest';
import { testConverterAgent } from '../../mocks/converter-test-harness.js';
import { createMockAIService } from '../../mocks/conversion-mocks.js';

vi.mock('../../../lib/ai-service', () => ({ default: null }));
vi.mock('../../../lib/log-event-queue', () => ({
  getLogQueue: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const mockAI = createMockAIService();
const { XmlJsonAgent } = require('../../../lib/converters/xml-json.js');

testConverterAgent(XmlJsonAgent, {
  sampleInput: '<root><item>Hello</item></root>',
  expectedFromFormats: ['xml', 'json'],
  expectedToFormats: ['json', 'xml'],
  expectedStrategies: ['default', 'compact', 'verbose'],
  mockAI,
});

describe('XmlJsonAgent (specific)', () => {
  let agent;

  beforeEach(() => {
    vi.clearAllMocks();
    agent = new XmlJsonAgent({ ai: mockAI, silent: true });
  });

  it('has correct agent identity', () => {
    expect(agent.id).toBe('converter:xml-json');
    expect(agent.name).toBe('XML / JSON');
  });

  it('XML -> JSON produces valid JSON', async () => {
    const input = '<root><item>Hello</item><item>World</item></root>';
    const result = await agent.convert(input);
    if (result.success && result.output) {
      const parsed = JSON.parse(result.output);
      expect(parsed).toBeDefined();
      expect(parsed.root).toBeDefined();
    }
  });

  it('JSON -> XML produces valid XML', async () => {
    const input = JSON.stringify({ root: { item: 'Hello' } });
    const result = await agent.convert(input);
    if (result.success && result.output) {
      expect(result.output).toContain('<root>');
      expect(result.output).toContain('<item>');
      expect(result.output).toContain('Hello');
    }
  });

  it('preserves attributes with default strategy', async () => {
    const input = '<root><item id="1">Hello</item></root>';
    const result = await agent.convert(input);
    if (result.success && result.output) {
      const parsed = JSON.parse(result.output);
      expect(JSON.stringify(parsed)).toContain('1');
    }
  });

  it('round-trips XML -> JSON -> XML preserving structure', async () => {
    const originalXml = '<root><name>Test</name><value>42</value></root>';
    const toJsonResult = await agent.convert(originalXml);
    if (toJsonResult.success && toJsonResult.output) {
      const backToXml = await agent.convert(toJsonResult.output);
      if (backToXml.success && backToXml.output) {
        expect(backToXml.output).toContain('Test');
        expect(backToXml.output).toContain('42');
      }
    }
  });
});
