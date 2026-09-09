/**
 * Asset kinds — the ONE registry every Spaces surface reads (ADR-098).
 *
 * Before this file, "what kinds of asset exist" was answered in nine
 * places: the `ItemKind` union, a glyph switch, a label map, a
 * reclassify list, a media predicate, a MIME sniffer, a tile-preview
 * switch, a detail-block switch, and an empty-state switch — and the
 * full Onereach app's Spaces knew about a dozen more kinds (tools,
 * slides, code, data, design files, flows, notebooks, style guides,
 * conversations, meetings, web monitors) that Lite flattened into
 * `document` or `other`.
 *
 * Now a kind is ONE entry here: what it is called, how it is created
 * (paste / upload / link / form), which typed metadata fields it
 * carries (the detail rail's "Details" section renders and edits
 * exactly these), how a file or a main-app value is recognised as it,
 * and the copy for its empty state. The renderer, the SDK's read
 * normaliser, the picker, the matrix test — all derive from this
 * table, so adding a kind is adding a row.
 *
 * Pure: no DOM, no Electron. Importable from main, preload, renderer
 * and tests alike.
 */

import { ITEM_KINDS, type ItemKind } from './types.js';

/** Where a kind sits in the picker. Order = picker order. */
export type AssetFamily = 'write' | 'files' | 'links' | 'capabilities' | 'structured' | 'system';

/**
 * How a kind can be created from the Add-asset dialog.
 *   - paste  — a text body typed or pasted (markdown, code, CSV, JSON…)
 *   - upload — a file from disk (inline when text-like and small,
 *              GSX-bucket binary otherwise — ADR-050)
 *   - link   — a URL; providers are recognised for embeds (link-embeds.ts)
 *   - form   — typed fields only (tool, meeting, monitor…)
 */
export type CreateMode = 'paste' | 'upload' | 'link' | 'form';

/** Field control types the typed Details section knows how to render + edit. */
export type FieldType =
  | 'text'
  | 'multiline'
  | 'url'
  | 'number'
  | 'select'
  | 'boolean'
  | 'datetime'
  | 'list'
  | 'duration';

export interface FieldOption {
  value: string;
  label: string;
}

/**
 * One typed metadata field. `key` is the metadata-bag key it reads and
 * writes (`a.metadata` JSON, flat — ADR: no nesting). Keys shared with
 * the auto-extractor (`width`, `height`, `durationSeconds`, `rowCount`,
 * `columnCount`, `pageCount`, `pdfAuthor`…) use the extractor's names so
 * an upload and a hand edit land on the same row.
 */
export interface FieldSpec {
  key: string;
  label: string;
  type: FieldType;
  /** For `select`. The empty value ("—") is always offered on edit. */
  options?: readonly FieldOption[];
  placeholder?: string;
  /** One line under the control at create time; the tooltip on edit. */
  hint?: string;
  /** Must be filled to create (form/paste/link modes). */
  required?: boolean;
  /** Machine-derived (dimensions, counts…): shown, never hand-edited. */
  readOnly?: boolean;
  /** Asked at create time only (never shown in the Details editor). */
  createOnly?: boolean;
}

/** Built-in dialog panes a kind may reuse instead of a generated one. */
export type BuiltinPane = 'text' | 'upload' | 'agent' | 'knowledge';

export interface CreateSpec {
  modes: readonly CreateMode[];
  /** Reuse one of the hand-built panes (agent library, knowledge…). */
  pane?: BuiltinPane;
  /** `<input type=file accept>` for upload mode. */
  accept?: string;
  /** Label / placeholder / hint for the paste body. */
  bodyLabel?: string;
  bodyPlaceholder?: string;
  bodyHint?: string;
  /** Placeholder / hint for the link input. */
  linkPlaceholder?: string;
  linkHint?: string;
  /** Optional free-text body for form kinds (tool notes, meeting notes). */
  notesLabel?: string;
  notesPlaceholder?: string;
}

export interface AssetKindSpec {
  id: ItemKind;
  /** Singular label as the UI says it ("Slides", "Web link"). */
  label: string;
  /** Monochrome text glyph — the kit uses no emoji. */
  glyph: string;
  /** `r, g, b` for `--tile-accent` on tiles and the picker card. */
  accent: string;
  family: AssetFamily;
  /** One line in the picker card. */
  hint: string;
  /**
   * Values other writers use for this kind — the full app's
   * `assetType` / `fileCategory` / `jsonSubtype` vocabulary and older
   * Lite spellings. Read-side only: Lite always WRITES `id`.
   */
  aliases: readonly string[];
  /** null = not creatable from the dialog (WISER / tickets / intake make these). */
  create: CreateSpec | null;
  /** Typed metadata — the Details section. Order = display order. */
  fields: readonly FieldSpec[];
  /** File-name extensions (lower-case, no dot) that mean this kind. */
  extensions: readonly string[];
  /** MIME prefixes (`image/`) and exact MIME types that mean this kind. */
  mimePrefixes: readonly string[];
  mimeExact: readonly string[];
  /** Media-first tile (the preview IS the content). */
  media: boolean;
  /** Offered in the reclassify dropdown. */
  reclassifiable: boolean;
  /** Inline `content` renders as code, not markdown. */
  contentIsCode: boolean;
  /**
   * The list projections head this kind's inline `content` (first 280
   * chars as `contentHead`) so tiles can show structure without a
   * getItem round-trip. The SDK's Cypher IN-list derives from this flag.
   */
  contentHead: boolean;
  /** Metadata keys shown as a facts line on the tile / detail card. */
  facts: readonly string[];
  /** Copy for the detail rail when the asset has nothing renderable. */
  empty: { headline: string; sub: string };
}

// ─── Shared option lists ───────────────────────────────────────────────

export const LANGUAGE_OPTIONS: readonly FieldOption[] = [
  { value: 'javascript', label: 'JavaScript' },
  { value: 'typescript', label: 'TypeScript' },
  { value: 'python', label: 'Python' },
  { value: 'sql', label: 'SQL' },
  { value: 'shell', label: 'Shell' },
  { value: 'html', label: 'HTML' },
  { value: 'css', label: 'CSS' },
  { value: 'json', label: 'JSON' },
  { value: 'yaml', label: 'YAML' },
  { value: 'go', label: 'Go' },
  { value: 'rust', label: 'Rust' },
  { value: 'java', label: 'Java' },
  { value: 'kotlin', label: 'Kotlin' },
  { value: 'swift', label: 'Swift' },
  { value: 'c', label: 'C' },
  { value: 'cpp', label: 'C++' },
  { value: 'csharp', label: 'C#' },
  { value: 'ruby', label: 'Ruby' },
  { value: 'php', label: 'PHP' },
  { value: 'r', label: 'R' },
  { value: 'other', label: 'Other' },
];

