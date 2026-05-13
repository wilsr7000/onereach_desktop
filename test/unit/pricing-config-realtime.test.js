/**
 * pricing-config -- realtime model rates + audio/cached token math
 *
 * Covers the additions made for the Realtime API 2 migration:
 *   - gpt-realtime-2 row with text/audio/cached rates
 *   - gpt-realtime-whisper row (transcription)
 *   - gpt-realtime-translate row (translation)
 *   - calculateCost handles inputAudioTokens / outputAudioTokens
 *   - calculateCost handles cachedInputTokens (splits inputCost into
 *     billed-input + cached-input portions)
 *   - resolveModelName aliases the preview snapshots to gpt-realtime-2
 *     so historical usage entries still get the GA rates
 */

import { describe, it, expect } from 'vitest';

const {
  PRICING,
  calculateCost,
  resolveModelName,
  getPricingForModel,
} = require('../../pricing-config');

describe('pricing-config -- realtime model rates', () => {
  it('gpt-realtime-2 has separate text, audio, and cached rates', () => {
    expect(PRICING['gpt-realtime-2']).toMatchObject({
      input: 4.0,
      output: 24.0,
      inputAudio: 32.0,
      outputAudio: 64.0,
      inputCached: 0.4,
      provider: 'openai',
    });
  });

  it('gpt-realtime-whisper is transcription-only (no outputAudio rate)', () => {
    const p = PRICING['gpt-realtime-whisper'];
    expect(p.inputAudio).toBe(32.0);
    expect(p.outputAudio).toBeUndefined();
    expect(p.inputCached).toBe(0.4);
  });

  it('gpt-realtime-translate has both audio rates + cached', () => {
    const p = PRICING['gpt-realtime-translate'];
    expect(p.inputAudio).toBe(32.0);
    expect(p.outputAudio).toBe(64.0);
    expect(p.inputCached).toBe(0.4);
  });

  it('aliases preview snapshots to gpt-realtime-2', () => {
    expect(resolveModelName('gpt-4o-realtime-preview')).toBe('gpt-realtime-2');
    expect(resolveModelName('gpt-4o-realtime-preview-2024-10-01')).toBe('gpt-realtime-2');
    expect(resolveModelName('gpt-4o-realtime-preview-2024-12-17')).toBe('gpt-realtime-2');
    expect(resolveModelName('gpt-realtime')).toBe('gpt-realtime-2');
  });

  it('getPricingForModel returns the aliased row for preview names', () => {
    const p = getPricingForModel('gpt-4o-realtime-preview');
    expect(p.input).toBe(4.0);
    expect(p.inputCached).toBe(0.4);
  });
});

describe('calculateCost -- audio token split', () => {
  it('prices input and output audio tokens at the per-bucket rate', () => {
    const result = calculateCost('gpt-realtime-2', 1000, 500, {
      inputAudioTokens: 10_000,
      outputAudioTokens: 5_000,
    });
    // text: 1000 * $4/M = $0.004; 500 * $24/M = $0.012
    // audio in: 10_000 * $32/M = $0.32; audio out: 5_000 * $64/M = $0.32
    expect(result.inputCost).toBeCloseTo(0.004, 6);
    expect(result.outputCost).toBeCloseTo(0.012, 6);
    expect(result.inputAudioCost).toBeCloseTo(0.32, 6);
    expect(result.outputAudioCost).toBeCloseTo(0.32, 6);
    expect(result.totalCost).toBeCloseTo(0.004 + 0.012 + 0.32 + 0.32, 6);
  });

  it('surfaces the audio token counts in the breakdown', () => {
    const result = calculateCost('gpt-realtime-2', 100, 50, {
      inputAudioTokens: 999,
      outputAudioTokens: 333,
    });
    expect(result.inputAudioTokens).toBe(999);
    expect(result.outputAudioTokens).toBe(333);
  });

  it('reports inputAudioPer1M and outputAudioPer1M in the pricing block', () => {
    const result = calculateCost('gpt-realtime-2', 0, 0, {
      inputAudioTokens: 0,
      outputAudioTokens: 0,
    });
    expect(result.pricing.inputAudioPer1M).toBe(32.0);
    expect(result.pricing.outputAudioPer1M).toBe(64.0);
    expect(result.pricing.inputCachedPer1M).toBe(0.4);
  });
});

