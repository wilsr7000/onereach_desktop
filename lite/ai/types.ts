/**
 * AI module -- public types.
 *
 * The AI module is a main-process-only capability: it drafts metadata
 * for a new Space (a polished purpose statement + a few high-level
 * objectives) from a short, rough note the user types. It is
 * provider-flexible -- the same `spaceAssist()` surface is served by
 * either the Anthropic Claude API or a user-supplied OneReach HTTP
 * flow (see `config.ts`). The renderer reaches it through the
 * `window.lite.ai` bridge; secrets never leave the main process.
 *
 * Per ADR-019 / Rule 11, cross-module imports go through `ai/api.ts`.
 */

/** The providers the AI module can be backed by. */
export const AI_PROVIDERS = ['claude', 'onereach-flow'] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];

/** Input to {@link AiApi.spaceAssist}. */
export interface SpaceAssistInput {
  /** The user's rough, free-text note about what the Space is for. */
  purpose: string;
  /** Optional Space name, used as extra context for the draft. */
  name?: string;
}

/** Structured draft returned by {@link AiApi.spaceAssist}. */
export interface SpaceAssistResult {
  /** A polished, 1-2 sentence purpose statement (plain text). */
  description: string;
  /** 3-5 concise, high-level objectives (short imperative phrases). */
  objectives: string[];
}

// ─── Asset metadata extraction (Claude 4.8) ──────────────────────────────
//
// The metadata-extraction capability reads an asset's content and returns
// structured metadata (summary, tags, topics, ...) that the Spaces detail
// pane surfaces as a key/value bag. The PRIMITIVE
// ({@link AiApi.extractAssetMetadata}) is content-in / metadata-out; the
// main-process ORCHESTRATOR (`ai/enrich.ts`) fetches the asset, resolves
// its bytes (text body, or a downloaded image/PDF), calls the primitive,
// and writes the result via `spaces.items.patchMetadata`.

/**
 * What to extract metadata from. Exactly one content source should be
 * populated; the orchestrator picks it based on the asset's kind:
 *   - `text`        for text / markdown / url / code / csv / json assets
 *   - `imageBase64` for image assets (sent via Claude vision)
 *   - `pdfBase64`   for PDF documents (sent as a document block)
 * When no content source is present (audio / video / opaque binaries),
 * extraction falls back to the title + filename + sourceUrl hints only.
 */
export interface AssetMetadataInput {
  /** Spaces ItemKind (document / image / url / text / audio / video / other). */
  kind: string;
  /** Current asset title, used as a hint. */
  title?: string;
  /** MIME type, used to pick the vision / document path + as a hint. */
  mimeType?: string;
  /** Original filename, used as a hint. */
  fileName?: string;
  /** External URL the asset was clipped from, used as a hint. */
  sourceUrl?: string;
  /** Inline text body (text / markdown / url / code / csv / json). */
  text?: string;
  /** Base64-encoded image bytes (for `kind === 'image'`). */
  imageBase64?: string;
  /** Image media type, e.g. `image/png` (required when `imageBase64` is set). */
  imageMediaType?: string;
  /** Base64-encoded PDF bytes (for PDF documents). */
  pdfBase64?: string;
}

/**
 * Structured metadata Claude returns for an asset. Every field is
 * best-effort: arrays may be empty, strings may be `''` when the model
 * has nothing useful to say. The orchestrator drops empty values before
 * writing the metadata bag.
 */
export interface AssetMetadataResult {
  /** 1-3 sentence plain-text summary of what the asset is/contains. */
  summary: string;
  /** A concise, human-friendly title suggestion (may match the existing one). */
  suggestedTitle: string;
  /** Short keyword tags (lowercase, no `#`). */
  tags: string[];
  /** Higher-level topics / themes the asset covers. */
  topics: string[];
  /** Named entities (people, orgs, products, places) mentioned. */
  entities: string[];
  /** A short content-type label (e.g. "meeting transcript", "invoice", "diagram"). */
  contentType: string;
  /** BCP-47-ish language tag of the dominant content language (e.g. "en"). */
  language: string;
  /** A few key points / takeaways, each a short phrase or sentence. */
  keyPoints: string[];
}

/**
 * Input for converting an agent definition to OKF. `source` is either a
 * URL (when `isUrl` is true — Lite fetches its contents first) or the
 * raw agent-definition text the user pasted.
 */
export interface OkfConversionInput {
  /** A URL (fetched) or the agent-definition text to convert. */
  source: string;
  /** When true, `source` is a URL whose contents Lite fetches first. */
  isUrl: boolean;
}

/**
 * Result of an OKF conversion. `okf` is the structured-text (YAML/MD)
 * agent definition; `agentType` is the classified type (see
 * `AGENT_TYPES` in spaces/types — may be a novel string); `name` is a
 * short suggested agent name.
 */
export interface OkfConversionResult {
  okf: string;
  agentType: string;
  name: string;
}

/**
 * Non-sensitive provider status for the renderer. NEVER carries a key,
 * token, URL, or any other secret -- only whether AI is usable and, if
 * so, which provider is wired.
 */
export interface AiStatus {
  configured: boolean;
  provider: AiProvider | null;
}

// NOTE: the public `AiApi` interface is declared in `ai/api.ts` (the
// module's canonical public contract, mirroring idw/kv) so the api-docs
// harvester documents it and `AiService` stays free of an api<->service
// import cycle.

/** Bumped when the public shape of the module changes (parallels other modules). */
export const AI_MODULE_VERSION = 1;