/** Extension → language value for the code kind (create-time default). */
export const LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  py: 'python', sql: 'sql', sh: 'shell', bash: 'shell', zsh: 'shell',
  html: 'html', htm: 'html', css: 'css', scss: 'css', json: 'json', yaml: 'yaml', yml: 'yaml',
  go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', swift: 'swift',
  c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', hpp: 'cpp', cs: 'csharp', rb: 'ruby', php: 'php', r: 'r',
};

const CODE_EXTENSIONS: readonly string[] = [
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'mts', 'cts', 'py', 'rb', 'go', 'rs', 'java', 'kt',
  'swift', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'php', 'sh', 'bash', 'zsh', 'sql', 'scss', 'lua',
  'pl', 'r', 'm', 'mm', 'dart', 'scala', 'ex', 'exs', 'clj', 'hs', 'toml',
];

const TOOL_TYPE_OPTIONS: readonly FieldOption[] = [
  { value: 'mcp', label: 'MCP server' },
  { value: 'api', label: 'HTTP API' },
  { value: 'skill', label: 'Onereach skill' },
  { value: 'scraper', label: 'Web scraper' },
  { value: 'cli', label: 'Command line' },
  { value: 'other', label: 'Other' },
];

const AUTH_OPTIONS: readonly FieldOption[] = [
  { value: 'none', label: 'None' },
  { value: 'api-key', label: 'API key' },
  { value: 'bearer', label: 'Bearer token' },
  { value: 'oauth2', label: 'OAuth 2.0' },
  { value: 'basic', label: 'Basic' },
];

const PROVIDER_OPTIONS: readonly FieldOption[] = [
  { value: 'chatgpt', label: 'ChatGPT' },
  { value: 'claude', label: 'Claude' },
  { value: 'gemini', label: 'Gemini' },
  { value: 'copilot', label: 'Copilot' },
  { value: 'gsx', label: 'GSX' },
  { value: 'other', label: 'Other' },
];

// ─── The table ────────────────────────────────────────────────────────

