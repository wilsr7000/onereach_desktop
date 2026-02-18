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
const { ImageToPdfAgent } = require('../../../lib/converters/image-to-pdf.js');

// Run the standard lifecycle test harness
testConverterAgent(ImageToPdfAgent, {
  sampleInput: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  expectedFromFormats: ['png', 'jpg', 'webp'],
  expectedToFormats: ['pdf'],
  expectedStrategies: ['single-page', 'fitted'],
  mockAI,
});

// Agent-specific tests
describe('ImageToPdfAgent (specific)', () => {
  let agent;

  beforeEach(() => {
    vi.clearAllMocks();
    agent = new ImageToPdfAgent({ ai: mockAI, silent: true });
  });

  it('rejects non-Buffer input in execute', async () => {
    await expect(agent.execute('not-a-buffer', 'single-page')).rejects.toThrow('Input must be a Buffer');
  });

  it('rejects empty buffer in execute', async () => {
    await expect(agent.execute(Buffer.alloc(0), 'fitted')).rejects.toThrow('Input image buffer is empty');
  });

  it('defaults output format to png', () => {
    const opts = agent._formatOptions('png', {});
    expect(opts).toHaveProperty('compressionLevel', 6);
  });
});
