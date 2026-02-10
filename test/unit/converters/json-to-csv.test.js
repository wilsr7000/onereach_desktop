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
const { JsonToCsvAgent } = require('../../../lib/converters/json-to-csv.js');

const sampleJson = JSON.stringify([
  { name: 'Alice', age: 30, city: 'NYC' },
  { name: 'Bob', age: 25, city: 'LA' },
  { name: 'Carol', age: 28, city: 'Chicago' },
]);

// Run the standard lifecycle test harness
testConverterAgent(JsonToCsvAgent, {
  sampleInput: sampleJson,
  expectedFromFormats: ['json'],
  expectedToFormats: ['csv'],
  expectedStrategies: ['flat', 'top-level', 'custom-columns'],
  mockAI,
});

// Agent-specific tests
describe('JsonToCsvAgent (specific)', () => {
  let agent;

  beforeEach(() => {
    vi.clearAllMocks();
    agent = new JsonToCsvAgent({ ai: mockAI, silent: true });
  });

  it('flat strategy flattens nested objects with dot-notation', async () => {
    const nested = JSON.stringify([
      { name: 'Alice', address: { city: 'NYC', zip: '10001' } },
    ]);
    const result = await agent.execute(nested, 'flat');
    expect(result.output).toContain('address.city');
    expect(result.output).toContain('address.zip');
    expect(result.output).toContain('NYC');
  });

  it('top-level strategy skips nested objects', async () => {
    const nested = JSON.stringify([
      { name: 'Alice', age: 30, address: { city: 'NYC' } },
    ]);
    const result = await agent.execute(nested, 'top-level');
    expect(result.output).toContain('name');
    expect(result.output).toContain('age');
    expect(result.output).not.toContain('address');
  });

  it('escapes fields containing commas with quotes', async () => {
    const data = JSON.stringify([{ name: 'Smith, John', age: 40 }]);
    const result = await agent.execute(data, 'flat');
    expect(result.output).toContain('"Smith, John"');
  });
});