const SPECS: readonly AssetKindSpec[] = [
  // ── Write ───────────────────────────────────────────────────────────
  {
    id: 'text',
    label: 'Text',
    glyph: '¶',
    accent: '148, 163, 184',
    family: 'write',
    hint: 'A note, a memo, anything in Markdown',
    aliases: ['note', 'markdown', 'md', 'basicnote'],
    create: { modes: ['paste'], pane: 'text' },
    fields: [
      { key: 'wordCount', label: 'Words', type: 'number', readOnly: true },
      { key: 'language', label: 'Language', type: 'text', placeholder: 'en' },
    ],
    extensions: [],
    mimePrefixes: [],
    // No file recognition: a text note is written, never inferred from
    // a file — text/* uploads are documents (the pre-ADR-098 answer).
    mimeExact: [],
    media: false,
    reclassifiable: true,
    contentIsCode: false,
    contentHead: false,
    facts: ['wordCount'],
    empty: {
      headline: 'Nothing written here yet.',
      sub: 'Paste or upload a note and it appears here.',
    },
  },
  {
    id: 'code',
    label: 'Code',
    glyph: '{ }',
    accent: '16, 185, 129',
    family: 'write',
    hint: 'A script, a snippet, a source file',
    aliases: ['source', 'snippet', 'script', 'source-code'],
    create: {
      modes: ['paste', 'upload'],
      accept: '.js,.mjs,.cjs,.jsx,.ts,.tsx,.py,.rb,.go,.rs,.java,.kt,.swift,.c,.h,.cc,.cpp,.hpp,.cs,.php,.sh,.bash,.zsh,.sql,.scss,.lua,.pl,.r,.dart,.scala,.toml,.yaml,.yml',
      bodyLabel: 'Source',
      bodyPlaceholder: 'Paste the code…',
      bodyHint: 'Rendered as code, never as Markdown',
    },
    fields: [
      { key: 'language', label: 'Language', type: 'select', options: LANGUAGE_OPTIONS },
      { key: 'code_purpose', label: 'Purpose', type: 'text', placeholder: 'What it does' },
      { key: 'code_entry_point', label: 'Entry point', type: 'text', placeholder: 'main(), handler…' },
      { key: 'code_framework', label: 'Framework', type: 'text', placeholder: 'Express, React, none…' },
      { key: 'code_dependencies', label: 'Dependencies', type: 'list', placeholder: 'lodash, axios' },
      { key: 'lineCount', label: 'Lines', type: 'number', readOnly: true },
    ],
    extensions: CODE_EXTENSIONS,
    mimePrefixes: [],
    mimeExact: [
      'text/javascript', 'application/javascript', 'application/x-javascript', 'application/typescript',
      'text/x-python', 'application/x-python-code', 'text/x-go', 'text/x-rust', 'text/x-java-source',
      'application/x-sh', 'text/x-shellscript', 'application/sql', 'text/x-sql', 'text/x-c', 'text/x-c++',
    ],
    media: false,
    reclassifiable: true,
    contentIsCode: true,
    contentHead: true,
    facts: ['language', 'lineCount'],
    empty: {
      headline: 'No source saved for this item.',
      sub: 'Paste or upload the code — it renders here as code with its language.',
    },
  },
  {
    id: 'data',
    label: 'Data',
    glyph: '⊞',
    accent: '6, 182, 212',
    family: 'write',
    hint: 'A table, a CSV, a JSON dataset, a spreadsheet',
    aliases: ['spreadsheet', 'dataset', 'csv', 'table', 'sheet', 'json-data'],
    create: {
      modes: ['paste', 'upload'],
      accept: '.csv,.tsv,.json,.xlsx,.xls,.ods,.parquet,.ndjson',
      bodyLabel: 'Rows',
      bodyPlaceholder: 'name,email,plan\nAda,ada@example.com,pro\n…',
      bodyHint: 'CSV, TSV, or JSON — headers, row and column counts are read automatically',
    },
    fields: [
      {
        key: 'data_format', label: 'Format', type: 'select',
        options: [
          { value: 'csv', label: 'CSV' }, { value: 'tsv', label: 'TSV' }, { value: 'json', label: 'JSON' },
          { value: 'xlsx', label: 'Excel' }, { value: 'ods', label: 'OpenDocument' }, { value: 'parquet', label: 'Parquet' },
          { value: 'other', label: 'Other' },
        ],
      },
      { key: 'rowCount', label: 'Rows', type: 'number', readOnly: true },
      { key: 'columnCount', label: 'Columns', type: 'number', readOnly: true },
      { key: 'headers', label: 'Headers', type: 'list', readOnly: true },
      { key: 'data_source', label: 'Source', type: 'text', placeholder: 'Where the data comes from' },
      { key: 'data_refreshed_at', label: 'Refreshed', type: 'datetime' },
    ],
    extensions: ['csv', 'tsv', 'xlsx', 'xls', 'ods', 'parquet', 'ndjson'],
    mimePrefixes: [],
    mimeExact: [
      'text/csv', 'text/tab-separated-values', 'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.oasis.opendocument.spreadsheet', 'application/x-parquet', 'application/x-ndjson',
    ],
    media: false,
    reclassifiable: true,
    contentIsCode: true,
    contentHead: true,
    facts: ['rowCount', 'columnCount'],
    empty: {
      headline: 'No rows saved for this item.',
      sub: 'Paste CSV or JSON, or upload a spreadsheet — the first rows render here as a table.',
    },
  },
  {
    id: 'styleguide',
    label: 'Style guide',
    glyph: '❖',
    accent: '168, 85, 247',
    family: 'write',
    hint: 'Brand tokens — colors, type, spacing — as JSON',
    aliases: ['style-guide', 'brand', 'design-tokens', 'tokens', 'brand-guide'],
    create: {
      modes: ['paste', 'upload'],
      accept: '.json',
      bodyLabel: 'Tokens',
      bodyPlaceholder: '{\n  "colors": { "primary": "#3f78c0", "ink": "#1b1712" },\n  "typography": { "body": { "fontFamily": "Inter", "fontSize": 14 } }\n}',
      bodyHint: 'JSON with `colors` and `typography` — swatches and type samples render from it',
    },
    fields: [
      { key: 'styleguide_brand', label: 'Brand', type: 'text', placeholder: 'Acme' },
      { key: 'styleguide_version', label: 'Version', type: 'text', placeholder: '2.1' },
      { key: 'styleguide_colors', label: 'Colors', type: 'number', readOnly: true },
      { key: 'styleguide_fonts', label: 'Fonts', type: 'list', readOnly: true },
    ],
    extensions: [],
    mimePrefixes: [],
    mimeExact: [],
    media: false,
    reclassifiable: true,
    contentIsCode: true,
    contentHead: true,
    facts: ['styleguide_colors', 'styleguide_fonts'],
    empty: {
      headline: 'No tokens saved for this style guide.',
      sub: 'Paste a JSON document with `colors` and `typography` to see swatches and samples here.',
    },
  },
  {
    id: 'conversation',
    label: 'Conversation',
    glyph: '◒',
    accent: '20, 184, 166',
    family: 'write',
    hint: 'A chat with an AI assistant, exported or pasted',
    aliases: ['chatbot-conversation', 'chat', 'ai-conversation', 'thread', 'chat-export'],
    create: {
      modes: ['paste', 'upload'],
      accept: '.json,.md,.txt',
      bodyLabel: 'Messages',
      bodyPlaceholder: 'Paste a JSON export ({ "messages": [ … ] }) or the chat as text — "You:" / "Assistant:" lines work',
      bodyHint: 'Renders as a thread; the provider and message count are read from it',
    },
    fields: [
      { key: 'conversation_provider', label: 'Provider', type: 'select', options: PROVIDER_OPTIONS },
      { key: 'conversation_model', label: 'Model', type: 'text', placeholder: 'gpt-5.2, claude-fable-5-1…' },
      { key: 'conversation_messages', label: 'Messages', type: 'number', readOnly: true },
      { key: 'conversation_started_at', label: 'Started', type: 'datetime' },
      { key: 'conversation_url', label: 'Original link', type: 'url', placeholder: 'https://…' },
    ],
    extensions: [],
    mimePrefixes: [],
    mimeExact: [],
    media: false,
    reclassifiable: true,
    contentIsCode: false,
    contentHead: true,
    facts: ['conversation_provider', 'conversation_messages'],
    empty: {
      headline: 'No messages saved for this conversation.',
      sub: 'Paste the export or the chat text — it renders here as a thread.',
    },
  },
  // ── Files ───────────────────────────────────────────────────────────
  {
    id: 'document',
    label: 'Document',
    glyph: '▯',
    accent: '100, 116, 139',
    family: 'files',
    hint: 'PDF, Word, Pages, HTML, plain text',
    aliases: ['doc', 'html', 'pdf', 'generated-document', 'word', 'pages', 'article'],
    create: {
      modes: ['upload'],
      pane: 'upload',
      accept: '.pdf,.doc,.docx,.rtf,.odt,.pages,.txt,.md,.markdown,.html,.htm,.xml,.epub',
    },
    fields: [
      {
        key: 'document_type', label: 'Type', type: 'select',
        options: [
          { value: 'report', label: 'Report' }, { value: 'memo', label: 'Memo' }, { value: 'spec', label: 'Spec' },
          { value: 'contract', label: 'Contract' }, { value: 'manual', label: 'Manual' }, { value: 'article', label: 'Article' },
          { value: 'other', label: 'Other' },
        ],
      },
      { key: 'pdfAuthor', label: 'Author', type: 'text' },
      { key: 'pageCount', label: 'Pages', type: 'number', readOnly: true },
      { key: 'wordCount', label: 'Words', type: 'number', readOnly: true },
      { key: 'language', label: 'Language', type: 'text', placeholder: 'en' },
    ],
    extensions: ['pdf', 'doc', 'docx', 'rtf', 'odt', 'pages', 'txt', 'text', 'md', 'markdown', 'html', 'htm', 'xml', 'epub', 'mmd', 'mermaid'],
    mimePrefixes: ['text/'],
    mimeExact: [
      'application/pdf', 'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/rtf', 'application/vnd.oasis.opendocument.text', 'application/epub+zip', 'application/xml',
    ],
    media: false,
    reclassifiable: true,
    contentIsCode: false,
    contentHead: false,
    facts: ['pageCount', 'wordCount'],
    empty: {
      headline: 'No document attached.',
      sub: 'Upload a PDF, Word, or text file — it previews here with its page count.',
    },
  },
  {
    id: 'image',
    label: 'Image',
    glyph: '▣',
    accent: '236, 72, 153',
    family: 'files',
    hint: 'Photos, screenshots, diagrams, SVG',
    aliases: ['image-file', 'screenshot', 'photo', 'picture', 'diagram', 'svg'],
    create: {
      modes: ['upload', 'link'],
      accept: 'image/*',
      linkPlaceholder: 'https://…/image.png',
      linkHint: 'A direct image URL',
    },
    fields: [
      { key: 'width', label: 'Width', type: 'number', readOnly: true },
      { key: 'height', label: 'Height', type: 'number', readOnly: true },
      { key: 'alt_text', label: 'Alt text', type: 'text', placeholder: 'What the image shows' },
      { key: 'credit', label: 'Credit', type: 'text', placeholder: 'Photographer, source' },
      { key: 'screenshot', label: 'Screenshot', type: 'boolean' },
    ],
    extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'heic', 'heif', 'avif', 'bmp', 'tif', 'tiff', 'ico'],
    mimePrefixes: ['image/'],
    mimeExact: [],
    media: true,
    reclassifiable: true,
    contentIsCode: false,
    contentHead: false,
    facts: ['width', 'height'],
    empty: {
      headline: 'No image attached.',
      sub: 'Upload an image and it previews here.',
    },
  },
  {
    id: 'video',
    label: 'Video',
    glyph: '▶',
    accent: '139, 92, 246',
    family: 'files',
    hint: 'A recording, or a YouTube / Vimeo / Loom link',
    aliases: ['recording', 'movie', 'clip', 'youtube', 'screen-recording', 'video-file'],
    create: {
      modes: ['upload', 'link'],
      accept: 'video/*',
      linkPlaceholder: 'https://youtube.com/watch?v=… or https://vimeo.com/…',
      linkHint: 'YouTube, Vimeo, Loom, or a direct .mp4 link — plays inline',
    },
    fields: [
      { key: 'durationSeconds', label: 'Duration', type: 'duration', readOnly: true },
      { key: 'width', label: 'Width', type: 'number', readOnly: true },
      { key: 'height', label: 'Height', type: 'number', readOnly: true },
      { key: 'video_provider', label: 'Provider', type: 'text', readOnly: true },
      { key: 'video_embed_url', label: 'Embed', type: 'url', readOnly: true },
      { key: 'video_poster', label: 'Poster', type: 'url', placeholder: 'https://…/poster.jpg' },
      { key: 'video_speakers', label: 'Speakers', type: 'list', placeholder: 'Ada, Grace' },
    ],
    extensions: ['mp4', 'mov', 'webm', 'm4v', 'mkv', 'avi', 'mpg', 'mpeg'],
    mimePrefixes: ['video/'],
    mimeExact: [],
    media: true,
    reclassifiable: true,
    contentIsCode: false,
    contentHead: false,
    facts: ['durationSeconds', 'video_provider'],
    empty: {
      headline: 'No video attached.',
      sub: 'Upload a recording or paste a YouTube, Vimeo, or Loom link — it plays here.',
    },
  },
  {
    id: 'audio',
    label: 'Audio',
    glyph: '♪',
    accent: '245, 158, 11',
    family: 'files',
    hint: 'A voice memo, a call recording, a podcast link',
    aliases: ['podcast', 'sound', 'voice', 'audio-file', 'recording-audio'],
    create: {
      modes: ['upload', 'link'],
      accept: 'audio/*',
      linkPlaceholder: 'https://…/episode.mp3',
      linkHint: 'A direct audio URL',
    },
    fields: [
      { key: 'durationSeconds', label: 'Duration', type: 'duration', readOnly: true },
      { key: 'audio_speakers', label: 'Speakers', type: 'list', placeholder: 'Ada, Grace' },
      { key: 'audio_language', label: 'Language', type: 'text', placeholder: 'en' },
    ],
    extensions: ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'oga', 'flac', 'aiff', 'opus'],
    mimePrefixes: ['audio/'],
    mimeExact: [],
    media: true,
    reclassifiable: true,
    contentIsCode: false,
    contentHead: false,
    facts: ['durationSeconds'],
    empty: {
      headline: 'No audio attached.',
      sub: 'Upload a recording or paste a direct audio link — a player appears here.',
    },
  },
  {
    id: 'presentation',
    label: 'Slides',
    glyph: '▦',
    accent: '249, 115, 22',
    family: 'files',
    hint: 'A deck — PowerPoint, Keynote, or a Google Slides link',
    aliases: ['slides', 'slide', 'deck', 'slideshow', 'keynote', 'powerpoint', 'presentation-file', 'pitch'],
    create: {
      modes: ['upload', 'link'],
      accept: '.ppt,.pptx,.key,.odp,.pdf',
      linkPlaceholder: 'https://docs.google.com/presentation/d/…',
      linkHint: 'Google Slides, Keynote (iCloud), Canva, or Pitch — published decks play inline',
    },
    fields: [
      { key: 'slide_count', label: 'Slides', type: 'number' },
      { key: 'presentation_provider', label: 'Provider', type: 'text', readOnly: true },
      { key: 'presentation_embed_url', label: 'Embed', type: 'url', readOnly: true },
      {
        key: 'presentation_aspect', label: 'Aspect', type: 'select',
        options: [{ value: '16:9', label: '16:9' }, { value: '4:3', label: '4:3' }, { value: 'other', label: 'Other' }],
      },
      { key: 'presenter', label: 'Presenter', type: 'text' },
      { key: 'presented_on', label: 'Presented', type: 'datetime' },
    ],
    extensions: ['ppt', 'pptx', 'key', 'odp', 'pps', 'ppsx'],
    mimePrefixes: [],
    mimeExact: [
      'application/vnd.ms-powerpoint',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'application/vnd.openxmlformats-officedocument.presentationml.slideshow',
      'application/x-iwork-keynote-sffkey', 'application/vnd.apple.keynote',
      'application/vnd.oasis.opendocument.presentation',
    ],
    media: false,
    reclassifiable: true,
    contentIsCode: false,
    contentHead: false,
    facts: ['slide_count', 'presentation_provider'],
    empty: {
      headline: 'No deck attached.',
      sub: 'Upload the file or paste a Google Slides link — the deck shows here.',
    },
  },
  {
    id: 'design',
    label: 'Design',
    glyph: '✎',
    accent: '244, 63, 94',
    family: 'files',
    hint: 'Figma, Sketch, XD, Photoshop, Illustrator',
    aliases: ['design-file', 'figma', 'sketch', 'mockup', 'wireframe', 'prototype', 'psd'],
    create: {
      modes: ['upload', 'link'],
      accept: '.fig,.sketch,.xd,.psd,.ai,.afdesign,.svg,.pdf',
      linkPlaceholder: 'https://www.figma.com/design/…',
      linkHint: 'A Figma, Sketch Cloud, XD, or Canva link — Figma files embed inline',
    },
    fields: [
      {
        key: 'design_tool', label: 'Tool', type: 'select',
        options: [
          { value: 'figma', label: 'Figma' }, { value: 'sketch', label: 'Sketch' }, { value: 'xd', label: 'Adobe XD' },
          { value: 'photoshop', label: 'Photoshop' }, { value: 'illustrator', label: 'Illustrator' },
          { value: 'canva', label: 'Canva' }, { value: 'other', label: 'Other' },
        ],
      },
      {
        key: 'design_status', label: 'Status', type: 'select',
        options: [
          { value: 'exploration', label: 'Exploration' }, { value: 'draft', label: 'Draft' },
          { value: 'review', label: 'In review' }, { value: 'final', label: 'Final' },
        ],
      },
      { key: 'design_version', label: 'Version', type: 'text', placeholder: 'v3' },
      { key: 'design_frames', label: 'Frames', type: 'number' },
      { key: 'design_embed_url', label: 'Embed', type: 'url', readOnly: true },
    ],
    extensions: ['fig', 'sketch', 'xd', 'psd', 'ai', 'afdesign', 'afphoto'],
    mimePrefixes: [],
    mimeExact: ['image/vnd.adobe.photoshop', 'application/x-photoshop', 'application/illustrator', 'application/x-sketch'],
    media: false,
    reclassifiable: true,
    contentIsCode: false,
    contentHead: false,
    facts: ['design_tool', 'design_status'],
    empty: {
      headline: 'No design file attached.',
      sub: 'Upload the file or paste a Figma link — Figma files embed here.',
    },
  },
  {
    id: 'notebook',
    label: 'Notebook',
    glyph: '◉',
    accent: '234, 179, 8',
    family: 'files',
    hint: 'A Jupyter notebook (.ipynb)',
    aliases: ['ipynb', 'jupyter', 'colab'],
    create: { modes: ['upload'], accept: '.ipynb' },
    fields: [
      { key: 'notebook_kernel', label: 'Kernel', type: 'text', readOnly: true },
      { key: 'notebook_language', label: 'Language', type: 'text', readOnly: true },
      { key: 'notebook_cells', label: 'Cells', type: 'number', readOnly: true },
      { key: 'notebook_code_cells', label: 'Code cells', type: 'number', readOnly: true },
    ],
    extensions: ['ipynb'],
    mimePrefixes: [],
    mimeExact: ['application/x-ipynb+json'],
    media: false,
    reclassifiable: true,
    contentIsCode: false,
    contentHead: true,
    facts: ['notebook_language', 'notebook_cells'],
    empty: {
      headline: 'No notebook attached.',
      sub: 'Upload an .ipynb — its cells render here.',
    },
  },
  {
    id: 'flow',
    label: 'Flow',
    glyph: '⧉',
    accent: '124, 58, 237',
    family: 'files',
    hint: 'A GSX Designer flow export, or a link to the flow',
    aliases: ['flowsource', 'gsx-flow', 'designer-flow', 'flow-export'],
    create: {
      modes: ['upload', 'link'],
      accept: '.json',
      linkPlaceholder: 'https://studio.edison.onereach.ai/flows/<bot>/<flow>',
      linkHint: 'The flow in GSX Designer — opens signed in from here',
    },
    fields: [
      { key: 'flow_id', label: 'Flow id', type: 'text' },
      { key: 'flow_bot_id', label: 'Bot id', type: 'text' },
      {
        key: 'flow_env', label: 'Environment', type: 'select',
        options: [
          { value: 'edison', label: 'Edison' }, { value: 'staging', label: 'Staging' },
          { value: 'production', label: 'Production' }, { value: 'other', label: 'Other' },
        ],
      },
      {
        key: 'flow_status', label: 'Status', type: 'select',
        options: [
          { value: 'draft', label: 'Draft' }, { value: 'armed', label: 'Armed' }, { value: 'retired', label: 'Retired' },
        ],
      },
      { key: 'flow_step_count', label: 'Steps', type: 'number', readOnly: true },
    ],
    extensions: [],
    mimePrefixes: [],
    mimeExact: [],
    media: false,
    reclassifiable: true,
    contentIsCode: true,
    contentHead: true,
    facts: ['flow_env', 'flow_step_count'],
    empty: {
      headline: 'No flow saved for this item.',
      sub: 'Upload a flow export or paste its Designer link.',
    },
  },
  {
    id: 'other',
    label: 'File',
    glyph: '▪',
    accent: '120, 113, 108',
    family: 'files',
    hint: 'Any other file — archives, installers, unknown formats',
    aliases: ['file', 'archive', 'binary', 'unknown', 'attachment', 'zip'],
    create: { modes: ['upload'], pane: 'upload' },
    fields: [
      { key: 'filename', label: 'File name', type: 'text', readOnly: true },
    ],
    extensions: ['zip', 'tar', 'gz', 'tgz', '7z', 'rar', 'dmg', 'pkg', 'exe', 'msi', 'bin', 'iso'],
    mimePrefixes: [],
    mimeExact: ['application/zip', 'application/x-tar', 'application/gzip', 'application/x-7z-compressed', 'application/octet-stream'],
    media: false,
    reclassifiable: true,
    contentIsCode: false,
    contentHead: false,
    facts: ['filename'],
    empty: {
      headline: 'This asset has no content yet.',
      sub: 'Add a transcript, file, or link to make it useful. Authors and tags can be set independently.',
    },
  },
  // ── Links ───────────────────────────────────────────────────────────
  {
    id: 'url',
    label: 'Web link',
    glyph: '↗',
    accent: '59, 130, 246',
    family: 'links',
    hint: 'A page, a doc, a repo — anything with an address',
    aliases: ['link', 'web', 'website', 'bookmark', 'web-link', 'webpage'],
    create: {
      modes: ['link'],
      linkPlaceholder: 'https://…',
      linkHint: 'The title fills in from the address when you leave it blank',
    },
    fields: [
      { key: 'link_domain', label: 'Domain', type: 'text', readOnly: true },
      {
        key: 'link_kind', label: 'Kind', type: 'select',
        options: [
          { value: 'article', label: 'Article' }, { value: 'docs', label: 'Docs' }, { value: 'repo', label: 'Repository' },
          { value: 'app', label: 'App' }, { value: 'reference', label: 'Reference' }, { value: 'other', label: 'Other' },
        ],
      },
      { key: 'link_platform', label: 'Platform', type: 'text', placeholder: 'GitHub, Notion, Confluence…' },
    ],
    extensions: ['url', 'webloc'],
    mimePrefixes: [],
    mimeExact: [],
    media: false,
    reclassifiable: true,
    contentIsCode: false,
    contentHead: false,
    facts: ['link_domain'],
    empty: {
      headline: 'No link saved.',
      sub: 'Add the address and it appears here.',
    },
  },
  {
    id: 'monitor',
    label: 'Web monitor',
    glyph: '◎',
    accent: '74, 158, 255',
    family: 'links',
    hint: 'Watch a page for changes',
    aliases: ['web-monitor', 'website-monitor', 'watch', 'page-monitor', 'monitor-url'],
    create: {
      modes: ['form'],
      notesLabel: 'What to watch for',
      notesPlaceholder: 'Price changes on the pricing table, new releases on the changelog…',
    },
    fields: [
      { key: 'monitor_url', label: 'Address', type: 'url', required: true, placeholder: 'https://…' },
      { key: 'monitor_selector', label: 'Selector', type: 'text', placeholder: 'body', hint: 'CSS selector to watch; the whole page when blank' },
      {
        key: 'monitor_interval', label: 'Check every', type: 'select',
        options: [
          { value: '15m', label: '15 minutes' }, { value: '1h', label: 'Hour' }, { value: '6h', label: '6 hours' },
          { value: '24h', label: 'Day' }, { value: '7d', label: 'Week' },
        ],
      },
      { key: 'monitor_ai_descriptions', label: 'Describe changes with AI', type: 'boolean' },
      {
        key: 'monitor_status', label: 'Status', type: 'select', readOnly: true,
        options: [{ value: 'active', label: 'Active' }, { value: 'paused', label: 'Paused' }, { value: 'error', label: 'Error' }],
      },
      { key: 'monitor_last_checked', label: 'Last checked', type: 'datetime', readOnly: true },
      { key: 'monitor_change_count', label: 'Changes seen', type: 'number', readOnly: true },
    ],
    extensions: [],
    mimePrefixes: [],
    mimeExact: [],
    media: false,
    reclassifiable: true,
    contentIsCode: false,
    contentHead: true,
    facts: ['monitor_interval', 'monitor_change_count'],
    empty: {
      headline: 'Nothing watched yet.',
      sub: 'Set the address to watch — checks run in the full Onereach app and land here.',
    },
  },
  // ── Capabilities ────────────────────────────────────────────────────
  {
    id: 'agent',
    label: 'Agent',
    glyph: '✦',
    accent: '240, 164, 75',
    family: 'capabilities',
    hint: 'From the library, or converted from OKF',
    aliases: ['bot', 'assistant', 'ai-agent'],
    create: { modes: ['form'], pane: 'agent' },
    fields: [
      { key: 'agent_owner', label: 'Owner', type: 'text' },
      {
        key: 'agent_status', label: 'Status', type: 'select',
        options: [{ value: 'draft', label: 'Draft' }, { value: 'live', label: 'Live' }, { value: 'retired', label: 'Retired' }],
      },
    ],
    extensions: [],
    mimePrefixes: [],
    mimeExact: [],
    media: false,
    reclassifiable: true,
    contentIsCode: false,
    contentHead: false,
    facts: ['agent_status'],
    empty: {
      headline: 'No definition saved for this agent.',
      sub: 'Its OKF body renders here once it is set.',
    },
  },
  {
    id: 'tool',
    label: 'Tool',
    glyph: '⚙',
    accent: '2, 132, 199',
    family: 'capabilities',
    hint: 'An MCP server, an API, a skill, a scraper agents can call',
    aliases: ['data-source', 'datasource', 'mcp', 'api', 'skill', 'connector', 'integration', 'mcp-server'],
    create: {
      modes: ['form'],
      notesLabel: 'How to use it',
      notesPlaceholder: 'What it does, the calls that matter, example requests — Markdown or an OpenAPI excerpt',
    },
    fields: [
      { key: 'tool_type', label: 'Type', type: 'select', options: TOOL_TYPE_OPTIONS, required: true },
      { key: 'tool_endpoint', label: 'Endpoint', type: 'url', placeholder: 'https://…/mcp', hint: 'Where the tool answers' },
      {
        key: 'tool_transport', label: 'Transport', type: 'select',
        options: [
          { value: 'http', label: 'HTTP' }, { value: 'sse', label: 'SSE' }, { value: 'stdio', label: 'stdio' },
          { value: 'websocket', label: 'WebSocket' },
        ],
      },
      { key: 'tool_auth', label: 'Auth', type: 'select', options: AUTH_OPTIONS, hint: 'The method only — never the secret' },
      { key: 'tool_operations', label: 'Operations', type: 'list', placeholder: 'read, list, create' },
      { key: 'tool_spec_url', label: 'Spec', type: 'url', placeholder: 'https://…/openapi.json', hint: 'OpenAPI document or MCP manifest' },
      { key: 'tool_docs_url', label: 'Docs', type: 'url', placeholder: 'https://…/docs' },
      {
        key: 'tool_status', label: 'Status', type: 'select',
        options: [
          { value: 'draft', label: 'Draft' }, { value: 'available', label: 'Available' }, { value: 'deprecated', label: 'Deprecated' },
        ],
      },
      { key: 'tool_owner', label: 'Owner', type: 'text' },
      { key: 'tool_channels', label: 'Channels', type: 'list', placeholder: 'web, slack, voice' },
    ],
    extensions: [],
    mimePrefixes: [],
    mimeExact: [],
    media: false,
    reclassifiable: true,
    contentIsCode: false,
    contentHead: true,
    facts: ['tool_type', 'tool_status'],
    empty: {
      headline: 'No notes saved for this tool.',
      sub: 'Its type and endpoint sit in Details; add how to call it here.',
    },
  },
  {
    id: 'knowledge',
    label: 'Knowledge',
    glyph: '◆',
    accent: '52, 211, 153',
    family: 'capabilities',
    hint: 'What a model knows — domains and an endpoint',
    aliases: ['knowledge-model', 'kb', 'knowledge-base'],
    create: { modes: ['form'], pane: 'knowledge' },
    fields: [
      { key: 'knowledge_endpoint', label: 'Endpoint', type: 'url', placeholder: 'https://…/query' },
      { key: 'knowledge_owner', label: 'Owner', type: 'text' },
    ],
    extensions: [],
    mimePrefixes: [],
    mimeExact: [],
    media: false,
    reclassifiable: true,
    contentIsCode: false,
    contentHead: true,
    facts: ['knowledge_endpoint'],
    empty: {
      headline: 'Nothing recorded about what this model knows.',
      sub: 'Describe its domains — bullet lines become chips.',
    },
  },
  // ── Structured ──────────────────────────────────────────────────────
  {
    id: 'journey',
    label: 'Journey',
    glyph: '➔',
    accent: '96, 156, 255',
    family: 'structured',
    hint: 'A customer journey or service blueprint, stage by stage',
    aliases: ['journey-map', 'service-blueprint', 'customer-journey', 'blueprint'],
    create: {
      modes: ['paste'],
      bodyLabel: 'Stages',
      bodyPlaceholder: '## 1. Discover\nHow the customer first hears of us…\n\n## 2. Evaluate\n…',
      bodyHint: 'One `## N. Stage` heading per stage — the Journey Map Builder reads the same shape',
    },
    fields: [
      { key: 'journey_persona', label: 'Persona', type: 'text', placeholder: 'New admin, returning buyer…' },
      { key: 'journey_goal', label: 'Goal', type: 'text' },
      { key: 'journey_stage_count', label: 'Stages', type: 'number', readOnly: true },
    ],
    extensions: [],
    mimePrefixes: [],
    mimeExact: [],
    media: false,
    reclassifiable: true,
    contentIsCode: false,
    contentHead: true,
    facts: ['journey_persona', 'journey_stage_count'],
    empty: {
      headline: 'No stages saved for this journey.',
      sub: 'Write one `## N. Stage` heading per stage, or open it in the Journey Map Builder.',
    },
  },
  {
    id: 'meeting',
    label: 'Meeting',
    glyph: '◷',
    accent: '167, 139, 250',
    family: 'structured',
    hint: 'When, who, the recording, the notes',
    aliases: ['wiser-meeting', 'call', 'session', 'standup', 'meeting-notes'],
    create: {
      modes: ['form'],
      notesLabel: 'Notes',
      notesPlaceholder: 'Agenda, decisions, follow-ups — Markdown',
    },
    fields: [
      { key: 'meeting_at', label: 'When', type: 'datetime', required: true },
      { key: 'meeting_duration', label: 'Duration', type: 'duration' },
      { key: 'meeting_attendees', label: 'Attendees', type: 'list', placeholder: 'Ada, Grace, Linus' },
      { key: 'meeting_organizer', label: 'Organizer', type: 'text' },
      { key: 'meeting_location', label: 'Where', type: 'text', placeholder: 'Zoom, Room 4…' },
      { key: 'meeting_recording_url', label: 'Recording', type: 'url', placeholder: 'https://…' },
      { key: 'meeting_transcript_url', label: 'Transcript', type: 'url', placeholder: 'https://…' },
    ],
    extensions: [],
    mimePrefixes: [],
    mimeExact: [],
    media: false,
    reclassifiable: true,
    contentIsCode: false,
    contentHead: true,
    facts: ['meeting_at', 'meeting_attendees'],
    empty: {
      headline: 'No notes saved for this meeting.',
      sub: 'When, attendees, and the recording sit in Details; add the notes here.',
    },
  },
  {
    id: 'transcript',
    label: 'Transcript',
    glyph: '“',
    accent: '45, 212, 191',
    family: 'structured',
    hint: 'Detected when pasted or uploaded — turns, speakers',
    aliases: ['recorder-transcript', 'wiser-transcript', 'meeting-transcript', 'vtt', 'srt'],
    create: null,
    fields: [
      { key: 'transcript_format', label: 'Format', type: 'text', readOnly: true },
      { key: 'transcript_turns', label: 'Turns', type: 'number', readOnly: true },
      { key: 'transcript_speakers', label: 'Speakers', type: 'list' },
      { key: 'transcript_source', label: 'Source', type: 'text', placeholder: 'Zoom, Otter, WISER…' },
    ],
    extensions: ['vtt', 'srt'],
    mimePrefixes: [],
    mimeExact: ['text/vtt', 'application/x-subrip'],
    media: false,
    reclassifiable: true,
    contentIsCode: false,
    contentHead: true,
    facts: ['transcript_turns', 'transcript_speakers'],
    empty: {
      headline: 'No transcript body saved.',
      sub: 'Paste or upload the transcript — turns and speakers are read from it.',
    },
  },
  // ── System (made elsewhere) ─────────────────────────────────────────
  {
    id: 'playbook',
    label: 'Playbook',
    glyph: '▤',
    accent: '63, 120, 192',
    family: 'system',
    hint: 'Made in WISER Playbooks',
    aliases: ['riff', 'plan', 'wiser-playbook'],
    create: null,
    fields: [],
    extensions: [],
    mimePrefixes: [],
    mimeExact: [],
    media: false,
    reclassifiable: false,
    contentIsCode: false,
    contentHead: true,
    facts: [],
    empty: {
      headline: 'This playbook has no plan text yet.',
      sub: 'Open it in WISER Playbooks to write the plan.',
    },
  },
  {
    id: 'ticket',
    label: 'Ticket',
    glyph: '◫',
    accent: '148, 163, 184',
    family: 'system',
    hint: 'Decomposed from a playbook',
    aliases: ['task', 'issue'],
    create: null,
    fields: [],
    extensions: [],
    mimePrefixes: [],
    mimeExact: [],
    media: false,
    reclassifiable: false,
    contentIsCode: false,
    contentHead: false,
    facts: [],
    empty: {
      headline: 'This ticket has no body.',
      sub: 'Its status and priority sit above; add detail in the description.',
    },
  },
];

