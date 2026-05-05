/**
 * Per-kind metadata table -- single source of truth for everything
 * the UI and validator need to know about a given `AgentKind`:
 *
 *  - Display labels (singular + plural + menu section heading)
 *  - Accent color for cards, pills, badges (CSS variable name)
 *  - Default icon emoji shown when `entry.iconName` / `thumbnailUrl`
 *    is absent
 *  - Required fields (validation hook)
 *  - Whether the kind supports the `apiUrl` field
 *  - Whether the kind requires an `audio` sub-category field
 *  - Whether the kind supports the `environment` field
 *
 * Keeping these in one table means adding a new kind is one diff:
 * append to `AGENT_KINDS`, add the row here, the rest of the module
 * picks it up automatically.
 *
 * @internal
 */

import type { AgentKind, IdwEntry } from './types.js';

export interface KindMetadata {
  /** Singular display label, e.g. "External Bot". */
  label: string;
  /** Plural display label, e.g. "External Bots". */
  pluralLabel: string;
  /** Section heading shown in the IDW menu (typically the plural label). */
  menuSectionLabel: string;
  /** CSS variable name (without `--`) used for accent color tokens. */
  accentVar: string;
  /** Hex color for fallback rendering / tests. */
  accentHex: string;
  /** Default emoji used as a card icon when no thumbnail/icon is set. */
  defaultIconEmoji: string;
  /**
   * Fields required for validation. Always implicitly: `kind`, `label`,
   * `url`, `source`. List additional ones here per kind.
   */
  requiredFields: ReadonlyArray<keyof IdwEntry>;
  /** Whether the Add/Edit form should expose an apiUrl input. */
  supportsApiUrl: boolean;
  /** Whether the kind requires an `audio.subCategory` field. */
  requiresAudioSubCategory: boolean;
  /** Whether the Add/Edit form should expose an environment input. */
  supportsEnvironment: boolean;
}

/**
 * The metadata table. Keys are the canonical kind values; values are
 * the per-kind UI + validation contract.
 */
export const KIND_META: Readonly<Record<AgentKind, KindMetadata>> = {
  idw: {
    label: 'IDW',
    pluralLabel: 'IDWs',
    menuSectionLabel: 'IDWs',
    accentVar: 'accent-idw',
    accentHex: '#4f8cff',
    defaultIconEmoji: '\u{1F916}', // robot
    requiredFields: [],
    supportsApiUrl: false,
    requiresAudioSubCategory: false,
    supportsEnvironment: true,
  },
  'external-bot': {
    label: 'External Bot',
    pluralLabel: 'External Bots',
    menuSectionLabel: 'External Bots',
    accentVar: 'accent-external-bot',
    accentHex: '#b87bff',
    defaultIconEmoji: '\u{1F4AC}', // speech balloon
    requiredFields: [],
    supportsApiUrl: true,
    requiresAudioSubCategory: false,
    supportsEnvironment: false,
  },
  'image-creator': {
    label: 'Image Creator',
    pluralLabel: 'Image Creators',
    menuSectionLabel: 'Image Creators',
    accentVar: 'accent-image-creator',
    accentHex: '#ff7bb3',
    defaultIconEmoji: '\u{1F3A8}', // artist palette
    requiredFields: [],
    supportsApiUrl: true,
    requiresAudioSubCategory: false,
    supportsEnvironment: false,
  },
  'video-creator': {
    label: 'Video Creator',
    pluralLabel: 'Video Creators',
    menuSectionLabel: 'Video Creators',
    accentVar: 'accent-video-creator',
    accentHex: '#ff9c4a',
    defaultIconEmoji: '\u{1F3AC}', // clapper board
    requiredFields: [],
    supportsApiUrl: true,
    requiresAudioSubCategory: false,
    supportsEnvironment: false,
  },
  'audio-generator': {
    label: 'Audio Generator',
    pluralLabel: 'Audio Generators',
    menuSectionLabel: 'Audio Generators',
    accentVar: 'accent-audio-generator',
    accentHex: '#6bff8a',
    defaultIconEmoji: '\u{1F3B5}', // musical note
    requiredFields: ['audio'],
    supportsApiUrl: true,
    requiresAudioSubCategory: true,
    supportsEnvironment: false,
  },
  'ui-design-tool': {
    label: 'UI Design Tool',
    pluralLabel: 'UI Design Tools',
    menuSectionLabel: 'UI Design Tools',
    accentVar: 'accent-ui-design-tool',
    accentHex: '#7bdbff',
    defaultIconEmoji: '\u{1F58C}', // paintbrush
    requiredFields: [],
    supportsApiUrl: true,
    requiresAudioSubCategory: false,
    supportsEnvironment: false,
  },
};

/** Display label for an audio sub-category (capitalized). */
export const AUDIO_SUB_LABELS: Readonly<Record<string, string>> = {
  music: 'Music',
  effects: 'Sound Effects',
  narration: 'Narration',
  custom: 'Custom',
};
