/**
 * Preset table for the `external-bot` kind.
 *
 * Single source of truth for the well-known third-party agents the
 * Settings -> IDWs Add form pre-fills (ChatGPT, Claude, Gemini,
 * Perplexity, Grok) plus the `'custom'` escape hatch. Picking a preset
 * fills the Label and URL fields when they are blank; user-typed
 * values are never overwritten.
 *
 * Pure data + one lookup helper. No I/O, no module state, easy to
 * unit-test. Imported through `lite/idw/api.ts` per Rule 11.
 */

import type { BotType } from './types.js';

export interface BotPreset {
  /** Stable id stored in `IdwEntry.botType`. */
  id: BotType;
  /** Display label for the dropdown (e.g. "ChatGPT"). */
  label: string;
  /** Default chat URL for this preset. Empty string for `'custom'`. */
  defaultUrl: string;
  /** Suggested value for the entry's Label field. Empty for `'custom'`. */
  defaultEntryLabel: string;
}

/**
 * Preset table. Keep `'custom'` last so the dropdown reads top-down as
 * the named presets first, then "Custom" as the explicit opt-out.
 */
export const BOT_PRESETS: ReadonlyArray<BotPreset> = [
  {
    id: 'chatgpt',
    label: 'ChatGPT',
    defaultUrl: 'https://chat.openai.com',
    defaultEntryLabel: 'ChatGPT',
  },
  {
    id: 'claude',
    label: 'Claude',
    defaultUrl: 'https://claude.ai/new',
    defaultEntryLabel: 'Claude',
  },
  {
    id: 'gemini',
    label: 'Gemini',
    defaultUrl: 'https://gemini.google.com',
    defaultEntryLabel: 'Gemini',
  },
  {
    id: 'perplexity',
    label: 'Perplexity',
    defaultUrl: 'https://www.perplexity.ai',
    defaultEntryLabel: 'Perplexity',
  },
  {
    id: 'grok',
    label: 'Grok',
    defaultUrl: 'https://grok.com',
    defaultEntryLabel: 'Grok',
  },
  {
    id: 'custom',
    label: 'Custom',
    defaultUrl: '',
    defaultEntryLabel: '',
  },
];

/**
 * Look up a preset by id. Returns `null` for an unknown id (or
 * `undefined`); callers can treat that the same as picking `'custom'`.
 */
export function findBotPreset(id: string | undefined): BotPreset | null {
  if (typeof id !== 'string' || id.length === 0) return null;
  return BOT_PRESETS.find((p) => p.id === id) ?? null;
}
