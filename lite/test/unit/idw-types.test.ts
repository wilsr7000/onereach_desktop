/**
 * IDW types + kind-metadata tests.
 *
 * Verifies the per-kind metadata table covers every value of
 * AgentKind and is internally consistent (every entry has a label,
 * accent, default emoji, and validation rules).
 */

import { describe, it, expect } from 'vitest';
import { AGENT_KINDS, AUDIO_SUB_CATEGORIES } from '../../idw/types.js';
import type { AgentKind, AudioSubCategory } from '../../idw/types.js';
import { KIND_META, AUDIO_SUB_LABELS } from '../../idw/kind-metadata.js';

describe('AGENT_KINDS', () => {
  it('lists all six kinds in display order', () => {
    expect(AGENT_KINDS).toEqual([
      'idw',
      'external-bot',
      'image-creator',
      'video-creator',
      'audio-generator',
      'ui-design-tool',
    ]);
  });

  it('AUDIO_SUB_CATEGORIES lists all four', () => {
    expect(AUDIO_SUB_CATEGORIES).toEqual(['music', 'effects', 'narration', 'custom']);
  });
});

describe('KIND_META', () => {
  it('has an entry for every AgentKind', () => {
    for (const kind of AGENT_KINDS) {
      expect(KIND_META[kind]).toBeDefined();
    }
  });

  it('every entry has required string fields populated', () => {
    for (const kind of AGENT_KINDS) {
      const meta = KIND_META[kind];
      expect(typeof meta.label).toBe('string');
      expect(meta.label.length).toBeGreaterThan(0);
      expect(typeof meta.pluralLabel).toBe('string');
      expect(meta.pluralLabel.length).toBeGreaterThan(0);
      expect(typeof meta.menuSectionLabel).toBe('string');
      expect(meta.menuSectionLabel.length).toBeGreaterThan(0);
      expect(typeof meta.accentVar).toBe('string');
      expect(meta.accentVar.length).toBeGreaterThan(0);
      expect(typeof meta.accentHex).toBe('string');
      expect(meta.accentHex).toMatch(/^#[0-9a-fA-F]{6}$/);
      expect(typeof meta.defaultIconEmoji).toBe('string');
      expect(meta.defaultIconEmoji.length).toBeGreaterThan(0);
    }
  });

  it('every accent variable name is unique', () => {
    const vars = new Set<string>();
    for (const kind of AGENT_KINDS) vars.add(KIND_META[kind].accentVar);
    expect(vars.size).toBe(AGENT_KINDS.length);
  });

  it('only audio-generator requires the audio sub-category', () => {
    for (const kind of AGENT_KINDS) {
      const expected = kind === 'audio-generator';
      expect(KIND_META[kind].requiresAudioSubCategory).toBe(expected);
    }
  });

  it('only idw supports environment field', () => {
    for (const kind of AGENT_KINDS) {
      const expected = kind === 'idw';
      expect(KIND_META[kind].supportsEnvironment).toBe(expected);
    }
  });

  it('idw does not support apiUrl; the rest do', () => {
    for (const kind of AGENT_KINDS) {
      const expected = kind !== 'idw';
      expect(KIND_META[kind].supportsApiUrl).toBe(expected);
    }
  });
});

describe('AUDIO_SUB_LABELS', () => {
  it('has a label for every AudioSubCategory', () => {
    for (const sub of AUDIO_SUB_CATEGORIES) {
      expect(typeof AUDIO_SUB_LABELS[sub]).toBe('string');
      expect((AUDIO_SUB_LABELS[sub] as string).length).toBeGreaterThan(0);
    }
  });
});

// Bring the types into runtime so unused-import lints don't trip.
const _typeCheck: { kind: AgentKind; sub: AudioSubCategory } = {
  kind: 'idw',
  sub: 'music',
};
void _typeCheck;
