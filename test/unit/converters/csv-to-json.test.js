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
const { CsvToJsonAgent } = require('../../../lib/converters/csv-to-json.js');

const sampleCsv = 'name,age,active\nAlice,30,true\nBob,25,false\nCarol,28,true';

// Run the standard lifecycle test harness
testConverterAgent(CsvToJsonAgent, {
  sampleInput: sampleCsv,
  expectedFromFormats: ['csv'],
  expectedToFormats: ['json'],
  expectedStrategies: ['auto-type', 'string-only', 'nested'],
  mockAI,
});

// Agent-specific tests
describe('CsvToJsonAgent (specific)', () => {
  let agent;

  beforeEach(() => {
    vi.clearAllMocks();
    agent = new CsvToJsonAgent({ ai: mockAI, silent: true });
  });

  it('auto-type strategy infers numbers and booleans', async () => {
    const result = await agent.execute(sampleCsv, 'auto-type');
    const parsed = JSON.parse(result.output);
    expect(parsed[0].age).toBe(30);
    expect(parsed[0].active).toBe(true);
    expect(parsed[1].active).toBe(false);
  });

  it('string-only strategy preserves all values as strings', async () => {
    const result = await agent.execute(sampleCsv, 'string-only');
    const parsed = JSON.parse(result.output);
    expect(typeof parsed[0].age).toBe('string');
    expect(parsed[0].age).toBe('30');
    expect(typeof parsed[0].active).toBe('string');
  });

  it('nested strategy groups rows by first column', async () => {
    const csv = 'category,item,price\nfruit,apple,1.5\nfruit,banana,0.75\nveg,carrot,0.9';
    const result = await agent.execute(csv, 'nested');
    const parsed = JSON.parse(result.output);
    expect(parsed.groupedBy).toBe('category');
    expect(parsed.groups.fruit).toHaveLength(2);
    expect(parsed.groups.veg).toHaveLength(1);
  });
});
