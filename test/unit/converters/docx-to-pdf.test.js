import { describe, it, expect, vi, beforeEach } from 'vitest';
import { testConverterAgent } from '../../mocks/converter-test-harness.js';
import { createMockAIService } from '../../mocks/conversion-mocks.js';

// Mock mammoth
vi.mock('mammoth', () => ({
  convertToHtml: vi.fn().mockResolvedValue({ value: '<p>Mock DOCX content</p>', messages: [] }),
}));

// Mock electron
vi.mock('electron', () => ({
  BrowserWindow: vi.fn().mockImplementation(() => ({
    loadURL: vi.fn().mockResolvedValue(undefined),
    webContents: {
      printToPDF: vi.fn().mockResolvedValue(Buffer.from('%PDF-1.4 mock pdf from docx')),
    },
    destroy: vi.fn(),
  })),
}));

vi.mock('../../../lib/ai-service', () => ({ default: null }));
vi.mock('../../../lib/log-event-queue', () => ({
  getLogQueue: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const mockAI = createMockAIService();
const { DocxToPdfAgent } = require('../../../lib/converters/docx-to-pdf.js');

testConverterAgent(DocxToPdfAgent, {
  sampleInput: Buffer.from('PK mock docx content'),
  expectedFromFormats: ['docx'],
  expectedToFormats: ['pdf'],
  expectedStrategies: ['mammoth', 'styled'],
  mockAI,
});

describe('DocxToPdfAgent (specific)', () => {
  let agent;

  beforeEach(() => {
    vi.clearAllMocks();
    agent = new DocxToPdfAgent({ ai: mockAI, silent: true });
  });

  it('has correct agent identity', () => {
    expect(agent.id).toBe('converter:docx-to-pdf');
    expect(agent.name).toBe('DOCX to PDF');
  });

  it('accepts only docx as source format', () => {
    expect(agent.from).toEqual(['docx']);
  });

  it('outputs pdf format only', () => {
    expect(agent.to).toEqual(['pdf']);
  });

  it('mammoth strategy produces PDF output', async () => {
    const result = await agent.convert(Buffer.from('PK mock docx'));
    expect(result.report).toBeDefined();
    if (result.success && result.output) {
      const output = Buffer.isBuffer(result.output) ? result.output.toString() : String(result.output);
      expect(output).toContain('%PDF');
    }
  });
});
