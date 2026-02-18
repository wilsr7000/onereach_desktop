import { describe, it, expect, vi, beforeEach } from 'vitest';
import { testConverterAgent } from '../../mocks/converter-test-harness.js';
import { createMockAIService } from '../../mocks/conversion-mocks.js';

// Mock js-yaml before importing agent
vi.mock('js-yaml', () => ({
  default: {
    load: vi.fn((str) => {
      // Attempt JSON parse first; fall back to a simple object for YAML-like input
      try {
        return JSON.parse(str);
      } catch (_e) {
        return { name: 'Alice', age: 30 };
      }
    }),
    dump: vi.fn((obj, _opts) => {
      return (
        Object.entries(obj)
          .map(([k, v]) => `${k}: ${v}`)
          .join('\n') + '\n'
      );
    }),
  },
}));

// Mock internal dependencies
vi.mock('../../../lib/ai-service', () => ({ default: null }));
vi.mock('../../../lib/log-event-queue', () => ({
  getLogQueue: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const mockAI = createMockAIService();

// Import the agent class (CJS)
const { JsonYamlAgent } = require('../../../lib/converters/json-yaml.js');

const sampleJson = '{"name": "Alice", "age": 30, "active": true}';

// Run the standard lifecycle test harness
testConverterAgent(JsonYamlAgent, {
  sampleInput: sampleJson,
  expectedFromFormats: ['json', 'yaml'],
  expectedToFormats: ['json', 'yaml'],
  expectedStrategies: ['standard', 'commented', 'ordered'],
  mockAI,
});

// Agent-specific tests
describe('JsonYamlAgent (specific)', () => {
  let agent;

  beforeEach(() => {
    vi.clearAllMocks();
    agent = new JsonYamlAgent({ ai: mockAI, silent: true });
  });

  it('detects JSON input and converts to YAML by default', async () => {
    const result = await agent.execute(sampleJson, 'standard');
    expect(result.metadata.sourceFormat).toBe('json');
    expect(result.metadata.targetFormat).toBe('yaml');
  });

  it('detects YAML input and converts to JSON by default', async () => {
    const yamlInput = 'name: Alice\nage: 30';
    const result = await agent.execute(yamlInput, 'standard');
    expect(result.metadata.sourceFormat).toBe('yaml');
    expect(result.metadata.targetFormat).toBe('json');
  });

  it('ordered strategy sorts keys alphabetically', () => {
    const data = { zebra: 1, apple: 2, mango: 3 };
    const sorted = agent._sortKeys(data);
    const keys = Object.keys(sorted);
    expect(keys).toEqual(['apple', 'mango', 'zebra']);
  });
});
