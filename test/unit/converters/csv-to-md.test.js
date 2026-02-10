import { describe, it, expect, vi, beforeEach } from 'vitest';
import { testConverterAgent } from '../../mocks/converter-test-harness.js';
import { createMockAIService } from '../../mocks/conversion-mocks.js';

// Mock internal dependencies
vi.mock('../../../lib/ai-service', () => ({ default: null }));
vi.mock('../../../lib/log-event-queue', () => ({
  getLogQueue: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const mockAI = createMockAIService();

// Import the agent class (CJS)
const { CsvToMdAgent } = require('../../../lib/converters/csv-to-md.js');

const sampleCsv = 'name,age,city\nAlice,30,New York\nBob,25,Los Angeles\nCarol,28,Chicago';

// Run the standard lifecycle test harness
testConverterAgent(CsvToMdAgent, {
  sampleInput: sampleCsv,
  expectedFromFormats: ['csv'],
  expectedToFormats: ['md', 'markdown'],
  expectedStrategies: ['simple', 'aligned', 'summary'],
  mockAI,
});

// Agent-specific tests
describe('CsvToMdAgent (specific)', () => {
  let agent;

  beforeEach(() => {
    vi.clearAllMocks();
    agent = new CsvToMdAgent({ ai: mockAI, silent: true });
  });

  it('simple strategy produces a valid markdown table with pipes and separators', async () => {
    const result = await agent.execute(sampleCsv, 'simple');
    expect(result.output).toContain('| name');
    expect(result.output).toContain('| ---');
    expect(result.output).toContain('| Alice');
    const lines = result.output.split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(5); // header + separator + 3 data rows
  });

  it('aligned strategy pads columns to equal width', async () => {
    const result = await agent.execute(sampleCsv, 'aligned');
    const lines = result.output.split('\n');
    // Separator row dashes should match column widths
    const separatorRow = lines[1];
    expect(separatorRow).toMatch(/\| -+ \| -+ \| -+ \|/);
  });

  it('summary strategy appends AI-generated text after the table', async () => {
    const result = await agent.execute(sampleCsv, 'summary');
    // The table should still be present
    expect(result.output).toContain('| name');
    // AI mock's complete returns 'Mock completion'
    expect(result.output).toContain('Mock completion');
  });
});
