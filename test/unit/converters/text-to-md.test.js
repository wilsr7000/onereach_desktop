import { describe, it, expect, vi, beforeEach } from 'vitest';
import { testConverterAgent } from '../../mocks/converter-test-harness.js';
import { createMockAIService } from '../../mocks/conversion-mocks.js';

// Mock internal dependencies
vi.mock('../../../lib/ai-service', () => ({ default: null }));
vi.mock('../../../lib/log-event-queue', () => ({
  getLogQueue: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const mockAI = createMockAIService({
  chatResponse: '# Meeting Notes\n\nWe discussed the **quarterly budget** and *upcoming deadlines*.\n\n- Budget approved\n- Timeline confirmed',
});

// Import the agent class (CJS)
const { TextToMdAgent } = require('../../../lib/converters/text-to-md.js');

const sampleText = 'Meeting notes from today. We discussed the quarterly budget and upcoming deadlines. Budget approved. Timeline confirmed.';

// Run the standard lifecycle test harness
testConverterAgent(TextToMdAgent, {
  sampleInput: sampleText,
  expectedFromFormats: ['text'],
  expectedToFormats: ['md', 'markdown'],
  expectedStrategies: ['minimal', 'structure', 'rich'],
  mockAI,
});

// Agent-specific tests
describe('TextToMdAgent (specific)', () => {
  let agent;

  beforeEach(() => {
    vi.clearAllMocks();
    agent = new TextToMdAgent({ ai: mockAI, silent: true });
  });

  it('minimal strategy splits text into paragraphs without AI', async () => {
    const input = 'First paragraph.\n\nSecond paragraph.';
    const result = await agent.execute(input, 'minimal');
    expect(result.output).toBe('First paragraph.\n\nSecond paragraph.');
    expect(result.metadata.usedAi).toBe(false);
    expect(mockAI.chat).not.toHaveBeenCalled();
  });

  it('structure strategy calls AI with fast profile', async () => {
    await agent.execute(sampleText, 'structure');
    expect(mockAI.chat).toHaveBeenCalledWith(
      expect.objectContaining({ profile: 'fast', feature: 'converter-text-to-md' }),
    );
    expect(mockAI.chat.mock.calls[0][0].messages[0].content).toBe(sampleText);
  });

  it('rich strategy calls AI with standard profile', async () => {
    await agent.execute(sampleText, 'rich');
    expect(mockAI.chat).toHaveBeenCalledWith(
      expect.objectContaining({ profile: 'standard', feature: 'converter-text-to-md' }),
    );
  });
});