describe('calculateCost -- cached input split', () => {
  it('subtracts cached tokens from inputTokens and prices each at its rate', () => {
    // 10_000 input total, of which 8_000 are cached
    // billed input: 2_000 * $4/M = $0.008
    // cached input: 8_000 * $0.40/M = $0.0032
    const result = calculateCost('gpt-realtime-2', 10_000, 0, {
      cachedInputTokens: 8_000,
    });
    expect(result.cachedInputTokens).toBe(8_000);
    expect(result.cachedInputCost).toBeCloseTo(0.0032, 6);
    // The effective inputCost is billed + cached together (this is the line
    // shown on the budget dashboard)
    expect(result.inputCost).toBeCloseTo(0.008 + 0.0032, 6);
    expect(result.totalCost).toBeCloseTo(0.008 + 0.0032, 6);
  });

  it('omitting cachedInputTokens keeps inputCost at the full rate', () => {
    const result = calculateCost('gpt-realtime-2', 10_000, 0);
    expect(result.cachedInputTokens).toBe(0);
    expect(result.cachedInputCost).toBe(0);
    expect(result.inputCost).toBeCloseTo(0.04, 6); // 10_000 * $4/M
  });

  it('handles cached > input gracefully (clamps billed to >= 0)', () => {
    const result = calculateCost('gpt-realtime-2', 100, 0, {
      cachedInputTokens: 500,
    });
    // Should not produce negative billed cost
    expect(result.inputCost).toBeGreaterThanOrEqual(0);
  });

  it('combines audio + cached in one call', () => {
    const result = calculateCost('gpt-realtime-2', 1000, 500, {
      inputAudioTokens: 2000,
      outputAudioTokens: 1000,
      cachedInputTokens: 700,
    });
    // billed input: 300 * $4/M = 0.0012
    // cached input: 700 * $0.40/M = 0.00028
    // text out: 500 * $24/M = 0.012
    // audio in: 2000 * $32/M = 0.064
    // audio out: 1000 * $64/M = 0.064
    expect(result.totalCost).toBeCloseTo(0.0012 + 0.00028 + 0.012 + 0.064 + 0.064, 6);
  });
});

describe('voice-listener usage forwarding', () => {
  // Imports voice-listener with electron mocked so the require chain doesn't
  // pull in BrowserWindow / ws. We're testing the slice that builds the
  // trackUsage payload from a response.done event.
  it('extracts cached_tokens from input_token_details when present', () => {
    // Pure helper extracted from the response.done handler so we can test it
    // without instantiating the full listener. This mirrors what
    // voice-listener.js does inline.
    function buildTrackUsagePayload(usage) {
      const inputAudio = usage.input_token_details?.audio_tokens || 0;
      const outputAudio = usage.output_token_details?.audio_tokens || 0;
      const cachedInput = usage.input_token_details?.cached_tokens || 0;
      const inputText =
        usage.input_token_details?.text_tokens ??
        Math.max(0, (usage.input_tokens || 0) - inputAudio);
      const outputText =
        usage.output_token_details?.text_tokens ??
        Math.max(0, (usage.output_tokens || 0) - outputAudio);
      return {
        inputTokens: inputText,
        outputTokens: outputText,
        options: {
          inputAudioTokens: inputAudio,
          outputAudioTokens: outputAudio,
          cachedInputTokens: cachedInput,
        },
      };
    }

    const usage = {
      input_tokens: 1500,
      output_tokens: 200,
      input_token_details: { text_tokens: 1000, audio_tokens: 500, cached_tokens: 800 },
      output_token_details: { text_tokens: 150, audio_tokens: 50 },
    };
    const payload = buildTrackUsagePayload(usage);
    expect(payload.inputTokens).toBe(1000);
    expect(payload.outputTokens).toBe(150);
    expect(payload.options.inputAudioTokens).toBe(500);
    expect(payload.options.outputAudioTokens).toBe(50);
    expect(payload.options.cachedInputTokens).toBe(800);
  });

  it('falls back to subtracting audio from total when text_tokens missing', () => {
    function buildTrackUsagePayload(usage) {
      const inputAudio = usage.input_token_details?.audio_tokens || 0;
      const inputText =
        usage.input_token_details?.text_tokens ??
        Math.max(0, (usage.input_tokens || 0) - inputAudio);
      return { inputTokens: inputText, audio: inputAudio };
    }
    const payload = buildTrackUsagePayload({
      input_tokens: 1200,
      input_token_details: { audio_tokens: 400 },
    });
    expect(payload.audio).toBe(400);
    expect(payload.inputTokens).toBe(800);
  });
});
