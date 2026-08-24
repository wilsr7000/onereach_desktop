/**
 * Riff sheet → tile description (2026-08-20).
 *
 * WISER riff playbooks sync to the graph as `:Playbook` nodes with NO
 * content and NO description — the whole sheet lives in KV
 * (`riff:sheets/<id>`), a multi-MB JSON with chat history, versions,
 * chunks… and, usefully, `summary.text`: a real one-paragraph account
 * of what the playbook is. This module extracts that paragraph (with
 * an HTML-content fallback) so the enrichment pass in `main.ts` can
 * write it onto the graph node, where the tile — and every other
 * surface that reads the graph — picks it up.
 *
 * Pure and defensive: the sheet shape belongs to the riff app and has
 * already been through several schema versions, so nothing here trusts
 * any field to exist or to be the right type. Junk in → null out,
 * never a throw.
 *
 * @internal
 */

/** Cap matching SET_PLAYBOOK_DESCRIPTION's slice — one tile paragraph. */
const MAX_DESCRIPTION = 500;

/** Collapse whitespace and cap; empty → null. */
function cleanText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\s+/g, ' ').trim();
  if (text.length === 0) return null;
  return text.length > MAX_DESCRIPTION ? `${text.slice(0, MAX_DESCRIPTION - 1)}…` : text;
}

/**
 * Strip riff content down to prose for a fallback description. The
 * summary field is the preferred source and skips this entirely.
 *
 * Handles BOTH markups riff sheets carry: newer sheets store HTML,
 * older ones store markdown — live enrichment on real data
 * (2026-08-20, Payments Ops) surfaced a sheet whose content began
 * `# Incident Response Runbook…`, which an HTML-only strip passes
 * through with the `#` markers intact.
 */
function textFromRichContent(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const text = raw
    // HTML: block closers terminate with punctuation so the strip
    // reads as prose, not as words running into each other.
    .replace(/<\/(h[1-6]|p|li|div)>/gi, '. ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    // Markdown: heading lines become sentences; list markers drop;
    // emphasis/code markers are noise in a one-line description.
    .replace(/^\s{0,3}#{1,6}\s+(.+?)\s*$/gm, '$1. ')
    .replace(/^\s*(?:[-*•]|\d+[.)])\s+/gm, '')
    .replace(/(\*\*|__|`)/g, '')
    .replace(/\s*\.\s*(\.\s*)+/g, '. ') // collapse runs of injected dots
    .trim();
  return cleanText(text);
}

/**
 * The description a riff sheet offers, in preference order:
 *
 *   1. `summary.text` — the riff app's own account of the playbook.
 *   2. `summary` as a plain string (older sheets).
 *   3. The content HTML, stripped — better than nothing.
 *
 * Null when the sheet has nothing usable (the enrichment pass then
 * leaves the node alone rather than stamping junk).
 */
export function riffSheetDescription(sheet: unknown): string | null {
  if (sheet === null || typeof sheet !== 'object') return null;
  const record = sheet as Record<string, unknown>;
  const summary = record['summary'];
  if (summary !== null && typeof summary === 'object') {
    const text = cleanText((summary as Record<string, unknown>)['text']);
    if (text !== null) return text;
  }
  const flat = cleanText(summary);
  if (flat !== null) return flat;
  return textFromRichContent(record['content']);
}

/**
 * Friendly label for a riff lifecycle stage/status pair, for the tile
 * pill. Draft-ness comes from `status`; submission from `stage`.
 * Unknown values prettify (snake_case → words) rather than leak raw.
 */
export function riffStageLabel(stage: unknown, status: unknown): string | null {
  const s = typeof stage === 'string' ? stage.trim().toLowerCase() : '';
  const st = typeof status === 'string' ? status.trim().toLowerCase() : '';
  if (s === 'not_submitted') return st === 'draft' ? 'Draft' : 'Not submitted';
  if (s.length > 0) {
    const pretty = s.replace(/_/g, ' ');
    return pretty.charAt(0).toUpperCase() + pretty.slice(1);
  }
  if (st.length > 0) return st.charAt(0).toUpperCase() + st.slice(1);
  return null;
}
