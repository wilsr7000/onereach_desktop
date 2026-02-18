import { describe, it, expect, vi, beforeEach } from 'vitest';
import { testConverterAgent } from '../../mocks/converter-test-harness.js';
import { createMockAIService } from '../../mocks/conversion-mocks.js';

// Mock child_process for FFmpeg calls
vi.mock('child_process', () => ({
  execFile: vi.fn((cmd, args, opts, cb) => {
    if (typeof opts === 'function') {
      opts(null, '', '');
    } else if (typeof cb === 'function') {
      cb(null, '', '');
    }
  }),
}));

// Mock uuid for deterministic temp directory names
vi.mock('uuid', () => ({
  v4: vi.fn().mockReturnValue('test-uuid-1234'),
}));

// Mock fs operations for temp file handling
vi.mock('fs', async () => {
  const actual = await vi.importActual('fs');
  return {
    ...actual,
    writeFile: vi.fn((path, data, opts, cb) => {
      if (typeof opts === 'function') opts(null);
      else if (typeof cb === 'function') cb(null);
    }),
    readFile: vi.fn((path, opts, cb) => {
      if (typeof opts === 'function') opts(null, Buffer.from([0x00, 0x00, 0x01, 0x00]));
      else if (typeof cb === 'function') cb(null, Buffer.from([0x00, 0x00, 0x01, 0x00]));
    }),
    mkdir: vi.fn((path, opts, cb) => {
      if (typeof opts === 'function') opts(null);
      else if (typeof cb === 'function') cb(null);
    }),
    unlink: vi.fn((path, cb) => {
      if (typeof cb === 'function') cb(null);
    }),
    readdir: vi.fn((path, cb) => {
      if (typeof cb === 'function') cb(null, []);
    }),
    existsSync: vi.fn().mockReturnValue(false),
    mkdirSync: vi.fn(),
  };
});

// Mock internal dependencies used by base-converter-agent
vi.mock('../../../lib/ai-service', () => ({ default: null }));
vi.mock('../../../lib/log-event-queue', () => ({
  getLogQueue: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const mockAI = createMockAIService({
  ttsResponse: Buffer.from('mock-audio-tts-data'),
});

// Import the agent class (CJS)
const { TextToVideoConverter } = require('../../../lib/converters/text-to-video.js');

// Run the standard lifecycle test harness
testConverterAgent(TextToVideoConverter, {
  sampleInput: 'A brief presentation about AI',
  expectedFromFormats: ['text'],
  expectedToFormats: ['mp4', 'webm'],
  expectedStrategies: ['narrated-slides', 'animated', 'presenter'],
  mockAI,
});

// Agent-specific tests
describe('TextToVideoConverter (specific)', () => {
  let agent;

  beforeEach(() => {
    vi.clearAllMocks();
    agent = new TextToVideoConverter({ ai: mockAI, silent: true });
  });

  it('has correct agent identity', () => {
    expect(agent.id).toBe('converter:text-to-video');
    expect(agent.name).toContain('Video');
  });

  it('uses generative mode', () => {
    expect(agent.modes).toContain('generative');
  });

  it('defines narrated-slides as the primary strategy', () => {
    const primary = agent.strategies[0];
    expect(primary.id).toBe('narrated-slides');
    expect(primary.description).toContain('Split text');
  });
});
