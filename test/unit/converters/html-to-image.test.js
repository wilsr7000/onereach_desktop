import { describe, it, expect, vi, beforeEach } from 'vitest';
import { testConverterAgent } from '../../mocks/converter-test-harness.js';
import { createMockAIService, createMockSharp } from '../../mocks/conversion-mocks.js';

// Mock sharp for fallback rendering
const mockSharp = createMockSharp();
vi.mock('sharp', () => ({ default: mockSharp }));

// Mock Electron's BrowserWindow for capturePage
vi.mock('electron', () => ({
  BrowserWindow: class MockBrowserWindow {
    constructor() {
      this.webContents = {
        loadURL: vi.fn().mockResolvedValue(undefined),
        capturePage: vi.fn().mockResolvedValue({
          toPNG: () => Buffer.from([0x89, 0x50, 0x4E, 0x47]),
          toJPEG: () => Buffer.from([0xFF, 0xD8, 0xFF]),
        }),
        executeJavaScript: vi.fn().mockResolvedValue({ scrollHeight: 800, scrollWidth: 1280 }),
        on: vi.fn(),
      };
      this.setBounds = vi.fn();
    }
    close() {}
    destroy() {}
    isDestroyed() { return false; }
  },
}));

// Mock internal dependencies used by base-converter-agent
vi.mock('../../../lib/ai-service', () => ({ default: null }));
vi.mock('../../../lib/log-event-queue', () => ({
  getLogQueue: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const mockAI = createMockAIService();

// Import the agent class (CJS)
const { HtmlToImageAgent } = require('../../../lib/converters/html-to-image.js');

// Run the standard lifecycle test harness
testConverterAgent(HtmlToImageAgent, {
  sampleInput: '<html><body><h1>Hello</h1><p>World</p></body></html>',
  expectedFromFormats: ['html'],
  expectedToFormats: ['png', 'jpg'],
  expectedStrategies: ['viewport', 'full-page'],
  mockAI,
});

// Agent-specific tests
describe('HtmlToImageAgent (specific)', () => {
  let agent;

  beforeEach(() => {
    vi.clearAllMocks();
    agent = new HtmlToImageAgent({ ai: mockAI, silent: true });
  });

  it('operates in symbolic mode', () => {
    expect(agent.modes).toEqual(['symbolic']);
  });

  it('has exactly two strategies', () => {
    expect(agent.strategies).toHaveLength(2);
    const ids = agent.strategies.map(s => s.id);
    expect(ids).toEqual(['viewport', 'full-page']);
  });

  it('has correct agent identity', () => {
    expect(agent.id).toBe('converter:html-to-image');
    expect(agent.name).toBe('HTML to Image');
  });
});