// ─── Lookups ──────────────────────────────────────────────────────────

const BY_ID: ReadonlyMap<string, AssetKindSpec> = new Map(SPECS.map((s) => [s.id, s]));

const BY_ALIAS: ReadonlyMap<string, ItemKind> = (() => {
  const m = new Map<string, ItemKind>();
  for (const s of SPECS) {
    m.set(s.id, s.id);
    for (const a of s.aliases) m.set(a.toLowerCase(), s.id);
  }
  return m;
})();

const BY_EXTENSION: ReadonlyMap<string, ItemKind> = (() => {
  const m = new Map<string, ItemKind>();
  for (const s of SPECS) for (const e of s.extensions) if (!m.has(e)) m.set(e, s.id);
  return m;
})();

const BY_MIME: ReadonlyMap<string, ItemKind> = (() => {
  const m = new Map<string, ItemKind>();
  for (const s of SPECS) for (const t of s.mimeExact) if (!m.has(t)) m.set(t, s.id);
  return m;
})();

/** Every kind, in picker order (family order, then table order). */
export const ASSET_KINDS: readonly AssetKindSpec[] = SPECS;

export const FAMILY_ORDER: readonly AssetFamily[] = ['write', 'files', 'links', 'capabilities', 'structured', 'system'];

export const FAMILY_LABELS: Readonly<Record<AssetFamily, string>> = {
  write: 'Write',
  files: 'Files',
  links: 'Links',
  capabilities: 'Capabilities',
  structured: 'Structured',
  system: 'Made elsewhere',
};

