/**
 * Link embeds — what a pasted address IS, and how to show it inline
 * (ADR-098).
 *
 * A link is rarely "just a URL": a YouTube address is a video, a
 * Google Slides address is a deck, a Figma address is a design. This
 * module recognises the providers the Spaces window can embed and
 * turns a share link into the embed form each provider publishes,
 * plus the kind it implies, so the Add-asset dialog can suggest the
 * kind and the detail rail can play the thing in place.
 *
 * Pure and defensive: unknown addresses come back as `{ provider:
 * 'link' }` with no embed — never a throw. Exported for tests.
 */

import type { ItemKind } from './types.js';

export type LinkProvider =
  | 'youtube'
  | 'vimeo'
  | 'loom'
  | 'google-slides'
  | 'google-docs'
  | 'google-sheets'
  | 'keynote'
  | 'canva'
  | 'pitch'
  | 'figma'
  | 'sketch'
  | 'adobe-xd'
  | 'github'
  | 'gsx-designer'
  | 'video-file'
  | 'audio-file'
  | 'image-file'
  | 'link';

export interface LinkInfo {
  /** The address, trimmed, with an `https://` default when the scheme was left off. */
  url: string;
  provider: LinkProvider;
  /** Provider-side identifier (video id, document id, file key) when known. */
  id: string | null;
  /** An address that renders in an `<iframe>` (or `<video>`/`<img>` for direct files), or null. */
  embedUrl: string | null;
  /** The kind this address most likely is. */
  kind: ItemKind;
  /** Host without `www.`. */
  domain: string;
  /** A human label for the provider ("YouTube", "Google Slides"). */
  providerLabel: string;
}

const PROVIDER_LABELS: Readonly<Record<LinkProvider, string>> = {
  youtube: 'YouTube',
  vimeo: 'Vimeo',
  loom: 'Loom',
  'google-slides': 'Google Slides',
  'google-docs': 'Google Docs',
  'google-sheets': 'Google Sheets',
  keynote: 'Keynote',
  canva: 'Canva',
  pitch: 'Pitch',
  figma: 'Figma',
  sketch: 'Sketch',
  'adobe-xd': 'Adobe XD',
  github: 'GitHub',
  'gsx-designer': 'GSX Designer',
  'video-file': 'Video file',
  'audio-file': 'Audio file',
  'image-file': 'Image file',
  link: 'Link',
};

const VIDEO_EXT = /\.(mp4|webm|mov|m4v|ogv)(\?.*)?$/i;
const AUDIO_EXT = /\.(mp3|wav|m4a|aac|ogg|oga|flac|opus)(\?.*)?$/i;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|avif|bmp)(\?.*)?$/i;

/**
 * The only hosts the Spaces window will ever put in an <iframe>: the
 * embed endpoints of the providers describeLink() knows. Mirrored
 * verbatim in spaces.html's `frame-src` (pinned by
 * spaces-embed-csp.test.ts). A metadata value naming any other host is
 * never framed — Asset.metadata is writable by every member of a Space
 * and by other apps (2026-09-09 pre-release review of ADR-098).
 */
export const EMBED_HOSTS: readonly string[] = [
  'www.youtube-nocookie.com',
  'player.vimeo.com',
  'www.loom.com',
  'docs.google.com',
  'www.canva.com',
  'pitch.com',
  'www.figma.com',
];

/**
 * An address safe to frame: https, on an allowlisted embed host. Null
 * for everything else, including plain http and lookalike hosts.
 */
export function safeEmbedUrl(candidate: unknown): string | null {
  if (typeof candidate !== 'string') return null;
  const url = normalizeHttpUrl(candidate);
  if (url === null) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:') return null;
  return EMBED_HOSTS.includes(u.hostname.toLowerCase()) ? url : null;
}

/** Normalise a typed address: trim, default the scheme, reject non-http. */
export function normalizeHttpUrl(raw: string): string | null {
  const t = (raw ?? '').trim();
  if (t.length === 0) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(t) ? t : `https://${t}`;
  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.hostname.length === 0 || !u.hostname.includes('.')) return null;
  return u.toString();
}

export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return '';
  }
}

