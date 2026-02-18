import { describe, it, expect, vi, beforeEach } from 'vitest';
import { testConverterAgent } from '../../mocks/converter-test-harness.js';
import { createMockAIService } from '../../mocks/conversion-mocks.js';

// Mock Electron BrowserWindow for PDF rendering
const mockWebContents = {
  loadURL: vi.fn().mockResolvedValue(undefined),
  on: vi.fn(),
  once: vi.fn((event, handler) => {
    if (event === 'did-finish-load') handler();
  }),
  executeJavaScript: vi.fn().mockResolvedValue(''),
  printToPDF: vi.fn().mockResolvedValue(Buffer.from('%PDF-1.4 mock content')),
  capturePage: vi.fn().mockResolvedValue({
    toPNG: vi.fn().mockReturnValue(Buffer.from([0x89, 0x50, 0x4e, 0x47])),
  }),
};
const MockBrowserWindow = vi.fn().mockImplementation(() => ({
  loadURL: vi.fn().mockResolvedValue(undefined),
  webContents: mockWebContents,
  close: vi.fn(),
  destroy: vi.fn(),
  isDestroyed: vi.fn().mockReturnValue(false),
  setSize: vi.fn(),
  on: vi.fn(),
}));

// Mock internal dependencies used by base-converter-agent
vi.mock('../../../lib/ai-service', () => ({ default: null }));
vi.mock('../../../lib/log-event-queue', () => ({
  getLogQueue: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const mockAI = createMockAIService();

// Import the agent class (CJS)
const { UrlToPdfAgent } = require('../../../lib/converters/url-to-pdf.js');

// Run the standard lifecycle test harness
testConverterAgent(UrlToPdfAgent, {
  sampleInput: 'https://example.com',
  expectedFromFormats: ['url'],
  expectedToFormats: ['pdf'],
  expectedStrategies: ['print', 'screenshot'],
  mockAI,
});

// Agent-specific tests
describe('UrlToPdfAgent (specific)', () => {
  let agent;

  beforeEach(() => {
    vi.clearAllMocks();
    agent = new UrlToPdfAgent({ ai: mockAI, silent: true, BrowserWindow: MockBrowserWindow });
  });

  it('has correct agent identity', () => {
    expect(agent.id).toBe('converter:url-to-pdf');
    expect(agent.name).toBe('URL to PDF');
  });

  it('defines exactly 2 strategies', () => {
    expect(agent.strategies.length).toBe(2);
    expect(agent.strategies.map((s) => s.id)).toEqual(['print', 'screenshot']);
  });

  it('accepts BrowserWindow via config', () => {
    expect(agent._BrowserWindow).toBe(MockBrowserWindow);
  });
});