/** The spec for a kind; unknown strings fall back to `other`. */
export function kindSpec(kind: string): AssetKindSpec {
  return BY_ID.get(kind) ?? (BY_ID.get('other') as AssetKindSpec);
}

export function hasKind(kind: string): kind is ItemKind {
  return BY_ID.has(kind);
}

export function kindLabel(kind: string): string {
  const spec = BY_ID.get(kind);
  return spec !== undefined ? spec.label : 'Other';
}

export function kindGlyph(kind: string): string {
  const spec = BY_ID.get(kind);
  return spec !== undefined ? spec.glyph : '▪';
}

export function kindAccent(kind: string): string {
  return kindSpec(kind).accent;
}

export function isMediaKind(kind: string): boolean {
  return kindSpec(kind).media;
}

export function isCodeContentKind(kind: string): boolean {
  return kindSpec(kind).contentIsCode;
}

/** Kinds the user may pick in the dialog, grouped by family. */
export function creatableKinds(): readonly AssetKindSpec[] {
  return SPECS.filter((s) => s.create !== null);
}

export function kindsByFamily(family: AssetFamily): readonly AssetKindSpec[] {
  return SPECS.filter((s) => s.family === family);
}

/** Kinds offered by the reclassify dropdown. */
export function reclassifiableKinds(): readonly AssetKindSpec[] {
  return SPECS.filter((s) => s.reclassifiable);
}

