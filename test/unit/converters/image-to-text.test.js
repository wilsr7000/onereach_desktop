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
const { ImageToTextAgent } = require('../../../lib/converters/image-to-text.js');

// Run the standard lifecycle test harness
testConverterAgent(ImageToTextAgent, {
  sampleInput: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  expectedFromFormats: ['png', 'jpg', 'webp'],
  expectedToFormats: ['text'],
  expectedStrategies: ['describe', 'ocr', 'detailed'],
  mockAI,
});

// Agent-specific tests
describe('ImageToTextAgent (specific)', () => {
  let agent;

  beforeEach(() => {
    vi.clearAllMocks();
    agent = new ImageToTextAgent({ ai: mockAI, silent: true });
  });

  it('rejects empty buffer in execute', async () => {
    await expect(agent.execute(Buffer.alloc(0), 'describe')).rejects.toThrow('Input image buffer is empty');
  });

  it('returns appropriate max tokens per strategy', () => {
    expect(agent._maxTokensForStrategy('describe')).toBe(300);
    expect(agent._maxTokensForStrategy('ocr')).toBe(2000);
    expect(agent._maxTokensForStrategy('detailed')).toBe(2000);
  });

  it('calls ai.vision with correct profile for ocr strategy', async () => {
    const input = Buffer.from('test-image-data');
    await agent.execute(input, 'ocr');
    expect(mockAI.vision).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('Extract all visible text'),
      expect.objectContaining({ profile: 'vision', temperature: 0 })
    );
  });
});
