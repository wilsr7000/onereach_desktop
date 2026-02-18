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
const { ImageResizeAgent } = require('../../../lib/converters/image-resize.js');

// Run the standard lifecycle test harness
testConverterAgent(ImageResizeAgent, {
  sampleInput: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  expectedFromFormats: ['png', 'jpg', 'webp'],
  expectedToFormats: ['png', 'jpg', 'webp'],
  expectedStrategies: ['exact', 'fit', 'smart-crop'],
  mockAI,
});

// Agent-specific tests
describe('ImageResizeAgent (specific)', () => {
  let agent;

  beforeEach(() => {
    vi.clearAllMocks();
    agent = new ImageResizeAgent({ ai: mockAI, silent: true });
  });

  it('rejects non-Buffer input in execute', async () => {
    await expect(agent.execute('not-a-buffer', 'fit', { width: 100 })).rejects.toThrow('Input must be a Buffer');
  });

  it('requires at least width or height', async () => {
    const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    await expect(agent.execute(buf, 'fit', {})).rejects.toThrow(
      'At least one of options.width or options.height is required'
    );
  });

  it('builds correct resize options for each strategy', () => {
    const exact = agent._buildResizeOptions('exact', 100, 100, {});
    expect(exact.fit).toBe('fill');
    expect(exact.withoutEnlargement).toBe(false);

    const fit = agent._buildResizeOptions('fit', 200, 200, {});
    expect(fit.fit).toBe('inside');
    expect(fit.withoutEnlargement).toBe(true);
  });
});
