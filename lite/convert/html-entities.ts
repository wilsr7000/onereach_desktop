/**
 * HTML entity decoding, in one pass (ADR-100 Amendment 1). The earlier
 * decoder replaced `&amp;` first and then the rest, so `&amp;lt;script&amp;gt;`
 * came back as a live `<script>` after the tags had already been
 * stripped. One alternation, one replace: an entity produced by decoding
 * is never decoded again.
 */

/** The named entities the converters decode; numeric references are handled alongside. */
export const HTML_ENTITIES: Readonly<Record<string, string>> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
  '&ndash;': '–',
  '&mdash;': '—',
  '&laquo;': '«',
  '&raquo;': '»',
  '&copy;': '©',
  '&reg;': '®',
  '&trade;': '™',
  '&hellip;': '…',
};

const ENTITY = /&(?:#(\d{1,8})|#[xX]([0-9a-fA-F]{1,7})|([a-zA-Z]{2,8}));/g;

function codePoint(code: number, fallback: string): string {
  return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : fallback;
}

/** Named entities from the table, decimal (&#169;) and hex (&#x1F600;) references — each decoded once. */
export function decodeEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(ENTITY, (match: string, dec: string | undefined, hex: string | undefined, name: string | undefined) => {
    if (dec !== undefined) return codePoint(Number.parseInt(dec, 10), match);
    if (hex !== undefined) return codePoint(Number.parseInt(hex, 16), match);
    return HTML_ENTITIES[`&${name ?? ''};`] ?? match;
  });
}
