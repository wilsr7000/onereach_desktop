import { describe, it, expect, vi, beforeEach } from 'vitest';
import { testConverterAgent } from '../../mocks/converter-test-harness.js';
import { createMockAIService } from '../../mocks/conversion-mocks.js';

// Mock marked before importing agent
vi.mock('marked', () => ({
  marked: {
    parse: vi.fn((input) => `<p>${input}</p>\n`),
    setOptions: vi.fn(),
  },
}));

// Mock internal dependencies used by base-converter-agent
vi.mock('../../../lib/ai-service', () => ({ default: null }));
vi.mock('../../../lib/log-event-queue', () => ({
  getLogQueue: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const mockAI = createMockAIService();

// Import the agent class (CJS)
const { MdToHtmlAgent } = require('../../../lib/converters/md-to-html.js');

// Run the standard lifecycle test harness
testConverterAgent(MdToHtmlAgent, {
  sampleInput: '# Hello World\n\nThis is **bold** and *italic* text.\n\n- Item 1\n- Item 2',
  expectedFromFormats: ['md', 'markdown'],
  expectedToFormats: ['html'],
  expectedStrategies: ['standard', 'enhanced', 'styled'],
  mockAI,
});

// Agent-specific tests
describe('MdToHtmlAgent (specific)', () => {
  let agent;

  beforeEach(() => {
    vi.clearAllMocks();
    agent = new MdToHtmlAgent({ ai: mockAI, silent: true });
  });

  it('styled strategy wraps output in a full HTML document', async () => {
    const result = await agent.execute('# Test', 'styled');
    expect(result.output).toContain('<!DOCTYPE html>');
    expect(result.output).toContain('<style>');
    expect(result.output).toContain('</html>');
    expect(result.metadata.isFullDocument).toBe(true);
  });

  it('standard strategy does not produce a full document', async () => {
    const result = await agent.execute('# Test', 'standard');
    expect(result.output).not.toContain('<!DOCTYPE html>');
    expect(result.metadata.isFullDocument).toBe(false);
  });

  it('enhanced strategy enables GFM options', async () => {
    const result = await agent.execute('| A | B |\n|---|---|\n| 1 | 2 |', 'enhanced');
    expect(typeof result.output).toBe('string');
    expect(result.metadata.strategy).toBe('enhanced');
    expect(result.metadata.isFullDocument).toBe(false);
  });
});
