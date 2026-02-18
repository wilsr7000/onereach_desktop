import { describe, it, expect, vi, beforeEach } from 'vitest';
import { testConverterAgent } from '../../mocks/converter-test-harness.js';
import { createMockAIService } from '../../mocks/conversion-mocks.js';

// Mock internal dependencies used by base-converter-agent
vi.mock('../../../lib/ai-service', () => ({ default: null }));
vi.mock('../../../lib/log-event-queue', () => ({
  getLogQueue: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const mockImageBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array(2000).fill(0)]);

const mockAI = createMockAIService({
  imageResponse: mockImageBuffer,
});

// Override imageGenerate to return proper structure
mockAI.imageGenerate = vi.fn().mockResolvedValue({
  images: [{ b64_json: mockImageBuffer.toString('base64') }],
});

// Import the agent class (CJS)
const { TextToImageConverter } = require('../../../lib/converters/text-to-image.js');

// Run the standard lifecycle test harness
testConverterAgent(TextToImageConverter, {
  sampleInput: 'A sunset over mountains',
  expectedFromFormats: ['text'],
  expectedToFormats: ['png', 'jpg', 'webp'],
  expectedStrategies: ['literal', 'artistic', 'diagram'],
  mockAI,
});

// Agent-specific tests
describe('TextToImageConverter (specific)', () => {
  let agent;

  beforeEach(() => {
    vi.clearAllMocks();
    mockAI.imageGenerate = vi.fn().mockResolvedValue({
      images: [{ b64_json: mockImageBuffer.toString('base64') }],
    });
    agent = new TextToImageConverter({ ai: mockAI, silent: true });
  });

  it('has correct agent identity', () => {
    expect(agent.id).toBe('converter:text-to-image');
    expect(agent.name).toContain('Image');
  });

  it('uses generative mode', () => {
    expect(agent.modes).toContain('generative');
  });

  it('defines distinct strategies for different generation styles', () => {
    const ids = agent.strategies.map((s) => s.id);
    expect(ids).toContain('literal');
    expect(ids).toContain('artistic');
    expect(ids).toContain('diagram');
  });
});
