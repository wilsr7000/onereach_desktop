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
const { JupyterToMdAgent } = require('../../../lib/converters/jupyter-to-md.js');

const sampleNotebook = JSON.stringify({
  nbformat: 4,
  nbformat_minor: 5,
  metadata: {
    kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' },
    language_info: { name: 'python' },
  },
  cells: [
    {
      cell_type: 'markdown',
      metadata: {},
      source: ['# Title\n', '\n', 'Some text.'],
    },
    {
      cell_type: 'code',
      execution_count: 1,
      metadata: {},
      outputs: [
        { output_type: 'stream', name: 'stdout', text: ['Hello World\n'] },
      ],
      source: ['print("Hello World")'],
    },
  ],
});

// Run the standard lifecycle test harness
testConverterAgent(JupyterToMdAgent, {
  sampleInput: sampleNotebook,
  expectedFromFormats: ['ipynb'],
  expectedToFormats: ['md', 'markdown'],
  expectedStrategies: ['flat', 'sectioned', 'with-output'],
  mockAI,
});

// Agent-specific tests
describe('JupyterToMdAgent (specific)', () => {
  let agent;

  beforeEach(() => {
    vi.clearAllMocks();
    agent = new JupyterToMdAgent({ ai: mockAI, silent: true });
  });

  it('flat strategy produces markdown with code fences', async () => {
    const result = await agent.execute(sampleNotebook, 'flat');
    expect(result.output).toContain('# Title');
    expect(result.output).toContain('```python');
    expect(result.output).toContain('print("Hello World")');
  });

  it('with-output strategy includes cell outputs as blockquotes', async () => {
    const result = await agent.execute(sampleNotebook, 'with-output');
    expect(result.output).toContain('**Output:**');
    expect(result.output).toContain('> Hello World');
  });

  it('sectioned strategy inserts horizontal rules between cell type changes', async () => {
    const result = await agent.execute(sampleNotebook, 'sectioned');
    expect(result.output).toContain('---');
  });
});
