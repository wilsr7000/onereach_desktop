import { describe, it, expect, vi, beforeEach } from 'vitest';
import { testConverterAgent } from '../../mocks/converter-test-harness.js';
import { createMockAIService } from '../../mocks/conversion-mocks.js';

// Mock pptxgenjs before importing agent
const mockSlide = {
  addText: vi.fn(),
  addShape: vi.fn(),
  addImage: vi.fn(),
};
vi.mock('pptxgenjs', () => ({
  default: vi.fn().mockImplementation(() => ({
    author: '',
    title: '',
    addSlide: vi.fn().mockReturnValue(mockSlide),
    write: vi.fn().mockResolvedValue(Buffer.from([0x50, 0x4B, 0x03, 0x04, ...Array(96).fill(0)])),
  })),
}));

// Mock internal dependencies used by base-converter-agent
vi.mock('../../../lib/ai-service', () => ({ default: null }));
vi.mock('../../../lib/log-event-queue', () => ({
  getLogQueue: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const mockAI = createMockAIService();

// Import the agent class (CJS)
const { ContentToPptxAgent } = require('../../../lib/converters/content-to-pptx.js');

// Run the standard lifecycle test harness
testConverterAgent(ContentToPptxAgent, {
  sampleInput: 'Slide 1\n---\nSlide 2',
  expectedFromFormats: ['text', 'md'],
  expectedToFormats: ['pptx'],
  expectedStrategies: ['auto-slides', 'structured', 'visual'],
  mockAI,
});

// Agent-specific tests
describe('ContentToPptxAgent (specific)', () => {
  let agent;

  beforeEach(() => {
    vi.clearAllMocks();
    agent = new ContentToPptxAgent({ ai: mockAI, silent: true });
  });

  it('splits content into sections by headings', () => {
    const sections = agent._splitIntoSections('# Topic A\nContent A\n# Topic B\nContent B');
    expect(sections.length).toBeGreaterThanOrEqual(2);
    expect(sections[0].title).toBe('Topic A');
  });

  it('structured strategy calls AI for slide breakdown', async () => {
    await agent.execute('Some text for slides', 'structured');
    expect(mockAI.json).toHaveBeenCalledWith(
      expect.stringContaining('Break the following content into slides'),
      expect.objectContaining({ profile: 'fast' }),
    );
  });

  it('metadata includes pptx mime type', async () => {
    const result = await agent.execute('# Test Slide\nBullet 1', 'auto-slides');
    expect(result.metadata.mimeType).toBe('application/vnd.openxmlformats-officedocument.presentationml.presentation');
    expect(result.metadata.extension).toBe('pptx');
  });
});
