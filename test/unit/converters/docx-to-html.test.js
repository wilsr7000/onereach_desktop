import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { createRequire } from 'module';
import { testConverterAgent } from '../../mocks/converter-test-harness.js';
import { createMockAIService } from '../../mocks/conversion-mocks.js';

const require2 = createRequire(import.meta.url);

// Inject mammoth mock into Node require cache so CJS require() inside agents picks it up
const mammothMock = {
  extractRawText: vi.fn().mockResolvedValue({ value: 'Raw text from document' }),
  convertToHtml: vi.fn().mockResolvedValue({
    value: '<h1>Document Title</h1><p>Paragraph content with <strong>bold</strong> text.</p>',
  }),
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
const { DocxToHtmlAgent } = require('../../../lib/converters/docx-to-html.js');

// Run the standard lifecycle test harness
testConverterAgent(DocxToHtmlAgent, {
  sampleInput: Buffer.from([0x50, 0x4B, 0x03, 0x04, ...Array(96).fill(0)]),
  expectedFromFormats: ['docx'],
  expectedToFormats: ['html'],
  expectedStrategies: ['mammoth', 'styled', 'clean'],
  mockAI,
});

// Agent-specific tests
describe('DocxToHtmlAgent (specific)', () => {
  let agent;

  beforeEach(() => {
    vi.clearAllMocks();
    // Re-setup mock return values after clearAllMocks
    mammothMock.extractRawText.mockResolvedValue({ value: 'Raw text from document' });
    mammothMock.convertToHtml.mockResolvedValue({
      value: '<h1>Document Title</h1><p>Paragraph content with <strong>bold</strong> text.</p>',
    });
    agent = new DocxToHtmlAgent({ ai: mockAI, silent: true });
  });

  it('mammoth strategy returns HTML with tags', async () => {
    const result = await agent.execute(Buffer.from('mock-docx'), 'mammoth');
    expect(typeof result.output).toBe('string');
    expect(result.output).toContain('<h1>');
    expect(result.output).toContain('<p>');
    expect(result.metadata.mimeType).toBe('text/html');
  });

  it('clean strategy strips style and class attributes', async () => {
    const result = await agent.execute(Buffer.from('mock-docx'), 'clean');
    expect(result.output).not.toMatch(/style="[^"]*"/);
    expect(result.output).not.toMatch(/class="[^"]*"/);
  });

  it('styled strategy uses custom style map', async () => {
    await agent.execute(Buffer.from('mock-docx'), 'styled');
    expect(mammothMock.convertToHtml).toHaveBeenCalledWith(
      expect.objectContaining({ styleMap: expect.any(Array) }),
    );
  });
});
