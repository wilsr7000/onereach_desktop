import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { createRequire } from 'module';
import { testConverterAgent } from '../../mocks/converter-test-harness.js';
import { createMockAIService } from '../../mocks/conversion-mocks.js';

const require2 = createRequire(import.meta.url);

// Inject mammoth mock into Node require cache so CJS require() inside agents picks it up
const mammothMock = {
  extractRawText: vi.fn().mockResolvedValue({ value: 'Extracted text from document' }),
  convertToHtml: vi.fn().mockResolvedValue({ value: '<h1>Title</h1><p>Document content here</p>' }),
};
beforeAll(() => {
  const mammothPath = require2.resolve('mammoth');
  require2.cache[mammothPath] = { id: mammothPath, filename: mammothPath, loaded: true, exports: mammothMock };
});

// Mock internal dependencies used by base-converter-agent
vi.mock('../../../lib/ai-service', () => ({ default: null }));
vi.mock('../../../lib/log-event-queue', () => ({
  getLogQueue: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const mockAI = createMockAIService();

// Import the agent class (CJS)
const { DocxToTextAgent } = require('../../../lib/converters/docx-to-text.js');

// Run the standard lifecycle test harness
testConverterAgent(DocxToTextAgent, {
  sampleInput: Buffer.from([0x50, 0x4b, 0x03, 0x04, ...Array(96).fill(0)]),
  expectedFromFormats: ['docx'],
  expectedToFormats: ['text'],
  expectedStrategies: ['mammoth', 'preserving', 'tables-as-csv'],
  mockAI,
});

// Agent-specific tests
describe('DocxToTextAgent (specific)', () => {
  let agent;

  beforeEach(() => {
    vi.clearAllMocks();
    // Re-setup mammoth mock return values after clearAllMocks
    mammothMock.extractRawText.mockResolvedValue({ value: 'Extracted text from document' });
    mammothMock.convertToHtml.mockResolvedValue({ value: '<h1>Title</h1><p>Document content here</p>' });
    agent = new DocxToTextAgent({ ai: mockAI, silent: true });
  });

  it('mammoth strategy returns plain text string', async () => {
    const result = await agent.execute(Buffer.from('mock-docx'), 'mammoth');
    expect(typeof result.output).toBe('string');
    expect(result.output).toBe('Extracted text from document');
    expect(result.metadata.mimeType).toBe('text/plain');
  });

  it('preserving strategy converts HTML headings to text markers', async () => {
    const result = await agent.execute(Buffer.from('mock-docx'), 'preserving');
    expect(typeof result.output).toBe('string');
    expect(result.output.length).toBeGreaterThan(0);
  });

  it('stripTags removes HTML tags', () => {
    expect(agent._stripTags('<p>Hello <b>world</b></p>')).toBe('Hello world');
  });
});
