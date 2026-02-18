import { describe, it, expect, vi, beforeEach } from 'vitest';
import { testConverterAgent } from '../../mocks/converter-test-harness.js';
import { createMockAIService } from '../../mocks/conversion-mocks.js';

// Mock child_process (FFmpeg-dependent)
vi.mock('child_process', () => ({
  execFile: vi.fn((cmd, args, opts, cb) => {
    if (typeof opts === 'function') {
      cb = opts;
      opts = {};
    }
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
    statSync: vi.fn(() => ({ size: 4096 })),
  };
});

// Mock uuid
vi.mock('uuid', () => ({ v4: () => 'test-uuid-vtt' }));

// Mock TranscriptionService (lazy-loaded by the agent)
vi.mock('../../../src/transcription/TranscriptionService', () => ({
  TranscriptionService: class MockTranscriptionService {
    async transcribe() {
      return { text: 'Mock ElevenLabs transcription' };
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
const { VideoToTextAgent } = require('../../../lib/converters/video-to-text.js');

// Run the standard lifecycle test harness
testConverterAgent(VideoToTextAgent, {
  sampleInput: Buffer.from([0x00, 0x00, 0x00, 0x1c, 0x66, 0x74, 0x79, 0x70]),
  expectedFromFormats: ['mp4', 'webm', 'mov'],
  expectedToFormats: ['text'],
  expectedStrategies: ['whisper', 'elevenlabs', 'hybrid'],
  mockAI,
});

// Agent-specific tests
describe('VideoToTextAgent (specific)', () => {
  let agent;

  beforeEach(() => {
    vi.clearAllMocks();
    agent = new VideoToTextAgent({ ai: mockAI, silent: true });
  });

  it('operates in generative mode', () => {
    expect(agent.modes).toContain('generative');
  });

  it('targets text output format only', () => {
    expect(agent.to).toEqual(['text']);
  });

  it('has correct agent identity', () => {
    expect(agent.id).toBe('converter:video-to-text');
    expect(agent.name).toBe('Video to Text');
  });
});
