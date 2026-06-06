/**
 * Boot-chat event-log compressor.
 *
 * Takes a raw stream of recent `:Commit` events from `spaces.listRecentEvents`
 * and squeezes them into a small bulleted digest suitable for a chat
 * bubble. The compression rules are deliberately simple and deterministic:
 *
 *   1. Bucket events by `(author, spaceName, verb)` triples
 *   2. Pick the top-N buckets by event count
 *   3. Render each as "[Author] [verb] [N] [object] in [space]" or similar
 *
 * Pure / no I/O / no Date.now() — tests pass a static `Event[]` and
 * assert the bullet output exactly. The chat renderer formats the
 * resulting `EventDigest` as chat bubbles.
 */

/** A single commit event projected from `:Commit` rows. */
export interface CompressableEvent {
  id: string;
  /** Raw `:Commit.author` — may be email / display name / agent id. */
  author: string;
  /** Verbatim `:Commit.message`, e.g. `'item:added'` / `'item:updated'`. */
  kind: string;
  /** ISO timestamp. */
  timestamp: string;
  /** Optional Space context. */
  spaceId?: string;
  /** Display name of the Space (falls back to spaceId at the SDK layer). */
  spaceName?: string;
}

/**
 * Output of `compressEventLog`. Each bullet is a one-line natural-
 * language phrase; the chat renderer just concatenates them.
 */
export interface EventDigest {
  /** Total events fed in (regardless of compression). */
  totalEvents: number;
  /** Compressed bullet lines, ordered by relevance (count desc). */
  bullets: string[];
  /** ISO timestamp of the OLDEST event in the digest, or null when empty. */
  oldestTimestamp: string | null;
}

/**
 * Default maximum number of bullets a digest can contain. The chat
 * bubble would get unreadable with more; users can open the
 * workspace to see the full timeline.
 */
const DEFAULT_MAX_BULLETS = 5;

/**
 * Compress a raw event stream into a small bulleted digest. Pure;
 * results are deterministic for any given input ordering.
 */
export function compressEventLog(
  events: ReadonlyArray<CompressableEvent>,
  opts: { maxBullets?: number } = {}
): EventDigest {
  if (!Array.isArray(events) || events.length === 0) {
    return { totalEvents: 0, bullets: [], oldestTimestamp: null };
  }
  const maxBullets = typeof opts.maxBullets === 'number' && opts.maxBullets > 0
    ? Math.floor(opts.maxBullets)
    : DEFAULT_MAX_BULLETS;

  // Bucket by (author, spaceName, verbCategory). VerbCategory is the
  // friendlied verb from `kind` — "added" / "updated" / "removed" /
  // "created" / etc. — so "item:added" and "asset:added" collapse into
  // the same bucket within a Space + author.
  const buckets = new Map<string, BucketState>();

  let oldestTs: string | null = null;

  for (const ev of events) {
    if (!isLikelyEvent(ev)) continue;
    const author = normalizeAuthor(ev.author);
    const verb = verbFromKind(ev.kind);
    const objectName = objectFromKind(ev.kind);
    const space = typeof ev.spaceName === 'string' && ev.spaceName.length > 0
      ? ev.spaceName
      : (typeof ev.spaceId === 'string' && ev.spaceId.length > 0
        ? ev.spaceId
        : null);
    const key = `${author}|${verb}|${objectName}|${space ?? ''}`;
    const bucket = buckets.get(key);
    if (bucket === undefined) {
      buckets.set(key, {
        author,
        verb,
        objectName,
        space,
        count: 1,
        latestTs: ev.timestamp,
      });
    } else {
      bucket.count += 1;
      if (ev.timestamp > bucket.latestTs) bucket.latestTs = ev.timestamp;
    }
    if (oldestTs === null || ev.timestamp < oldestTs) {
      oldestTs = ev.timestamp;
    }
  }

  // Sort buckets by count desc, then by latestTs desc (most-recent
  // tiebreak first).
  const ordered = Array.from(buckets.values()).sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return b.latestTs.localeCompare(a.latestTs);
  });

  const bullets = ordered.slice(0, maxBullets).map(formatBullet);
  return {
    totalEvents: events.length,
    bullets,
    oldestTimestamp: oldestTs,
  };
}

interface BucketState {
  author: string;
  verb: string;
  objectName: string;
  space: string | null;
  count: number;
  latestTs: string;
}

function formatBullet(b: BucketState): string {
  const noun = pluralize(b.objectName, b.count);
  const countWord = b.count === 1 ? 'a' : String(b.count);
  const inSpace = b.space !== null ? ` in ${b.space}` : '';
  return `${b.author} ${b.verb} ${countWord} ${noun}${inSpace}`;
}

function pluralize(noun: string, count: number): string {
  if (count === 1) return noun;
  if (noun.endsWith('y')) return `${noun.slice(0, -1)}ies`;
  if (noun.endsWith('s')) return noun;
  return `${noun}s`;
}

/**
 * Normalize a `:Commit.author` value into something readable. Emails
 * collapse to the local part (titlecased); agent ids / display names
 * pass through. Empty / missing values render as "Someone".
 */
function normalizeAuthor(raw: string): string {
  if (typeof raw !== 'string') return 'Someone';
  const trimmed = raw.trim();
  if (trimmed.length === 0) return 'Someone';
  if (trimmed.includes('@')) {
    const local = trimmed.split('@')[0] ?? '';
    if (local.length === 0) return 'Someone';
    return local
      .split(/[._-]/)
      .filter((p) => p.length > 0)
      .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
      .join(' ');
  }
  return trimmed;
}

/**
 * Translate a `:Commit.message` string into a friendly verb. Mirrors
 * the renderer's `deriveVerb` so digest bullets read like the
 * timeline rows ("added" / "updated" / etc.).
 */
function verbFromKind(kind: string): string {
  if (typeof kind !== 'string' || kind.length === 0) return 'touched';
  const lower = kind.toLowerCase();
  if (lower.includes('add')) return 'added';
  if (lower.includes('create')) return 'created';
  if (lower.includes('update')) return 'updated';
  if (lower.includes('delete') || lower.includes('remove')) return 'removed';
  if (lower.includes('produce')) return 'produced';
  if (lower.includes('share')) return 'shared';
  if (lower.includes('promote')) return 'promoted';
  return kind;
}

/**
 * Translate a commit kind into the canonical noun for the affected
 * object: "item:added" → "item", "ticket:done" → "ticket", etc.
 */
function objectFromKind(kind: string): string {
  if (typeof kind !== 'string' || kind.length === 0) return 'change';
  const head = kind.split(':')[0]?.toLowerCase() ?? '';
  if (head === 'item' || head === 'asset') return 'item';
  if (head === 'ticket') return 'ticket';
  if (head === 'playbook') return 'playbook';
  if (head === 'space') return 'change';
  return head.length > 0 ? head : 'change';
}

/** Defensive shape-check so malformed graph rows don't crash compression. */
function isLikelyEvent(v: unknown): v is CompressableEvent {
  if (v === null || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r['author'] === 'string' &&
    typeof r['kind'] === 'string' &&
    typeof r['timestamp'] === 'string'
  );
}
