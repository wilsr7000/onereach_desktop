import { describe, it, expect, vi, beforeEach } from 'vitest';
import { testConverterAgent } from '../../mocks/converter-test-harness.js';
import { createMockAIService, createMockSharp } from '../../mocks/conversion-mocks.js';

// Mock sharp before importing agent
const mockSharp = createMockSharp();
vi.mock('sharp', () => ({ default: mockSharp }));

// Mock internal dependencies used by base-converter-agent
vi.mock('../../../lib/ai-service', () => ({ default: null }));
vi.mock('../../../lib/log-event-queue', () => ({
  getLogQueue: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const mockAI = createMockAIService();

// Import the agent class (CJS)
const { ImageFormatAgent } = require('../../../lib/converters/image-format.js');

// Run the standard lifecycle test harness
testConverterAgent(ImageFormatAgent, {
  sampleInput: Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
  expectedFromFormats: ['png', 'jpg', 'webp'],
  expectedToFormats: ['png', 'jpg', 'webp'],
  expectedStrategies: ['direct', 'optimized'],
  mockAI,
});

// Agent-specific tests
describe('ImageFormatAgent (specific)', () => {
  let agent;

  beforeEach(() => {
    vi.clearAllMocks();
    agent = new ImageFormatAgent({ ai: mockAI, silent: true });
  });

  it('rejects non-Buffer input in execute', async () => {
    await expect(agent.execute('not-a-buffer', 'direct', { targetFormat: 'webp' }))
      .rejects.toThrow('Input must be a Buffer');
  });

  it('rejects empty buffer in execute', async () => {
    await expect(agent.execute(Buffer.alloc(0), 'direct', { targetFormat: 'png' }))
      .rejects.toThrow('Input buffer is empty');
  });

  it('normalises jpeg to jpg', () => {
    expect(agent._normaliseFormat('JPEG')).toBe('jpg');
    expect(agent._normaliseFormat('png')).toBe('png');
  });
});