/** Typed fields for a kind (the Details section), in display order. */
export function kindFields(kind: string): readonly FieldSpec[] {
  return kindSpec(kind).fields;
}

/** The set of metadata keys the Details section owns for a kind. */
export function typedMetadataKeys(kind: string): ReadonlySet<string> {
  return new Set(kindSpec(kind).fields.map((f) => f.key));
}

/**
 * Read-side normalisation. A value written by any app — Lite's own
 * kind ids, the full app's `assetType` / `fileCategory` / `jsonSubtype`
 * words, older spellings — resolves to a Lite kind. Unknown → `other`.
 */
export function normalizeKind(raw: unknown): ItemKind {
  if (typeof raw !== 'string') return 'other';
  const key = raw.trim().toLowerCase();
  if (key.length === 0) return 'other';
  return BY_ALIAS.get(key) ?? 'other';
}

/** Lower-case extension of a file name, or '' when it has none. */
export function fileExtension(name: string): string {
  const m = /\.([a-z0-9]{1,8})$/i.exec((name ?? '').trim());
  return m !== null ? (m[1] ?? '').toLowerCase() : '';
}

/**
 * Which kind a file is. Order: a name pattern that beats extensions
 * (`flowsource_*.json` is a flow, not data), then the extension table,
 * then the MIME prefix (`image/`, `audio/`, `video/`), then exact MIME,
 * then `text/*` → document, else `other`.
 */
