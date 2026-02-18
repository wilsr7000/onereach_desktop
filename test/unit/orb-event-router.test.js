/**
 * OrbEventRouter Unit Tests
 *
 * Tests the event router (lib/orb/orb-event-router.js) covering:
 *   - OUTPUT events always delivered regardless of phase
 *   - INPUT events gated by canAcceptInput()
 *   - LIFECYCLE events always delivered
 *   - Secondary noise gate (cooldown, noise, dedup)
 *   - Unknown events silently dropped
 *
 * Run: npx vitest run test/unit/orb-event-router.test.js
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock OrbState on window
function createMockOrbState(overrides = {}) {
  return {
    phase: 'listening',
    canAcceptInput: () => true,
    get: (key) => {
      if (key === 'ttsEndTime') return 0;
      if (key === 'lastProcessedTranscript') return '';
      if (key === 'lastProcessedTime') return 0;
      return null;
    },
    ...overrides,
  };
}

// Load the event router module
function loadOrbEventRouter() {
  const _window = {};
  _window.OrbState = createMockOrbState();

  const fs = require('fs');
  const path = require('path');
  const code = fs.readFileSync(path.join(__dirname, '../../lib/orb/orb-event-router.js'), 'utf8');

  const fn = new Function('window', 'console', code);
  fn(_window, console);

  return _window;
}

describe('OrbEventRouter', () => {
  let _window;
  let capturedCallback;
  let mockOrbAPI;

  beforeEach(() => {
    _window = loadOrbEventRouter();
    capturedCallback = null;
    mockOrbAPI = {
      onEvent: (cb) => {
        capturedCallback = cb;
      },
    };
  });

  function startRouter(handlers, config = {}, stateOverrides = {}) {
    if (Object.keys(stateOverrides).length > 0) {
      _window.OrbState = createMockOrbState(stateOverrides);
    }
    _window.OrbEventRouter.start(mockOrbAPI, handlers, config);
    return capturedCallback;
  }

  // ==================== OUTPUT Events ====================

  describe('OUTPUT events (always delivered)', () => {
    const outputTypes = [
      'audio_delta',
      'audio_wav',
      'audio_done',
      'clear_audio_buffer',
      'speech_text_delta',
      'speech_text',
      'response_cancelled',
    ];

    for (const type of outputTypes) {
      it(`delivers ${type} regardless of phase`, () => {
        const handler = vi.fn();
        const emit = startRouter(
          { [type]: handler },
          {},
          {
            phase: 'idle',
            canAcceptInput: () => false,
          }
        );

        emit({ type });
        expect(handler).toHaveBeenCalledTimes(1);
      });
    }

    it('delivers audio_wav during processing phase', () => {
      const handler = vi.fn();
      const emit = startRouter(
        { audio_wav: handler },
        {},
        {
          phase: 'processing',
          canAcceptInput: () => false,
        }
      );

      emit({ type: 'audio_wav', audio: 'base64data' });
      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  // ==================== INPUT Events ====================

  describe('INPUT events (gated by canAcceptInput)', () => {
    it('delivers transcript when canAcceptInput() is true', () => {
      const handler = vi.fn();
      const emit = startRouter(
        { transcript: handler },
        {},
        {
          canAcceptInput: () => true,
        }
      );

      emit({ type: 'transcript', text: 'hello world' });
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('blocks transcript when canAcceptInput() is false', () => {
      const handler = vi.fn();
      const emit = startRouter(
        { transcript: handler },
        {},
        {
          phase: 'processing',
          canAcceptInput: () => false,
        }
      );

      emit({ type: 'transcript', text: 'hello world' });
      expect(handler).not.toHaveBeenCalled();
    });

    it('delivers function_call_transcript when canAcceptInput() is true', () => {
      const handler = vi.fn();
      const emit = startRouter(
        { function_call_transcript: handler },
        {},
        {
          canAcceptInput: () => true,
        }
      );

      emit({ type: 'function_call_transcript', transcript: 'what time is it', callId: '123' });
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('blocks function_call_transcript during speaking', () => {
      const handler = vi.fn();
      const emit = startRouter(
        { function_call_transcript: handler },
        {},
        {
          phase: 'speaking',
          canAcceptInput: () => false,
        }
      );

      emit({ type: 'function_call_transcript', transcript: 'test', callId: '123' });
      expect(handler).not.toHaveBeenCalled();
    });

    it('delivers session_updated during connecting (canAcceptInput true)', () => {
      const handler = vi.fn();
      const emit = startRouter(
        { session_updated: handler },
        {},
        {
          phase: 'connecting',
          canAcceptInput: () => true,
        }
      );

      emit({ type: 'session_updated' });
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('delivers transcript_delta when canAcceptInput() is true', () => {
      const handler = vi.fn();
      const emit = startRouter(
        { transcript_delta: handler },
        {},
        {
          canAcceptInput: () => true,
        }
      );

      emit({ type: 'transcript_delta', text: 'hel' });
      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  // ==================== LIFECYCLE Events ====================

  describe('LIFECYCLE events (always delivered)', () => {
    const lifecycleTypes = ['disconnected', 'error', 'reconnecting', 'reconnected'];

    for (const type of lifecycleTypes) {
      it(`delivers ${type} regardless of phase`, () => {
        const handler = vi.fn();
        const emit = startRouter(
          { [type]: handler },
          {},
          {
            phase: 'idle',
            canAcceptInput: () => false,
          }
        );

        emit({ type });
        expect(handler).toHaveBeenCalledTimes(1);
      });
    }
  });

  // ==================== Secondary Noise Gate ====================

  describe('secondary noise gate', () => {
    it('rejects transcript during TTS cooldown', () => {
      const handler = vi.fn();
      const emit = startRouter(
        { transcript: handler },
        { ttsCooldownMs: 2500 },
        {
          canAcceptInput: () => true,
          get: (key) => {
            if (key === 'ttsEndTime') return Date.now() - 500; // 500ms ago
            if (key === 'lastProcessedTranscript') return '';
            if (key === 'lastProcessedTime') return 0;
            return null;
          },
        }
      );

      emit({ type: 'transcript', text: 'echo text' });
      expect(handler).not.toHaveBeenCalled();
    });

    it('passes transcript after TTS cooldown expires', () => {
      const handler = vi.fn();
      const emit = startRouter(
        { transcript: handler },
        { ttsCooldownMs: 2500 },
        {
          canAcceptInput: () => true,
          get: (key) => {
            if (key === 'ttsEndTime') return Date.now() - 3000; // 3s ago, past cooldown
            if (key === 'lastProcessedTranscript') return '';
            if (key === 'lastProcessedTime') return 0;
            return null;
          },
        }
      );

      emit({ type: 'transcript', text: 'real command' });
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('rejects noise via isLikelyNoise callback', () => {
      const handler = vi.fn();
      const emit = startRouter(
        { function_call_transcript: handler },
        {
          isLikelyNoise: (text) => text === 'um',
        },
        {
          canAcceptInput: () => true,
        }
      );

      emit({ type: 'function_call_transcript', transcript: 'um', callId: '1' });
      expect(handler).not.toHaveBeenCalled();
    });

    it('passes non-noise through isLikelyNoise callback', () => {
      const handler = vi.fn();
      const emit = startRouter(
        { function_call_transcript: handler },
        {
          isLikelyNoise: (text) => text === 'um',
        },
        {
          canAcceptInput: () => true,
        }
      );

      emit({ type: 'function_call_transcript', transcript: 'what time is it', callId: '1' });
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('rejects duplicate transcript within dedup window', () => {
      const handler = vi.fn();
      const emit = startRouter(
        { transcript: handler },
        { dedupWindowMs: 3000 },
        {
          canAcceptInput: () => true,
          get: (key) => {
            if (key === 'ttsEndTime') return 0;
            if (key === 'lastProcessedTranscript') return 'what time is it';
            if (key === 'lastProcessedTime') return Date.now() - 1000; // 1s ago
            return null;
          },
        }
      );

      emit({ type: 'transcript', text: 'what time is it' });
      expect(handler).not.toHaveBeenCalled();
    });

    it('passes transcript if different from last', () => {
      const handler = vi.fn();
      const emit = startRouter(
        { transcript: handler },
        { dedupWindowMs: 3000 },
        {
          canAcceptInput: () => true,
          get: (key) => {
            if (key === 'ttsEndTime') return 0;
            if (key === 'lastProcessedTranscript') return 'what time is it';
            if (key === 'lastProcessedTime') return Date.now() - 1000;
            return null;
          },
        }
      );

      emit({ type: 'transcript', text: 'what is the weather' });
      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  // ==================== Unknown Events ====================

  describe('unknown events', () => {
    it('silently drops unknown event types', () => {
      const handler = vi.fn();
      const emit = startRouter(
        { transcript: handler },
        {},
        {
          canAcceptInput: () => true,
        }
      );

      // Should not throw
      emit({ type: 'unknown_event_type' });
      expect(handler).not.toHaveBeenCalled();
    });
  });

  // ==================== Handler Missing ====================

  describe('missing handlers', () => {
    it('does not crash when handler is not registered for OUTPUT event', () => {
      const emit = startRouter({}, {});
      expect(() => emit({ type: 'audio_done' })).not.toThrow();
    });

    it('does not crash when handler is not registered for INPUT event', () => {
      const emit = startRouter({}, {}, { canAcceptInput: () => true });
      expect(() => emit({ type: 'transcript', text: 'hello' })).not.toThrow();
    });
  });
});
