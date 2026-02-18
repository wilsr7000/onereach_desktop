import { describe, it, expect, vi, beforeEach } from 'vitest';
import { testConverterAgent } from '../../mocks/converter-test-harness.js';
import { createMockAIService } from '../../mocks/conversion-mocks.js';

// Mock internal dependencies used by base-converter-agent
vi.mock('../../../lib/ai-service', () => ({ default: null }));
vi.mock('../../../lib/log-event-queue', () => ({
  getLogQueue: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const mockAI = createMockAIService({
  chatResponse:
    'This function named "hello" takes no arguments and returns the string "world". It is a simple pure function with no side effects.',
});

// Import the agent class (CJS)
const { CodeToExplanationAgent } = require('../../../lib/converters/code-to-explanation.js');

// Run the standard lifecycle test harness
testConverterAgent(CodeToExplanationAgent, {
  sampleInput: 'function hello() { return "world"; }',
  expectedFromFormats: ['code', 'js'],
  expectedToFormats: ['text', 'md'],
  expectedStrategies: ['overview', 'line-by-line', 'tutorial'],
  mockAI,
});

// Agent-specific tests
describe('CodeToExplanationAgent (specific)', () => {
  let agent;

  beforeEach(() => {
    vi.clearAllMocks();
    agent = new CodeToExplanationAgent({ ai: mockAI, silent: true });
  });

  it('overview strategy calls AI with high-level prompt', async () => {
    await agent.execute('function hello() { return "world"; }', 'overview');
    expect(mockAI.chat).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([expect.objectContaining({ role: 'user' })]),
      })
    );
  });

  it('line-by-line strategy produces detailed explanation', async () => {
    const result = await agent.execute('const x = 1;\nconst y = 2;\nconst z = x + y;', 'line-by-line');
    expect(typeof result.output).toBe('string');
    expect(result.output.length).toBeGreaterThan(0);
  });

  it('uses generative mode', () => {
    expect(agent.modes).toContain('generative');
  });
});