export function inferKindFromFile(file: { name?: string; type?: string }): ItemKind {
  const name = typeof file.name === 'string' ? file.name.trim() : '';
  const mime = typeof file.type === 'string' ? file.type.trim().toLowerCase() : '';
  if (/^flowsource[_-]/i.test(name)) return 'flow';
  const ext = fileExtension(name);
  if (ext.length > 0) {
    const byExt = BY_EXTENSION.get(ext);
    if (byExt !== undefined) return byExt;
    if (ext === 'json') return 'data';
  }
  if (mime.length > 0) {
    for (const s of SPECS) {
      if (s.mimePrefixes.some((p) => mime.startsWith(p) && p !== 'text/')) return s.id;
    }
    const exact = BY_MIME.get(mime);
    if (exact !== undefined) return exact;
    if (mime.startsWith('text/')) return 'document';
    if (mime === 'application/json') return 'data';
  }
  return 'other';
}

/** MIME-only inference — the shape the upload path used before ADR-098. */
export function inferKindFromMime(mime: string): ItemKind {
  return inferKindFromFile({ name: '', type: mime });
}

/**
 * Sniff a JSON body for the shapes the full app recognises
 * (`detectJsonSubtype`): a journey map, a style guide, an AI
 * conversation export, a Jupyter notebook, a GSX flow export. Returns
 * the kind, or null when it is just data.
 */
