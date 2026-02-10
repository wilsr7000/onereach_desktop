import { describe, it, expect, vi, beforeEach } from 'vitest';
import { testConverterAgent } from '../../mocks/converter-test-harness.js';
import { createMockAIService } from '../../mocks/conversion-mocks.js';

// Mock internal dependencies used by base-converter-agent
vi.mock('../../../lib/ai-service', () => ({ default: null }));
vi.mock('../../../lib/log-event-queue', () => ({
  getLogQueue: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const mockAI = createMockAIService();

// Sample ipynb JSON for test input
const sampleIpynb = JSON.stringify({
  nbformat: 4,
  nbformat_minor: 5,
  metadata: {
    kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' },
    language_info: { name: 'python', version: '3.9.0' },
  },
  cells: [
    {
      cell_type: 'markdown',
      metadata: {},
      source: ['# Data Analysis\n', 'This notebook analyzes sample data.'],
    },
    {
      cell_type: 'code',
      metadata: {},
      source: ['import pandas as pd\n', 'import numpy as np'],
      execution_count: 1,
      outputs: [],
    },
    {
      cell_type: 'code',
      metadata: {},
      source: ['df = pd.DataFrame({"x": [1, 2, 3], "y": [4, 5, 6]})\n', 'print(df.head())'],
      execution_count: 2,
      outputs: [],
    },
  ],
});

// Import the agent class (CJS)
const { JupyterToPythonAgent } = require('../../../lib/converters/jupyter-to-python.js');

// Run the standard lifecycle test harness
testConverterAgent(JupyterToPythonAgent, {
  sampleInput: sampleIpynb,
  expectedFromFormats: ['ipynb'],
  expectedToFormats: ['py', 'python'],
  expectedStrategies: ['code-only', 'with-comments', 'executable'],
  mockAI,
});

// Agent-specific tests
describe('JupyterToPythonAgent (specific)', () => {
  let agent;

  beforeEach(() => {
    vi.clearAllMocks();
    agent = new JupyterToPythonAgent({ ai: mockAI, silent: true });
  });

  it('code-only strategy extracts only code cells', async () => {
    const result = await agent.execute(sampleIpynb, 'code-only');
    expect(typeof result.output).toBe('string');
    expect(result.output).toContain('import pandas');
    expect(result.output).not.toContain('# Data Analysis');
  });

  it('with-comments strategy includes markdown as comments', async () => {
    const result = await agent.execute(sampleIpynb, 'with-comments');
    expect(typeof result.output).toBe('string');
    expect(result.output).toContain('import pandas');
    expect(result.output).toContain('#');
  });

  it('executable strategy consolidates imports at top', async () => {
    const result = await agent.execute(sampleIpynb, 'executable');
    expect(typeof result.output).toBe('string');
    // Imports should appear before the rest of the code
    const importIndex = result.output.indexOf('import pandas');
    const codeIndex = result.output.indexOf('pd.DataFrame');
    expect(importIndex).toBeLessThan(codeIndex);
  });
});
