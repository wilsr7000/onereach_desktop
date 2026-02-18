import { describe, it, expect, vi, beforeEach } from 'vitest';
import { testConverterAgent } from '../../mocks/converter-test-harness.js';
import { createMockAIService } from '../../mocks/conversion-mocks.js';

// Mock Electron's BrowserWindow for printToPDF
vi.mock('electron', () => ({
  BrowserWindow: class MockBrowserWindow {
    constructor() {
      this.webContents = {
        loadURL: vi.fn().mockResolvedValue(undefined),
        printToPDF: vi.fn().mockResolvedValue(Buffer.from([0x25, 0x50, 0x44, 0x46])),
        on: vi.fn(),
      };
    }
    close() {}
    destroy() {}
    isDestroyed() {
      return false;
    }
  },
}));

// Mock internal dependencies used by base-converter-agent
vi.mock('../../../lib/ai-service', () => ({ default: null }));
vi.mock('../../../lib/log-event-queue', () => ({
  getLogQueue: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const mockAI = createMockAIService();

// Import the agent class (CJS)
const { HtmlToPdfAgent } = require('../../../lib/converters/html-to-pdf.js');

// Run the standard lifecycle test harness
testConverterAgent(HtmlToPdfAgent, {
  sampleInput: '<html><body><h1>Test Report</h1><p>Content here</p></body></html>',
  expectedFromFormats: ['html'],
  expectedToFormats: ['pdf'],
  expectedStrategies: ['electron', 'styled'],
  mockAI,
});

// Agent-specific tests
describe('HtmlToPdfAgent (specific)', () => {
  let agent;

  beforeEach(() => {
    vi.clearAllMocks();
    agent = new HtmlToPdfAgent({ ai: mockAI, silent: true });
  });

  it('operates in symbolic mode', () => {
    expect(agent.modes).toEqual(['symbolic']);
  });

  it('has exactly two strategies', () => {
    expect(agent.strategies).toHaveLength(2);
    const ids = agent.strategies.map((s) => s.id);
    expect(ids).toEqual(['electron', 'styled']);
  });

  it('has correct agent identity', () => {
    expect(agent.id).toBe('converter:html-to-pdf');
    expect(agent.name).toBe('HTML to PDF');
  });
});
