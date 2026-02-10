import { describe, it, expect, vi, beforeEach } from 'vitest';
import { testConverterAgent } from '../../mocks/converter-test-harness.js';
import { createMockAIService } from '../../mocks/conversion-mocks.js';

// Mock Electron BrowserWindow for image capture
const mockNativeImage = {
  toPNG: vi.fn().mockReturnValue(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])),
  toJPEG: vi.fn().mockReturnValue(Buffer.from([0xFF, 0xD8, 0xFF, 0xE0])),
  getSize: vi.fn().mockReturnValue({ width: 1280, height: 900 }),
};
const mockWebContents = {
  loadURL: vi.fn().mockResolvedValue(undefined),
  on: vi.fn(),
  once: vi.fn((event, handler) => { if (event === 'did-finish-load') handler(); }),
  executeJavaScript: vi.fn().mockResolvedValue(900),
  capturePage: vi.fn().mockResolvedValue(mockNativeImage),
  setUserAgent: vi.fn(),
};
const MockBrowserWindow = vi.fn().mockImplementation(() => ({
  loadURL: vi.fn().mockResolvedValue(undefined),
  webContents: mockWebContents,
  close: vi.fn(),
  destroy: vi.fn(),
  isDestroyed: vi.fn().mockReturnValue(false),
  setSize: vi.fn(),
  setContentSize: vi.fn(),
  on: vi.fn(),
}));

// Mock internal dependencies used by base-converter-agent
vi.mock('../../../lib/ai-service', () => ({ default: null }));
vi.mock('../../../lib/log-event-queue', () => ({
  getLogQueue: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const mockAI = createMockAIService();

// Import the agent class (CJS)
const { UrlToImageAgent } = require('../../../lib/converters/url-to-image.js');

// Run the standard lifecycle test harness
testConverterAgent(UrlToImageAgent, {
  sampleInput: 'https://example.com',
  expectedFromFormats: ['url'],
  expectedToFormats: ['png', 'jpg'],
  expectedStrategies: ['viewport', 'full-page', 'mobile'],
  mockAI,
});

// Agent-specific tests
describe('UrlToImageAgent (specific)', () => {
  let agent;

  beforeEach(() => {
    vi.clearAllMocks();
    agent = new UrlToImageAgent({ ai: mockAI, silent: true, BrowserWindow: MockBrowserWindow });
  });

  it('has correct agent identity', () => {
    expect(agent.id).toBe('converter:url-to-image');
    expect(agent.name).toBe('URL to Image');
  });

  it('defines 3 strategies for different viewport modes', () => {
    expect(agent.strategies.length).toBe(3);
    const ids = agent.strategies.map(s => s.id);
    expect(ids).toContain('viewport');
    expect(ids).toContain('full-page');
    expect(ids).toContain('mobile');
  });

  it('accepts BrowserWindow via config', () => {
    expect(agent._BrowserWindow).toBe(MockBrowserWindow);
  });
});
