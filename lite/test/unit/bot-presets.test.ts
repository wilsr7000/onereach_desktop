/**
 * Bot presets table tests.
 *
 * Verifies the small `BOT_PRESETS` data table is internally
 * consistent: every preset has a non-empty id and label, every
 * non-`custom` preset has a valid http(s) URL and a non-empty
 * default entry label, and `findBotPreset` looks up correctly.
 */

import { describe, it, expect } from 'vitest';
import { BOT_PRESETS, findBotPreset } from '../../idw/bot-presets.js';
import { BOT_TYPES } from '../../idw/types.js';
import type { BotType } from '../../idw/types.js';

describe('BOT_PRESETS', () => {
  it('covers every BotType value exactly once', () => {
    const ids = BOT_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length); // no duplicates
    expect(new Set(ids)).toEqual(new Set(BOT_TYPES));
  });

  it('every preset has non-empty id and label', () => {
    for (const p of BOT_PRESETS) {
      expect(p.id.length).toBeGreaterThan(0);
      expect(p.label.length).toBeGreaterThan(0);
    }
  });

  it('every non-custom preset has a valid http(s) URL', () => {
    for (const p of BOT_PRESETS) {
      if (p.id === 'custom') continue;
      const parsed = new URL(p.defaultUrl);
      expect(parsed.protocol === 'http:' || parsed.protocol === 'https:').toBe(true);
      expect(p.defaultEntryLabel.length).toBeGreaterThan(0);
    }
  });

  it('the custom preset has empty defaultUrl and defaultEntryLabel', () => {
    const custom = BOT_PRESETS.find((p) => p.id === 'custom');
    expect(custom).toBeDefined();
    expect(custom?.defaultUrl).toBe('');
    expect(custom?.defaultEntryLabel).toBe('');
  });

  it('keeps "custom" last in the dropdown order', () => {
    expect(BOT_PRESETS[BOT_PRESETS.length - 1]?.id).toBe('custom');
  });
});

describe('findBotPreset', () => {
  it('returns the matching preset for a known id', () => {
    const preset = findBotPreset('chatgpt');
    expect(preset).not.toBeNull();
    expect(preset?.id).toBe('chatgpt');
    expect(preset?.defaultUrl).toBe('https://chat.openai.com');
  });

  it('returns null for an unknown id', () => {
    expect(findBotPreset('nonexistent-bot')).toBeNull();
  });

  it('returns null for undefined or empty input', () => {
    expect(findBotPreset(undefined)).toBeNull();
    expect(findBotPreset('')).toBeNull();
  });

  it('looks up every BotType', () => {
    for (const id of BOT_TYPES as ReadonlyArray<BotType>) {
      const preset = findBotPreset(id);
      expect(preset).not.toBeNull();
      expect(preset?.id).toBe(id);
    }
  });
});
