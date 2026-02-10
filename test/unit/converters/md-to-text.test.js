import { describe, it, expect, vi, beforeEach } from 'vitest';
import { testConverterAgent } from '../../mocks/converter-test-harness.js';
import { createMockAIService } from '../../mocks/conversion-mocks.js';

// Mock internal dependencies used by base-converter-agent
vi.mock('../../../lib/ai-service', () => ({ default: null }));
vi.mock('../../../lib/log-event-queue', () => ({
  getLogQueue: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const mockAI = createMockAIService();

// Import the agent class (CJS)
const { MdToTextAgent } = require('../../../lib/converters/md-to-text.js');

const sampleMarkdown = '# Hello World\n\nThis is **bold** and *italic* text.\n\n- Item one\n- Item two\n\n[A link](http://example.com)';

// Run the standard lifecycle test harness
testConverterAgent(MdToTextAgent, {
  sampleInput: sampleMarkdown,
  expectedFromFormats: ['md', 'markdown'],
  expectedToFormats: ['text'],
  expectedStrategies: ['strip', 'readable', 'outline'],
  mockAI,
});

// Agent-specific tests
describe('MdToTextAgent (specific)', () => {
  let agent;

  beforeEach(() => {
    vi.clearAllMocks();
    agent = new MdToTextAgent({ ai: mockAI, silent: true });
  });

  it('strip strategy removes all markdown syntax', async () => {
    const result = await agent.execute(sampleMarkdown, 'strip');
    expect(result.output).not.toContain('#');
    expect(result.output).not.toContain('**');
    expect(result.output).not.toContain('*');
    expect(result.output).not.toContain('[');
    expect(result.output).toContain('Hello World');
    expect(result.output).toContain('bold');
  });

  it('readable strategy converts headings to uppercase', async () => {
    const result = await agent.execute(sampleMarkdown, 'readable');
    expect(result.output).toContain('HELLO WORLD');
  });

  it('outline strategy extracts headings with first sentence', async () => {
    const result = await agent.execute(sampleMarkdown, 'outline');
    expect(result.output).toContain('Hello World');
    expect(result.output).not.toContain('Item one');
  });
});
