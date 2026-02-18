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
    // Return valid JSON for ffprobe calls
    const stdout =
      cmd === 'ffprobe' || (Array.isArray(args) && args.includes('-show_streams'))
        ? JSON.stringify({
            streams: [{ codec_type: 'audio', channels: 2, bit_rate: '192000' }],
            format: { duration: '60.0' },
          })
        : 'mock output';
    if (cb) cb(null, stdout, '');
    return { on: vi.fn(), stdout: { on: vi.fn() }, stderr: { on: vi.fn() } };
  }),
}));

// Mock fs for temp file operations
vi.mock('fs', async () => {
  const actual = await vi.importActual('fs');
  return {
    ...actual,
    writeFileSync: vi.fn(),
    readFileSync: vi.fn(() => Buffer.from([0xff, 0xfb, 0x90, 0x00])),
    unlinkSync: vi.fn(),
    existsSync: vi.fn(() => true),
    statSync: vi.fn(() => ({ size: 2048 })),
  };
});

// Mock uuid
vi.mock('uuid', () => ({ v4: () => 'test-uuid-audio' }));

// Mock internal dependencies used by base-converter-agent
vi.mock('../../../lib/ai-service', () => ({ default: null }));
vi.mock('../../../lib/log-event-queue', () => ({
  getLogQueue: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const mockAI = createMockAIService();

// Import the agent class (CJS)
const { VideoToAudioAgent } = require('../../../lib/converters/video-to-audio.js');

// Run the standard lifecycle test harness
testConverterAgent(VideoToAudioAgent, {
  sampleInput: Buffer.from([0x00, 0x00, 0x00, 0x1c, 0x66, 0x74, 0x79, 0x70]),
  expectedFromFormats: ['mp4', 'webm', 'mov'],
  expectedToFormats: ['mp3', 'wav', 'aac'],
  expectedStrategies: ['full-track', 'speech-only', 'best-track'],
  mockAI,
});

// Agent-specific tests
describe('VideoToAudioAgent (specific)', () => {
  let agent;

  beforeEach(() => {
    vi.clearAllMocks();
    agent = new VideoToAudioAgent({ ai: mockAI, silent: true });
  });

  it('declares symbolic mode only', () => {
    expect(agent.modes).toEqual(['symbolic']);
  });

  it('supports all common video input formats', () => {
    expect(agent.from).toContain('mp4');
    expect(agent.from).toContain('webm');
    expect(agent.from).toContain('mov');
    expect(agent.from).toContain('avi');
    expect(agent.from).toContain('mkv');
  });

  it('has correct agent identity', () => {
    expect(agent.id).toBe('converter:video-to-audio');
    expect(agent.name).toBe('Video to Audio');
  });
});
