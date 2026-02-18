import { describe, it, expect, vi, beforeEach } from 'vitest';
import { testConverterAgent } from '../../mocks/converter-test-harness.js';
import { createMockAIService } from '../../mocks/conversion-mocks.js';

// Mock docx package before importing agent
vi.mock('docx', () => ({
  Document: vi.fn().mockImplementation(() => ({})),
  Packer: { toBuffer: vi.fn().mockResolvedValue(Buffer.from([0x50, 0x4b, 0x03, 0x04, ...Array(96).fill(0)])) },
  Paragraph: vi.fn().mockImplementation((opts) => opts || {}),
  TextRun: vi.fn().mockImplementation((opts) => opts || {}),
  HeadingLevel: { HEADING_1: 'HEADING_1', HEADING_2: 'HEADING_2', HEADING_3: 'HEADING_3' },
  AlignmentType: { CENTER: 'CENTER', RIGHT: 'RIGHT', LEFT: 'LEFT' },
  Header: vi.fn().mockImplementation((opts) => opts || {}),
  Footer: vi.fn().mockImplementation((opts) => opts || {}),
  PageNumber: { CURRENT: 'CURRENT', TOTAL_PAGES: 'TOTAL_PAGES' },
  BorderStyle: { SINGLE: 'SINGLE' },
}));

// Mock internal dependencies used by base-converter-agent
vi.mock('../../../lib/ai-service', () => ({ default: null }));
vi.mock('../../../lib/log-event-queue', () => ({
  getLogQueue: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const mockAI = createMockAIService();

// Import the agent class (CJS)
const { ContentToDocxAgent } = require('../../../lib/converters/content-to-docx.js');

// Run the standard lifecycle test harness
testConverterAgent(ContentToDocxAgent, {
  sampleInput: 'Sample document content',
  expectedFromFormats: ['text', 'md', 'html'],
  expectedToFormats: ['docx'],
  expectedStrategies: ['standard', 'styled', 'structured'],
  mockAI,
});

// Agent-specific tests
describe('ContentToDocxAgent (specific)', () => {
  let agent;

  beforeEach(() => {
    vi.clearAllMocks();
    agent = new ContentToDocxAgent({ ai: mockAI, silent: true });
  });

  it('produces a Buffer output with PK magic bytes for standard strategy', async () => {
    const result = await agent.execute('# Hello\n\nWorld', 'standard');
    expect(Buffer.isBuffer(result.output)).toBe(true);
    expect(result.metadata.mimeType).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect(result.metadata.extension).toBe('docx');
  });

  it('structured strategy calls AI to organize content', async () => {
    await agent.execute('Some unstructured text to organize', 'structured');
    expect(mockAI.complete).toHaveBeenCalledWith(
      expect.stringContaining('Reorganize'),
      expect.objectContaining({ profile: 'fast' })
    );
  });

  it('parses inline bold and italic formatting', () => {
    const runs = agent._parseInlineFormatting('This is **bold** and *italic* text');
    expect(runs.length).toBeGreaterThan(1);
  });
});
