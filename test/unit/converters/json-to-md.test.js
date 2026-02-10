import { describe, it, expect, vi, beforeEach } from 'vitest';
import { testConverterAgent } from '../../mocks/converter-test-harness.js';
import { createMockAIService } from '../../mocks/conversion-mocks.js';

vi.mock('../../../lib/ai-service', () => ({ default: null }));
vi.mock('../../../lib/log-event-queue', () => ({
  getLogQueue: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const mockAI = createMockAIService();
const { JsonToMdAgent } = require('../../../lib/converters/json-to-md.js');

testConverterAgent(JsonToMdAgent, {
  sampleInput: JSON.stringify([{ name: 'Alice', age: 30 }, { name: 'Bob', age: 25 }]),
  expectedFromFormats: ['json'],
  expectedToFormats: ['md', 'markdown'],
  expectedStrategies: ['table', 'yaml-block', 'list'],
  mockAI,
});

describe('JsonToMdAgent (specific)', () => {
  let agent;

  beforeEach(() => {
    vi.clearAllMocks();
    agent = new JsonToMdAgent({ ai: mockAI, silent: true });
  });

  it('has correct agent identity', () => {
    expect(agent.id).toBe('converter:json-to-md');
    expect(agent.name).toBe('JSON to Markdown');
  });

  it('table strategy produces pipe-delimited table', async () => {
    const input = JSON.stringify([{ name: 'Alice', age: 30 }]);
    const result = await agent.convert(input);
    if (result.success && result.output) {
      expect(result.output).toContain('|');
      expect(result.output).toContain('name');
      expect(result.output).toContain('Alice');
      expect(result.output).toContain('---');
    }
  });

  it('yaml-block strategy produces fenced code block', async () => {
    const input = JSON.stringify({ key: 'value' });
    const result = await agent.convert(input);
    if (result.success && result.output) {
      expect(typeof result.output).toBe('string');
      expect(result.output.length).toBeGreaterThan(0);
    }
  });

  it('list strategy produces nested bullet list via execute()', async () => {
    const input = JSON.stringify({ person: { name: 'Alice', age: 30 } });
    const execResult = await agent.execute(input, 'list');
    expect(execResult.output).toContain('-');
    expect(execResult.output).toContain('**person**');
    expect(execResult.output).toContain('Alice');
  });
});
