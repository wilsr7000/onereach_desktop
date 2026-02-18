import { describe, it, expect, vi, beforeEach } from 'vitest';
import { testConverterAgent } from '../../mocks/converter-test-harness.js';
import { createMockAIService } from '../../mocks/conversion-mocks.js';

// Mock pdf-parse
vi.mock('pdf-parse', () => ({
  default: vi.fn().mockResolvedValue({
    text: 'Document Title\n\nThis is the body content of the PDF.',
    numpages: 2,
    info: { Title: 'Mock PDF Document' },
  }),
}));

// Mock internal dependencies used by base-converter-agent
vi.mock('../../../lib/ai-service', () => ({ default: null }));
vi.mock('../../../lib/log-event-queue', () => ({
  getLogQueue: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const mockAI = createMockAIService({
  completeResponse:
    '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><h1>Document Title</h1><p>This is the body content.</p></body></html>',
  chatResponse:
    '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><h1>Document Title</h1><p>This is the body content.</p></body></html>',
});

// Import the agent class (CJS)
const { PdfToHtmlAgent } = require('../../../lib/converters/pdf-to-html.js');

// Run the standard lifecycle test harness
testConverterAgent(PdfToHtmlAgent, {
  sampleInput: Buffer.from([0x25, 0x50, 0x44, 0x46]),
  expectedFromFormats: ['pdf'],
  expectedToFormats: ['html'],
  expectedStrategies: ['simple', 'styled', 'semantic'],
  mockAI,
});

// Agent-specific tests
describe('PdfToHtmlAgent (specific)', () => {
  let agent;

  beforeEach(() => {
    vi.clearAllMocks();
    agent = new PdfToHtmlAgent({ ai: mockAI, silent: true });
  });

  it('operates in generative mode', () => {
    expect(agent.modes).toContain('generative');
  });

  it('offers three HTML generation strategies', () => {
    const ids = agent.strategies.map((s) => s.id);
    expect(ids).toEqual(['simple', 'styled', 'semantic']);
  });

  it('has correct agent identity', () => {
    expect(agent.id).toBe('converter:pdf-to-html');
    expect(agent.name).toBe('PDF to HTML');
  });
});
