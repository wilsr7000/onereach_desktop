import { describe, it, expect, vi, beforeEach } from 'vitest';
import { testConverterAgent } from '../../mocks/converter-test-harness.js';
import { createMockAIService } from '../../mocks/conversion-mocks.js';

// Mock pdf-parse
vi.mock('pdf-parse', () => ({
  default: vi.fn().mockResolvedValue({
    text: 'Chapter 1\n\nLorem ipsum dolor sit amet, consectetur adipiscing elit.',
    numpages: 3,
    info: { Title: 'Mock PDF' },
  }),
}));

// Mock internal dependencies used by base-converter-agent
vi.mock('../../../lib/ai-service', () => ({ default: null }));
vi.mock('../../../lib/log-event-queue', () => ({
  getLogQueue: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const mockAI = createMockAIService();

// Import the agent class (CJS)
const { PdfToTextAgent } = require('../../../lib/converters/pdf-to-text.js');

// Run the standard lifecycle test harness
testConverterAgent(PdfToTextAgent, {
  sampleInput: Buffer.from([0x25, 0x50, 0x44, 0x46]),
  expectedFromFormats: ['pdf'],
  expectedToFormats: ['text'],
  expectedStrategies: ['text-layer', 'ocr-vision', 'hybrid'],
  mockAI,
});

// Agent-specific tests
describe('PdfToTextAgent (specific)', () => {
  let agent;

  beforeEach(() => {
    vi.clearAllMocks();
    agent = new PdfToTextAgent({ ai: mockAI, silent: true });
  });

  it('supports three extraction modes', () => {
    expect(agent.modes).toContain('symbolic');
    expect(agent.modes).toContain('generative');
    expect(agent.modes).toContain('hybrid');
  });

  it('has configurable minCharsPerPage threshold', () => {
    const custom = new PdfToTextAgent({ ai: mockAI, silent: true, minCharsPerPage: 100 });
    expect(custom._minCharsPerPage).toBe(100);
  });

  it('has correct agent identity', () => {
    expect(agent.id).toBe('converter:pdf-to-text');
    expect(agent.name).toBe('PDF to Text');
  });
});
