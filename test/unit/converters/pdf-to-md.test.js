import { describe, it, expect, vi, beforeEach } from 'vitest';
import { testConverterAgent } from '../../mocks/converter-test-harness.js';
import { createMockAIService } from '../../mocks/conversion-mocks.js';

// Mock pdf-parse
vi.mock('pdf-parse', () => ({
  default: vi.fn().mockResolvedValue({
    text: 'Report Title\n\nIntroduction\n\nLorem ipsum dolor sit amet.',
    numpages: 5,
    info: { Title: 'Mock PDF Report' },
  }),
}));

// Mock internal dependencies used by base-converter-agent
vi.mock('../../../lib/ai-service', () => ({ default: null }));
vi.mock('../../../lib/log-event-queue', () => ({
  getLogQueue: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const mockAI = createMockAIService({
  completeResponse: '# Report Title\n\n## Introduction\n\nLorem ipsum dolor sit amet.',
  chatResponse: '# Report Title\n\n## Introduction\n\nLorem ipsum dolor sit amet.',
});

// Import the agent class (CJS)
const { PdfToMdAgent } = require('../../../lib/converters/pdf-to-md.js');

// Run the standard lifecycle test harness
testConverterAgent(PdfToMdAgent, {
  sampleInput: Buffer.from([0x25, 0x50, 0x44, 0x46]),
  expectedFromFormats: ['pdf'],
  expectedToFormats: ['md'],
  expectedStrategies: ['structured', 'layout-aware', 'semantic'],
  mockAI,
});

// Agent-specific tests
describe('PdfToMdAgent (specific)', () => {
  let agent;

  beforeEach(() => {
    vi.clearAllMocks();
    agent = new PdfToMdAgent({ ai: mockAI, silent: true });
  });

  it('operates in generative mode', () => {
    expect(agent.modes).toContain('generative');
  });

  it('offers three structuring strategies', () => {
    const ids = agent.strategies.map(s => s.id);
    expect(ids).toEqual(['structured', 'layout-aware', 'semantic']);
  });

  it('has correct agent identity', () => {
    expect(agent.id).toBe('converter:pdf-to-md');
    expect(agent.name).toBe('PDF to Markdown');
  });
});