export function sniffJsonKind(text: string): ItemKind | null {
  const head = text.trimStart();
  if (head.length === 0 || (head[0] !== '{' && head[0] !== '[')) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const o = parsed as Record<string, unknown>;
  const has = (k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
  if (Array.isArray(o['cells']) && (has('nbformat') || has('metadata'))) return 'notebook';
  if (has('colors') && has('typography')) return 'styleguide';
  if (Array.isArray(o['messages'])) {
    const first = (o['messages'] as unknown[])[0];
    if (
      first !== undefined &&
      first !== null &&
      typeof first === 'object' &&
      ('role' in (first as Record<string, unknown>) || 'author' in (first as Record<string, unknown>))
    ) {
      return 'conversation';
    }
  }
  if (has('journeyData') || (has('stages') && has('persona'))) return 'journey';
  if (has('trees') || (has('flowId') && has('botId')) || (has('steps') && has('templateId'))) return 'flow';
  return null;
}

/** Kinds whose inline content the list projections head (`contentHead`), in registry order. */
export function contentHeadKinds(): readonly ItemKind[] {
  return SPECS.filter((s) => s.contentHead).map((s) => s.id);
}

/** The `ItemKind` union and this table must agree — pinned by tests. */
export function registryKinds(): readonly ItemKind[] {
  return SPECS.map((s) => s.id);
}

export function unionKinds(): readonly ItemKind[] {
  return ITEM_KINDS;
}
