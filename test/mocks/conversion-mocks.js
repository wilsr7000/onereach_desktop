/**
 * Conversion Test Mocks
 * Deterministic mock factories for AI service, sharp, and other
 * dependencies used by converter agents.
 */

import { vi } from 'vitest';

// Mock AI service with deterministic responses
export function createMockAIService(overrides = {}) {
  return {
    chat: vi.fn().mockImplementation(async ({ system, _messages }) => {
      // Strategy selection responses
      if (system && system.includes('strategy selector')) {
        return { content: JSON.stringify({ strategy: 'default', reasoning: 'Mock: default strategy' }) };
      }
      // Evaluation responses
      if (system && system.includes('quality evaluator')) {
        return { content: JSON.stringify({ score: 85, issues: [], reasoning: 'Mock: quality passed' }) };
      }
      // Content generation
      return { content: overrides.chatResponse || 'Mock AI response content' };
    }),
    json: vi.fn().mockImplementation(async (prompt, _options) => {
      if (prompt.includes('strategy')) {
        return { strategy: overrides.strategy || 'default', reasoning: 'Mock strategy selection' };
      }
      if (prompt.includes('evaluat')) {
        return { score: overrides.evalScore || 85, issues: [], reasoning: 'Mock evaluation' };
      }
      return overrides.jsonResponse || { result: 'mock' };
    }),
    complete: vi.fn().mockResolvedValue(overrides.completeResponse || 'Mock completion'),
    vision: vi.fn().mockResolvedValue({ content: overrides.visionResponse || 'A test image showing text content' }),
    tts: vi.fn().mockResolvedValue(overrides.ttsResponse || Buffer.from('mock-audio-data')),
    transcribe: vi
      .fn()
      .mockResolvedValue({ text: overrides.transcribeResponse || 'Mock transcription of audio content' }),
    embed: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
    imageEdit: vi.fn().mockResolvedValue(overrides.imageResponse || Buffer.from('mock-image-data')),
  };
}

// Mock sharp
export function createMockSharp() {
  const instance = {
    metadata: vi.fn().mockResolvedValue({ width: 200, height: 200, format: 'png' }),
    resize: vi.fn().mockReturnThis(),
    toFormat: vi.fn().mockReturnThis(),
    png: vi.fn().mockReturnThis(),
    jpeg: vi.fn().mockReturnThis(),
    webp: vi.fn().mockReturnThis(),
    gif: vi.fn().mockReturnThis(),
    tiff: vi.fn().mockReturnThis(),
    toBuffer: vi.fn().mockResolvedValue(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), // PNG header
  };
  const sharpFn = vi.fn().mockReturnValue(instance);
  sharpFn.fit = { inside: 'inside', cover: 'cover', fill: 'fill' };
  sharpFn.strategy = { attention: 'attention' };
  return sharpFn;
}
