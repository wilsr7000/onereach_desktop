/**
 * The default Space that Onereach.ai Lite feedback — bug reports AND
 * feature requests — is filed into, as TICKETS.
 *
 * Reports live in KV (`lite-bugs`) — that stays the system of
 * record, because it carries the redaction guarantee, the triage
 * status, and the CRUD surface the modal drives. What KV does NOT give
 * anyone is a place to *look*. This module mirrors each filed report
 * into the graph as a TICKET in a well-known shared Space, so feedback
 * shows up where every other kind of work already lives: on the ticket
 * board (open → in progress → done), searchable, filterable, linkable,
 * and drivable by whoever is triaging. Feature requests and bugs share
 * one Space — triage wants one queue, and `feedbackType` metadata (plus
 * the title tag) keeps them distinguishable at a glance.
 *
 * Two invariants matter more than anything else here:
 *
 *   1. **Filing to the graph can never break filing a bug.** Every entry
 *      point soft-fails. If the graph is unreachable, the Space can't be
 *      created, or the item write is rejected, the user still gets
 *      "report sent" — because the KV write is what actually saved it.
 *      A bug reporter that fails when the backend is unhealthy is
 *      useless precisely when it's needed most.
 *
 *   2. **Ensuring the Space is idempotent and race-safe.** Several
 *      clients may file their first bug at the same moment. Name
 *      uniqueness is enforced server-side, so a create that loses the
 *      race comes back as a duplicate-name error — that's a SUCCESS
 *      case here (someone else made it), not a failure, so we re-list
 *      and use theirs rather than surfacing an error.
 *
 * @internal — reached through the bug-report store, not imported
 * directly by other modules.
 */

import type { SpacesApi, Space, Item } from '../spaces/api.js';
import type { BugReportPayload, FeedbackType } from './capture.js';

/**
 * Canonical name of the Space. Matched case-insensitively when looking
 * for an existing Space, but created with exactly this casing.
 *
 * Changing this string does NOT rename an existing Space — it would
 * cause a second one to be created alongside the first. Rename in the
 * Spaces UI instead, and note that reports filed before the rename stay
 * where they are.
 *
 * History: filings before 2026-08-08 went to "Onereach.ai Lite Bugs"
 * as plain text items. That Space keeps its history; new filings are
 * tickets here.
 */
export const LITE_FEEDBACK_SPACE_NAME = 'Onereach.ai Lite Feedback';

/**
 * Shown in the Spaces sidebar and — because it is what the AI
 * space-suggester reads — it is also how the model learns what belongs
 * here. Worth keeping concrete.
 */
export const LITE_FEEDBACK_SPACE_DESCRIPTION =
  'Bug reports and feature requests filed from the Onereach.ai Lite desktop ' +
  'app, as tickets. Bug tickets carry the app version, platform, and recent ' +
  'log lines; feature tickets carry the request. Secrets and PII are ' +
  'redacted before anything is stored. Triage on the ticket board: ' +
  'open → in progress → done.';

/** Sidebar dot colour — amber: a triage queue, not an alarm. */
export const LITE_FEEDBACK_SPACE_COLOR = '#f0a020';

/** Lucide icon key for the Space. */
export const LITE_FEEDBACK_SPACE_ICON = 'inbox';

/** Result of ensuring the Space exists. Never throws — see module doc. */
export interface EnsureSpaceResult {
  /** The Space, or null when it could not be found or created. */
  space: Space | null;
  /** How we got here — useful in logs and asserted by tests. */
  outcome: 'found' | 'created' | 'raced' | 'failed';
  /** Present when `outcome === 'failed'`. */
  error?: string;
}

/**
 * Case-insensitive, whitespace-tolerant name match. Space names are
 * user-editable, so someone may have typed a stray trailing space.
 */
function matchesFeedbackSpaceName(name: unknown): boolean {
  return typeof name === 'string' && name.trim().toLowerCase() === LITE_FEEDBACK_SPACE_NAME.toLowerCase();
}

function findFeedbackSpace(spaces: ReadonlyArray<Space>): Space | null {
  return spaces.find((s) => matchesFeedbackSpaceName(s.name)) ?? null;
}

/**
 * A create that failed because the name is already taken means another
 * client won the race — the Space we want now exists.
 */
function isDuplicateNameError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && code.toUpperCase().includes('DUPLICATE')) return true;
  const message = err instanceof Error ? err.message.toLowerCase() : '';
  return message.includes('duplicate') || message.includes('already exists');
}

/**
 * Find the Lite feedback Space, creating it on first use. Idempotent
 * and race-safe. Never throws.
 */
