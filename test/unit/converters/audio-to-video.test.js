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
    readFileSync: vi.fn(() => Buffer.from([0x00, 0x00, 0x00, 0x1c])),
    unlinkSync: vi.fn(),
    existsSync: vi.fn(() => true),
    statSync: vi.fn(() => ({ size: 4096 })),
  };
});

// Mock uuid
vi.mock('uuid', () => ({ v4: () => 'test-uuid-atv' }));

// Mock internal dependencies used by base-converter-agent
vi.mock('../../../lib/ai-service', () => ({ default: null }));
vi.mock('../../../lib/log-event-queue', () => ({
  getLogQueue: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const mockAI = createMockAIService();

// Import the agent class (CJS)
const { AudioToVideoConverter } = require('../../../lib/converters/audio-to-video.js');

// Run the standard lifecycle test harness
testConverterAgent(AudioToVideoConverter, {
  sampleInput: Buffer.from([0x00, 0x00, 0x00, 0x1c, 0x66, 0x74, 0x79, 0x70]),
  expectedFromFormats: ['mp3', 'wav', 'aac', 'ogg', 'flac'],
  expectedToFormats: ['mp4', 'webm'],
  expectedStrategies: ['waveform', 'spectrogram', 'bars'],
  mockAI,
});

// Agent-specific tests
describe('AudioToVideoConverter (specific)', () => {
  let agent;

  beforeEach(() => {
    vi.clearAllMocks();
    agent = new AudioToVideoConverter({ ai: mockAI, silent: true });
  });

  it('builds FFmpeg args with lavfi filter for waveform strategy', () => {
    const args = agent._buildArgs('/tmp/in.mp3', '/tmp/out.mp4', 'waveform', {
      width: 1280,
      height: 720,
      fps: 30,
      targetFormat: 'mp4',
      bgColor: '0x1a1a2e',
    });
    expect(args).toContain('-filter_complex');
    const filterArg = args[args.indexOf('-filter_complex') + 1];
    expect(filterArg).toContain('showwaves');
  });

  it('builds FFmpeg args with spectrogram filter', () => {
    const args = agent._buildArgs('/tmp/in.mp3', '/tmp/out.mp4', 'spectrogram', {
      width: 1280,
      height: 720,
      fps: 30,
      targetFormat: 'mp4',
      bgColor: '0x1a1a2e',
    });
    const filterArg = args[args.indexOf('-filter_complex') + 1];
    expect(filterArg).toContain('showspectrum');
  });

  it('throws for unknown visualization strategy', () => {
    expect(() =>
      agent._buildArgs('/tmp/in.mp3', '/tmp/out.mp4', 'invalid', {
        width: 1280,
        height: 720,
        fps: 30,
        targetFormat: 'mp4',
        bgColor: '0x1a1a2e',
      })
    ).toThrow('Unknown visualization strategy');
  });
});
