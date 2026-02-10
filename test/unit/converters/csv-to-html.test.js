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
const { CsvToHtmlAgent } = require('../../../lib/converters/csv-to-html.js');

const sampleCsv = 'name,age,city\nAlice,30,New York\nBob,25,Los Angeles';

// Run the standard lifecycle test harness
testConverterAgent(CsvToHtmlAgent, {
  sampleInput: sampleCsv,
  expectedFromFormats: ['csv'],
  expectedToFormats: ['html'],
  expectedStrategies: ['table', 'styled', 'sortable'],
  mockAI,
});

// Agent-specific tests
describe('CsvToHtmlAgent (specific)', () => {
  let agent;

  beforeEach(() => {
    vi.clearAllMocks();
    agent = new CsvToHtmlAgent({ ai: mockAI, silent: true });
  });

  it('table strategy produces a semantic HTML table with thead/tbody', async () => {
    const result = await agent.execute(sampleCsv, 'table');
    expect(result.output).toContain('<table>');
    expect(result.output).toContain('<thead>');
    expect(result.output).toContain('<tbody>');
    expect(result.output).toContain('<th>name</th>');
    expect(result.output).toContain('<td>Alice</td>');
  });

  it('styled strategy wraps table in a full HTML document with CSS', async () => {
    const result = await agent.execute(sampleCsv, 'styled');
    expect(result.output).toContain('<!DOCTYPE html>');
    expect(result.output).toContain('<style>');
    expect(result.output).toContain('<table>');
    expect(result.output).toContain('</html>');
  });

  it('sortable strategy includes click-to-sort JavaScript', async () => {
    const result = await agent.execute(sampleCsv, 'sortable');
    expect(result.output).toContain('<script>');
    expect(result.output).toContain('addEventListener');
    expect(result.output).toContain('cursor:pointer');
  });
});
