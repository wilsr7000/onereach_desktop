import { describe, it, expect, vi, beforeEach } from 'vitest';
import { testConverterAgent } from '../../mocks/converter-test-harness.js';
import { createMockAIService } from '../../mocks/conversion-mocks.js';

vi.mock('../../../lib/ai-service', () => ({ default: null }));
vi.mock('../../../lib/log-event-queue', () => ({
  getLogQueue: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const mockAI = createMockAIService();
const { AudioToSummaryAgent } = require('../../../lib/converters/audio-to-summary.js');

testConverterAgent(AudioToSummaryAgent, {
  sampleInput: Buffer.from('mock-audio-content'),
  expectedFromFormats: ['mp3', 'wav', 'aac'],
  expectedToFormats: ['text'],
  expectedStrategies: ['transcript-summary', 'chapter-summary', 'key-points'],
  mockAI,
});

describe('AudioToSummaryAgent (specific)', () => {
  let agent;

  beforeEach(() => {
    vi.clearAllMocks();
    agent = new AudioToSummaryAgent({ ai: mockAI, silent: true });
  });

  it('has correct agent identity', () => {
    expect(agent.id).toBe('converter:audio-to-summary');
    expect(agent.name).toBe('Audio to Summary');
  });

  it('accepts all common audio formats', () => {
    expect(agent.from).toContain('mp3');
    expect(agent.from).toContain('wav');
    expect(agent.from).toContain('aac');
    expect(agent.from).toContain('ogg');
    expect(agent.from).toContain('flac');
    expect(agent.from).toContain('m4a');
    expect(agent.from).toContain('webm');
  });

  it('uses generative mode', () => {
    expect(agent.modes).toContain('generative');
  });

  it('has three summary strategies', () => {
    const ids = agent.strategies.map(s => s.id);
    expect(ids).toContain('transcript-summary');
    expect(ids).toContain('chapter-summary');
    expect(ids).toContain('key-points');
  });

  it('transcript-summary strategy calls AI for summarization', async () => {
    const result = await agent.convert(Buffer.from('audio-data'));
    expect(result.report).toBeDefined();
    expect(mockAI.transcribe).toHaveBeenCalled();
    expect(mockAI.complete).toHaveBeenCalled();
  });
});
