/**
 * Agentic University shared types.
 *
 * The University menu in Lite hosts links to learning content
 * (LMS, courses, tutorials, AI Run Times). The
 * curated catalog is hand-maintained in `./curated-content.ts` for
 * v1; the data shape is forward-compatible with a future port that
 * pulls from OAGI (similar to how `lite/idw/` pulls from OAGI for
 * the Store catalog).
 *
 * Public types are re-exported from `api.ts`.
 */

/**
 * A menu-bound link -- something the user clicks in the Agentic
 * University menu (Open LMS, AI Run Times, etc.) and
 * a course / tutorial entry in the curated catalog window.
 *
 * `kind` distinguishes the destination's nature so the UI can pick
 * the right accent color, default icon, and routing behavior.
 */
export type LearningKind =
  | 'lms' // The full Learning Management System (top-level)
  | 'course' // A specific course in the LMS
  | 'tutorial' // A standalone how-to / quick-start
  | 'feed' // AI Run Times / article feed
  | 'method'; // Wiser Method or other reference content

/** Display order for kinds in the catalog window. */
export const LEARNING_KINDS: ReadonlyArray<LearningKind> = [
  'lms',
  'course',
  'tutorial',
  'feed',
  'method',
];

/**
 * A curated tutorial / course / link surfaced in the Agentic
 * University catalog (or as a top-level menu item).
 *
 * Stored in `./curated-content.ts`. NOT persisted in KV -- the
 * catalog is read-only for now (v1 hand-curation; v2 may pull from
 * OAGI as `Course` / `Tutorial` node types).
 */
export interface LearningEntry {
  /** Stable id (e.g. 'getting-started'). */
  id: string;
  /** Discriminator -- picks accent color and routing. */
  kind: LearningKind;
  /** Human-readable title shown in menu / catalog cards. */
  title: string;
  /** Long-form description shown in catalog cards. */
  description: string;
  /** External URL the Learning Browser loads. http/https only. */
  url: string;
  /** Optional category label for grouping in the catalog. */
  category?: string;
  /** Optional duration hint (e.g. '12 min') shown on cards. */
  duration?: string;
  /** Default icon emoji shown when no thumbnail is available. */
  iconEmoji?: string;
  /** Optional thumbnail / cover image URL for catalog cards. */
  thumbnailUrl?: string;
  /** Whether this entry is also exposed as a top-level menu item. */
  inTopLevelMenu?: boolean;
  /** Whether this entry is featured (rendered prominently in the catalog). */
  featured?: boolean;
}

/**
 * Sentinel constant so types.ts has a value-level export (avoids
 * dep-cruiser orphan warning).
 */
export const UNIVERSITY_MODULE_VERSION = 1 as const;
