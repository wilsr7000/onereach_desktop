import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { createRequire } from 'module';
import { testConverterAgent } from '../../mocks/converter-test-harness.js';
import { createMockAIService } from '../../mocks/conversion-mocks.js';

const require2 = createRequire(import.meta.url);

// Inject mammoth mock into Node require cache so CJS require() inside agents picks it up
const mammothMock = {
  extractRawText: vi.fn().mockResolvedValue({ value: 'Extracted text content' }),
  convertToHtml: vi.fn().mockResolvedValue({ value: '<h1>Title</h1><p>Document content here</p>' }),
};

// Turndown must be a constructor: code does `new TurndownService(opts)`
function MockTurndownService() {
  this.turndown = vi.fn().mockReturnValue('# Title\n\nDocument content here');
}

beforeAll(() => {
  const mammothPath = require2.resolve('mammoth');
  require2.cache[mammothPath] = { id: mammothPath, filename: mammothPath, loaded: true, exports: mammothMock };

  const turndownPath = require2.resolve('turndown');
  require2.cache[turndownPath] = { id: turndownPath, filename: turndownPath, loaded: true, exports: MockTurndownService };
});

// Mock internal dependencies used by base-converter-agent
vi.mock('../../../lib/ai-service', () => ({ default: null }));
vi.mock('../../../lib/log-event-queue', () => ({
  getLogQueue: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const mockAI = createMockAIService();

// Import the agent class (CJS)
const { DocxToMdAgent } = require('../../../lib/converters/docx-to-md.js');

// Run the standard lifecycle test harness
testConverterAgent(DocxToMdAgent, {
  sampleInput: Buffer.from([0x50, 0x4B, 0x03, 0x04, ...Array(96).fill(0)]),
  expectedFromFormats: ['docx'],
  expectedToFormats: ['md', 'markdown'],
  expectedStrategies: ['mammoth-md', 'direct', 'semantic'],
  mockAI,
});

// Agent-specific tests
describe('DocxToMdAgent (specific)', () => {
  let agent;

  beforeEach(() => {
    vi.clearAllMocks();
    // Re-setup mock return values after clearAllMocks
    mammothMock.extractRawText.mockResolvedValue({ value: 'Extracted text content' });
    mammothMock.convertToHtml.mockResolvedValue({ value: '<h1>Title</h1><p>Document content here</p>' });
    agent = new DocxToMdAgent({ ai: mockAI, silent: true });
  });

  it('mammoth-md strategy produces Markdown output', async () => {
    const result = await agent.execute(Buffer.from('mock-docx'), 'mammoth-md');
    expect(typeof result.output).toBe('string');
    expect(result.metadata.mimeType).toBe('text/markdown');
    expect(result.metadata.extension).toBe('md');
  });

  it('semantic strategy calls AI for post-processing', async () => {
    await agent.execute(Buffer.from('mock-docx'), 'semantic');
    expect(mockAI.complete).toHaveBeenCalledWith(
      expect.stringContaining('Clean up the following Markdown'),
      expect.objectContaining({ profile: 'fast' }),
    );
  });

  it('direct strategy extracts raw text and applies basic formatting', async () => {
    const result = await agent.execute(Buffer.from('mock-docx'), 'direct');
    expect(typeof result.output).toBe('string');
    expect(result.output.length).toBeGreaterThan(0);
  });
});
