import { describe, it, expect, vi, beforeEach } from 'vitest';
import { testConverterAgent } from '../../mocks/converter-test-harness.js';
import { createMockAIService } from '../../mocks/conversion-mocks.js';

// Mock child_process (for chunked strategy FFmpeg splitting)
vi.mock('child_process', () => ({
  execFile: vi.fn((cmd, args, opts, cb) => {
    if (typeof opts === 'function') { cb = opts; opts = {}; }
    if (cb) cb(null, 'mock output', '');
    return { on: vi.fn(), stdout: { on: vi.fn() }, stderr: { on: vi.fn() } };
  }),
}));

// Mock fs for temp file operations
vi.mock('fs', async () => {
  const actual = await vi.importActual('fs');
  return {
    ...actual,
    writeFileSync: vi.fn(),
    readFileSync: vi.fn(() => Buffer.from('mock audio data')),
    unlinkSync: vi.fn(),
    existsSync: vi.fn(() => true),
    statSync: vi.fn(() => ({ size: 2048 })),
  };
});

// Mock internal dependencies used by base-converter-agent
vi.mock('../../../lib/ai-service', () => ({ default: null }));
vi.mock('../../../lib/log-event-queue', () => ({
  getLogQueue: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const mockAI = createMockAIService();

// Import the agent class (CJS)
const { AudioToTextConverter } = require('../../../lib/converters/audio-to-text.js');

// Run the standard lifecycle test harness
testConverterAgent(AudioToTextConverter, {
  sampleInput: Buffer.from([0x00, 0x00, 0x00, 0x1C, 0x66, 0x74, 0x79, 0x70]),
  expectedFromFormats: ['mp3', 'wav', 'aac', 'ogg', 'flac'],
  expectedToFormats: ['text'],
  expectedStrategies: ['whisper', 'elevenlabs', 'chunked'],
  mockAI,
});

// Agent-specific tests
describe('AudioToTextConverter (specific)', () => {
  let agent;

  beforeEach(() => {
    vi.clearAllMocks();
    agent = new AudioToTextConverter({ ai: mockAI, silent: true });
  });

  it('operates in generative mode', () => {
    expect(agent.modes).toEqual(['generative']);
  });

  it('supports webm as an input format', () => {
    expect(agent.from).toContain('webm');
  });

  it('has correct agent identity', () => {
    expect(agent.id).toBe('converter:audio-to-text');
    expect(agent.name).toBe('Audio to Text Converter');
  });
});