function youtubeId(u: URL): string | null {
  const host = u.hostname.replace(/^www\./i, '').toLowerCase();
  if (host === 'youtu.be') return u.pathname.slice(1).split('/')[0] || null;
  if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com') {
    const v = u.searchParams.get('v');
    if (v !== null && v.length > 0) return v;
    const m = /^\/(embed|shorts|live|v)\/([A-Za-z0-9_-]{6,})/.exec(u.pathname);
    if (m !== null) return m[2] ?? null;
  }
  return null;
}

/**
 * Describe an address. The kind is a suggestion — the dialog offers
 * it, the user can still file the link as whatever they like.
 */
export function describeLink(raw: string): LinkInfo | null {
  const url = normalizeHttpUrl(raw);
  if (url === null) return null;
  const u = new URL(url);
  const host = u.hostname.replace(/^www\./i, '').toLowerCase();
  const domain = host;
  const path = u.pathname;
  const make = (
    provider: LinkProvider,
    kind: ItemKind,
    id: string | null,
    embedUrl: string | null
  ): LinkInfo => ({ url, provider, id, embedUrl, kind, domain, providerLabel: PROVIDER_LABELS[provider] });

  // ── Video ───────────────────────────────────────────────────────────
  const yt = youtubeId(u);
  if (yt !== null) return make('youtube', 'video', yt, `https://www.youtube-nocookie.com/embed/${yt}`);
  if (host === 'vimeo.com' || host === 'player.vimeo.com') {
    const m = /\/(?:video\/)?(\d{6,})/.exec(path);
    if (m !== null) return make('vimeo', 'video', m[1] ?? null, `https://player.vimeo.com/video/${m[1]}`);
  }
  if (host === 'loom.com' || host.endsWith('.loom.com')) {
    const m = /\/(?:share|embed)\/([a-f0-9]{16,})/i.exec(path);
    if (m !== null) return make('loom', 'video', m[1] ?? null, `https://www.loom.com/embed/${m[1]}`);
  }
  // ── Decks ───────────────────────────────────────────────────────────
  if (host === 'docs.google.com' && path.startsWith('/presentation/')) {
    const m = /\/presentation\/d\/(?:e\/)?([A-Za-z0-9_-]{10,})/.exec(path);
    const id = m !== null ? (m[1] ?? null) : null;
    // A published deck (/d/e/<id>/pub) embeds as /d/e/<id>/embed; a
    // private one as /d/<id>/embed and only for viewers who can open it.
    const embed = id !== null ? (path.includes('/d/e/') ? `https://docs.google.com/presentation/d/e/${id}/embed` : `https://docs.google.com/presentation/d/${id}/embed`) : null;
    return make('google-slides', 'presentation', id, embed);
  }
  if (host === 'docs.google.com' && path.startsWith('/document/')) {
    const m = /\/document\/d\/(?:e\/)?([A-Za-z0-9_-]{10,})/.exec(path);
    return make('google-docs', 'document', m !== null ? (m[1] ?? null) : null, null);
  }
  if (host === 'docs.google.com' && path.startsWith('/spreadsheets/')) {
    const m = /\/spreadsheets\/d\/(?:e\/)?([A-Za-z0-9_-]{10,})/.exec(path);
    return make('google-sheets', 'data', m !== null ? (m[1] ?? null) : null, null);
  }
  if (host === 'icloud.com' && path.startsWith('/keynote/')) {
    const m = /\/keynote\/([A-Za-z0-9_-]{10,})/.exec(path);
    return make('keynote', 'presentation', m !== null ? (m[1] ?? null) : null, null);
  }
  if (host === 'canva.com' || host.endsWith('.canva.com')) {
    const m = /\/design\/([A-Za-z0-9_-]{6,})/.exec(path);
    const id = m !== null ? (m[1] ?? null) : null;
    return make('canva', 'presentation', id, id !== null ? `https://www.canva.com/design/${id}/view?embed` : null);
  }
  if (host === 'pitch.com' || host.endsWith('.pitch.com')) {
    const m = /\/(?:public|v)\/([A-Za-z0-9-]{6,})/.exec(path);
    const id = m !== null ? (m[1] ?? null) : null;
    return make('pitch', 'presentation', id, id !== null ? `https://pitch.com/embed/${id}` : null);
  }
  // ── Design ──────────────────────────────────────────────────────────
  if (host === 'figma.com' || host.endsWith('.figma.com')) {
    const m = /\/(?:file|design|proto|board)\/([A-Za-z0-9]{10,})/.exec(path);
    const id = m !== null ? (m[1] ?? null) : null;
    return make('figma', 'design', id, `https://www.figma.com/embed?embed_host=onereach&url=${encodeURIComponent(url)}`);
  }
  if (host === 'sketch.com' || host.endsWith('.sketch.com') || host === 'sketch.cloud') {
    return make('sketch', 'design', null, null);
  }
  if (host === 'xd.adobe.com') return make('adobe-xd', 'design', null, null);
  // ── Code / flows ────────────────────────────────────────────────────
  if (host === 'github.com' || host === 'gist.github.com') return make('github', 'url', null, null);
  if (/^studio\.[a-z0-9-]+\.onereach\.ai$/.test(host) && path.startsWith('/flows/')) {
    const m = /^\/flows\/([^/]+)\/([^/?#]+)/.exec(path);
    return make('gsx-designer', 'flow', m !== null ? (m[2] ?? null) : null, null);
  }
  // ── Direct files ────────────────────────────────────────────────────
  if (VIDEO_EXT.test(path)) return make('video-file', 'video', null, url);
  if (AUDIO_EXT.test(path)) return make('audio-file', 'audio', null, url);
  if (IMAGE_EXT.test(path)) return make('image-file', 'image', null, url);
  return make('link', 'url', null, null);
}

/**
 * A title for a bare link when the user left the field empty: the
 * last meaningful path segment, de-slugged, or the domain.
 */
/** Path words that name a mode, not the thing (`/edit`, `/view`, `/d/`). */
const NOISE_SEGMENTS: ReadonlySet<string> = new Set([
  'edit', 'view', 'pub', 'embed', 'preview', 'share', 'index', 'home', 'd', 'e', 'file', 'design', 'proto',
  'watch', 'v', 'p', 'u', 'a', 'w', 'html', 'htm', 'php', 'aspx', 'default', 'public', 'files', 'document',
  'presentation', 'spreadsheets', 'flows', 'folder', 'folders', 'drive',
]);

/** Does a path segment read as an id rather than a name? */
function looksLikeId(seg: string): boolean {
  if (/^[0-9a-f-]{12,}$/i.test(seg)) return true;
  if (/^[A-Za-z0-9_-]{20,}$/.test(seg) && !/[-_ ]/.test(seg.slice(1, -1).replace(/[A-Za-z0-9]/g, ''))) {
    // Long, no separators, mixed case/digits: Google / Figma / Loom ids.
    return /\d/.test(seg) && /[A-Za-z]/.test(seg);
  }
  return /^\d+$/.test(seg);
}

export function titleFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const segs = u.pathname.split('/').filter((s) => s.length > 0);
    // Walk back from the end to the last segment that is a name.
    for (let i = segs.length - 1; i >= 0; i -= 1) {
      const raw = decodeURIComponent(segs[i] ?? '');
      const cleaned = raw
        .replace(/\.[a-z0-9]{1,5}$/i, '')
        .replace(/[-_+]+/g, ' ')
        .trim();
      if (cleaned.length < 3) continue;
      if (NOISE_SEGMENTS.has(cleaned.toLowerCase())) continue;
      if (looksLikeId(raw)) continue;
      return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
    }
    return u.hostname.replace(/^www\./i, '');
  } catch {
    return url;
  }
}

/** Metadata the link implies — written on create so the tile can say what it is. */
export function linkMetadata(info: LinkInfo): Record<string, string> {
  const out: Record<string, string> = { link_domain: info.domain };
  switch (info.kind) {
    case 'video':
      out['video_provider'] = info.providerLabel;
      if (info.id !== null) out['video_id'] = info.id;
      if (info.embedUrl !== null) out['video_embed_url'] = info.embedUrl;
      break;
    case 'presentation':
      out['presentation_provider'] = info.providerLabel;
      if (info.embedUrl !== null) out['presentation_embed_url'] = info.embedUrl;
      break;
    case 'design':
      out['design_tool'] = info.provider === 'figma' ? 'figma' : info.provider === 'sketch' ? 'sketch' : info.provider === 'adobe-xd' ? 'xd' : 'other';
      if (info.embedUrl !== null) out['design_embed_url'] = info.embedUrl;
      break;
    case 'flow':
      if (info.id !== null) out['flow_id'] = info.id;
      break;
    case 'audio':
    case 'image':
      break;
    default:
      if (info.provider === 'github') out['link_platform'] = 'GitHub';
      break;
  }
  return out;
}
