/**
 * IDW module shared types.
 *
 * The IDW menu in Lite hosts six "kinds" of agent entries -- IDWs from
 * an organization's OAGI, plus other categories (External Bots, Image
 * Creators, Video Creators, Audio Generators, UI Design Tools). One
 * discriminated `IdwEntry` type covers all of them; the `kind` field
 * picks the variant.
 *
 * Public types are re-exported from `api.ts`. Internal-only helpers
 * stay here.
 *
 * Design note: the type is named `IdwEntry` rather than `AgentEntry`
 * because the user-facing menu is called "IDW" and the canonical kind
 * is `idw`. The other kinds are auxiliary categories that share the
 * menu, mirroring the full app's grouping (see
 * [lib/menu-sections/idw-gsx-builder.js](lib/menu-sections/idw-gsx-builder.js)).
 */

/**
 * Stable kind discriminator. Every entry has exactly one kind. The
 * `kind` value drives:
 *  - which menu section the entry shows up under
 *  - which fields are required (see `lite/idw/kind-metadata.ts`)
 *  - which accent color and default icon the UI uses
 *  - which validation rules apply
 */
export type AgentKind =
  | 'idw'
  | 'external-bot'
  | 'image-creator'
  | 'video-creator'
  | 'audio-generator'
  | 'ui-design-tool';

/** Audio generator subdivisions; surfaced as nested submenus in the IDW menu. */
export type AudioSubCategory = 'music' | 'effects' | 'narration' | 'custom';

/**
 * Preset choices for the `external-bot` kind. The form pre-fills label
 * and URL from a small built-in table when the user picks one of the
 * named presets. `'custom'` means "no preset; user supplies label + URL".
 *
 * Stored as an optional field on `IdwEntry` so an Edit can round-trip
 * the user's original choice. Ignored for kinds other than
 * `external-bot` -- the store drops it silently on those payloads.
 */
export type BotType = 'chatgpt' | 'claude' | 'gemini' | 'perplexity' | 'grok' | 'custom';

/** All concrete `AgentKind` values, in display order. */
export const AGENT_KINDS: ReadonlyArray<AgentKind> = [
  'idw',
  'external-bot',
  'image-creator',
  'video-creator',
  'audio-generator',
  'ui-design-tool',
];

/** All concrete `AudioSubCategory` values, in display order. */
export const AUDIO_SUB_CATEGORIES: ReadonlyArray<AudioSubCategory> = [
  'music',
  'effects',
  'narration',
  'custom',
];

/** All concrete `BotType` values, in display order. */
export const BOT_TYPES: ReadonlyArray<BotType> = [
  'chatgpt',
  'claude',
  'gemini',
  'perplexity',
  'grok',
  'custom',
];

/**
 * Source of truth for one entry in the IDW menu.
 *
 * One blob in KV (`lite-idw-entries / default`) stores
 * `{ entries: IdwEntry[] }`. The `IdwStore` validates per-kind
 * required fields, dedupes by `id`, and applies Store-update
 * semantics: an `add()` call with a Store entry whose
 * `storeMetadata.catalogId` matches an existing entry UPDATES
 * rather than duplicates.
 */
export interface IdwEntry {
  /** Stable unique id (slugified label-kind if absent on add). */
  id: string;
  /** Discriminator -- picks the menu section and validation rules. */
  kind: AgentKind;
  /** Human-readable name shown in menu, Settings table, and catalog cards. */
  label: string;
  /** Primary URL -- chatUrl for IDW/bot, URL for everything else. http/https only. */
  url: string;
  /** Optional API documentation URL (image/video/audio/ui-design). */
  apiUrl?: string;
  /** Where the entry came from. Drives the "Manual" / "Store" badge in Settings. */
  source: 'manual' | 'store';
  /** Optional human-readable description. */
  description?: string;
  /** Free-form category label (e.g. "Customer Service"). */
  category?: string;
  /** SF Symbol name or category emoji fallback (renderer chooses). */
  iconName?: string;
  /** Optional cover image URL for Store cards. */
  thumbnailUrl?: string;
  /** Mostly `kind=idw`: 'staging' | 'edison' | 'production' | 'custom'. */
  environment?: string;
  /** Present iff `kind=audio-generator`. Drives nested submenu placement. */
  audio?: { subCategory: AudioSubCategory };
  /**
   * Present iff `kind=external-bot`. Records which preset the user
   * chose (ChatGPT, Claude, etc.) so Edit pre-selects the right option.
   * Dropped silently by `store.ts` for any other kind.
   */
  botType?: BotType;
  /** Present iff `source=store`. Used to dedupe Store re-installs / updates. */
  storeMetadata?: {
    /** Matches the IDW or Agent node id in OAGI graph. */
    catalogId: string;
    developer?: string;
    version?: string;
    installedAt: string;
    updatedAt?: string;
  };
  /** ISO 8601. */
  createdAt: string;
  /** ISO 8601. */
  updatedAt: string;
}

/**
 * Persisted blob shape under KV `lite-idw-entries / default`.
 * Wrapped so the store can later add a top-level schemaVersion or
 * other metadata without breaking existing readers.
 */
export interface IdwStorageBlob {
  schemaVersion: 1;
  entries: IdwEntry[];
}

/** Sentinel constant so types.ts has a value-level export (avoids dep-cruiser orphan warning). */
export const IDW_MODULE_VERSION = 1 as const;
