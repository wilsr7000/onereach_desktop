import { describe, it, expect, vi, beforeEach } from 'vitest';
import { testConverterAgent } from '../../mocks/converter-test-harness.js';
import { createMockAIService } from '../../mocks/conversion-mocks.js';

// Mock internal dependencies used by base-converter-agent
vi.mock('../../../lib/ai-service', () => ({ default: null }));
vi.mock('../../../lib/log-event-queue', () => ({
  getLogQueue: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const mockAI = createMockAIService();

// Import the agent class (CJS)
const { CodeToMdAgent } = require('../../../lib/converters/code-to-md.js');

// Run the standard lifecycle test harness
testConverterAgent(CodeToMdAgent, {
  sampleInput: 'function hello() { return "world"; }',
  expectedFromFormats: ['code', 'js'],
  expectedToFormats: ['md', 'markdown'],
  expectedStrategies: ['fenced', 'documented', 'sectioned'],
  mockAI,
});

// Agent-specific tests
describe('CodeToMdAgent (specific)', () => {
  let agent;

  beforeEach(() => {
    vi.clearAllMocks();
    agent = new CodeToMdAgent({ ai: mockAI, silent: true });
  });

  it('fenced strategy wraps code in a Markdown code fence', async () => {
    const result = await agent.execute('const x = 1;', 'fenced');
    expect(typeof result.output).toBe('string');
    expect(result.output).toContain('```');
    expect(result.metadata.strategy).toBe('fenced');
    expect(result.metadata.language).toBeDefined();
  });

  it('documented strategy calls AI for documentation', async () => {
    await agent.execute('function greet(name) { return `Hello ${name}`; }', 'documented');
    expect(mockAI.complete).toHaveBeenCalled();
  });

  it('detects JavaScript language from code patterns', () => {
    const lang = agent._detectLanguage('const x = require("fs"); module.exports = x;');
    expect(lang).toBe('javascript');
  });
});