export async function ensureLiteFeedbackSpace(api: SpacesApi): Promise<EnsureSpaceResult> {
  try {
    const existing = findFeedbackSpace(await api.listSpaces());
    if (existing !== null) return { space: existing, outcome: 'found' };
  } catch (err) {
    // Can't even list -- the graph is unreachable. Don't attempt a
    // create on top of that; a create would likely fail too, and a
    // blind create risks a duplicate if the list failed spuriously.
    return { space: null, outcome: 'failed', error: describeError(err) };
  }

  try {
    const created = await api.createSpace({
      name: LITE_FEEDBACK_SPACE_NAME,
      description: LITE_FEEDBACK_SPACE_DESCRIPTION,
      color: LITE_FEEDBACK_SPACE_COLOR,
      iconKey: LITE_FEEDBACK_SPACE_ICON,
    });
    // Shared kind renders the ticket board (open / in progress / done)
    // instead of the tile grid — that IS the triage surface. Best-effort:
    // a plain Space still files tickets fine, so a kind-set failure must
    // not fail the ensure. Only set on CREATE — if a triager later flips
    // the kind deliberately, we respect it.
    try {
      await api.setSpaceKind(created.id, 'shared');
    } catch {
      // tickets still land; the board is presentation, not storage
    }
    return { space: created, outcome: 'created' };
  } catch (err) {
    if (!isDuplicateNameError(err)) {
      return { space: null, outcome: 'failed', error: describeError(err) };
    }
    // Lost the race. Someone else created it between our list and our
    // create -- re-read and use theirs.
    try {
      const raced = findFeedbackSpace(await api.listSpaces());
      if (raced !== null) return { space: raced, outcome: 'raced' };
      // Duplicate-name, yet not in the list. The name is taken by a
      // Space we can't see (visibility gating), so we cannot file here.
      return {
        space: null,
        outcome: 'failed',
        error: `"${LITE_FEEDBACK_SPACE_NAME}" already exists but is not visible to this account.`,
      };
    } catch (listErr) {
      return { space: null, outcome: 'failed', error: describeError(listErr) };
    }
  }
}

/**
 * Human tag for the title — the glanceable bug/idea marker on the
 * ticket board. Kept short so real summaries keep the room.
 */
function titleTag(feedbackType: FeedbackType): string {
  return feedbackType === 'feature' ? '[idea]' : '[bug]';
}

/** One-line ticket title. Titles are the triage index. */
export function buildFeedbackItemTitle(payload: BugReportPayload): string {
  const raw = typeof payload.description === 'string' ? payload.description.trim() : '';
  const firstLine = raw.split('\n').find((l) => l.trim().length > 0)?.trim() ?? '';
  const fallback = payload.feedbackType === 'feature' ? 'Feature request' : 'Bug report';
  const summary = firstLine.length > 0 ? firstLine : fallback;
  const clipped = summary.length > 120 ? `${summary.slice(0, 117)}…` : summary;
  const version = typeof payload.version === 'string' ? payload.version.trim() : '';
  const tag = titleTag(payload.feedbackType);
  return version.length > 0 ? `[${version}] ${tag} ${clipped}` : `${tag} ${clipped}`;
}

/**
 * Markdown body. The payload reaching here is ALREADY redacted by the
 * store — this function must never re-introduce a raw field.
 */
export function buildFeedbackItemContent(payload: BugReportPayload): string {
  const lines: string[] = [];
  const description = typeof payload.description === 'string' ? payload.description.trim() : '';
  lines.push(description.length > 0 ? description : '_No description provided._');
  lines.push('');
  lines.push('---');
  lines.push('');
  const os = payload.os;
  const platform =
    os !== null && typeof os === 'object'
      ? [os.platform, os.release, os.arch].filter((p) => typeof p === 'string' && p.length > 0).join(' ')
      : '';
  const meta: Array<[string, string]> = [
    ['Type', payload.feedbackType === 'feature' ? 'Feature request' : 'Bug report'],
    ['Reported', typeof payload.timestamp === 'string' ? payload.timestamp : ''],
    ['App version', typeof payload.version === 'string' ? payload.version : ''],
    ['Platform', platform],
    ['Status', typeof payload.status === 'string' ? payload.status : ''],
  ];
  for (const [label, value] of meta) {
    if (value.trim().length > 0) lines.push(`- **${label}:** ${value.trim()}`);
  }
  // `recentLogs` is a single pre-joined, already-redacted blob.
  const logs = typeof payload.recentLogs === 'string' ? payload.recentLogs.trim() : '';
  if (logs.length > 0) {
    lines.push('');
    lines.push('### Recent logs');
    lines.push('');
    lines.push('```');
    lines.push(logs);
    lines.push('```');
  }
  return lines.join('\n');
}

/** Result of mirroring one report into the graph. Never throws. */
export interface FileBugResult {
  filed: boolean;
  item?: Item;
  spaceId?: string;
  error?: string;
}

/**
 * Mirror an already-saved, already-redacted report into the feedback
 * Space as a TICKET (`kind: 'ticket'`, status defaults to open) so it
 * lands on the triage board rather than as an inert note.
 *
 * Soft-fails by contract: the caller has already persisted to KV, so a
 * graph failure here costs visibility, not the report.
 */
export async function fileFeedbackToGraph(
  payload: BugReportPayload,
  api: SpacesApi
): Promise<FileBugResult> {
  const ensured = await ensureLiteFeedbackSpace(api);
  if (ensured.space === null) {
    return { filed: false, ...(ensured.error !== undefined ? { error: ensured.error } : {}) };
  }
  try {
    const item = await api.items.create({
      spaceId: ensured.space.id,
      title: buildFeedbackItemTitle(payload),
      kind: 'ticket',
      content: buildFeedbackItemContent(payload),
      metadata: {
        source: 'lite-feedback',
        feedbackType: payload.feedbackType,
        // The KV key -- this is the join back to the system of record.
        bugReportTimestamp: payload.timestamp,
        ...(typeof payload.version === 'string' ? { appVersion: payload.version } : {}),
        ...(typeof payload.os?.platform === 'string' ? { platform: payload.os.platform } : {}),
        ...(typeof payload.status === 'string' ? { status: payload.status } : {}),
      },
    });
    return { filed: true, item, spaceId: ensured.space.id };
  } catch (err) {
    return { filed: false, spaceId: ensured.space.id, error: describeError(err) };
  }
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
