import { describe, it, expect, vi, beforeEach } from 'vitest';
import { testConverterAgent } from '../../mocks/converter-test-harness.js';
import { createMockAIService } from '../../mocks/conversion-mocks.js';

// Mock electron
vi.mock('electron', () => ({
  BrowserWindow: vi.fn().mockImplementation(() => ({
    loadURL: vi.fn().mockResolvedValue(undefined),
    webContents: {
      printToPDF: vi.fn().mockResolvedValue(Buffer.from('%PDF-1.4 mock pdf content')),
    },
    destroy: vi.fn(),
  })),
}));

vi.mock('../../../lib/ai-service', () => ({ default: null }));
vi.mock('../../../lib/log-event-queue', () => ({
  getLogQueue: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const mockAI = createMockAIService();
const { MdToPdfAgent } = require('../../../lib/converters/md-to-pdf.js');

testConverterAgent(MdToPdfAgent, {
  sampleInput: '# Hello World\n\nSome **bold** content.',
  expectedFromFormats: ['md', 'markdown'],
  expectedToFormats: ['pdf'],
  expectedStrategies: ['basic', 'styled'],
  mockAI,
});

describe('MdToPdfAgent (specific)', () => {
  let agent;

  beforeEach(() => {
    vi.clearAllMocks();
    agent = new MdToPdfAgent({ ai: mockAI, silent: true });
  });

  it('has correct agent identity', () => {
    expect(agent.id).toBe('converter:md-to-pdf');
    expect(agent.name).toBe('Markdown to PDF');
  });

  it('accepts markdown and markdown as source formats', () => {
    expect(agent.from).toContain('md');
    expect(agent.from).toContain('markdown');
  });

  it('outputs pdf format only', () => {
    expect(agent.to).toEqual(['pdf']);
  });

  it('uses symbolic mode only', () => {
    expect(agent.modes).toEqual(['symbolic']);
  });

  it('basic strategy produces PDF output', async () => {
    const result = await agent.convert('# Test\n\nParagraph here.');
    expect(result.report).toBeDefined();
    if (result.success && result.output) {
      const output = Buffer.isBuffer(result.output) ? result.output.toString() : String(result.output);
      expect(output).toContain('%PDF');
    }
  });
});
