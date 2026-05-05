/**
 * Hand-curated Agentic University catalog.
 *
 * This is the v1 source of truth for what the catalog window
 * shows. Most top-level learning links mirror the menu items the full app's
 * [lib/menu-sections/idw-gsx-builder.js](lib/menu-sections/idw-gsx-builder.js)-style
 * `_buildUniversityMenu` exposes, plus a richer description and
 * category metadata for the polished tile grid.
 *
 * Forward-compat: a future port can replace `CURATED` with a
 * function that pulls `Course` / `Tutorial` node types from OAGI
 * (the same Cypher / mapping pattern as `lite/idw/catalog-renderer.ts`).
 *
 * @internal
 */

import type { LearningEntry, LearningKind } from './types.js';

/** Base URL for OneReach learning content (LMS + courses). */
export const LMS_BASE_URL = 'https://learning.staging.onereach.ai';

/** AI Run Times -- UX Magazine is OneReach's article home. */
export const AI_RUN_TIMES_URL = 'https://uxmag.com';

/** Wiser Method -- companion methodology site. */
export const WISER_METHOD_URL = 'https://www.wisermethod.com/';

/**
 * Per-kind UI metadata (accent color, default icon emoji, display
 * label). Adding a new `LearningKind` means appending a row here
 * and the catalog renderer + Settings section pick it up.
 */
export interface KindUiMeta {
  label: string;
  pluralLabel: string;
  accentVar: string;
  accentHex: string;
  defaultIconEmoji: string;
}

export const KIND_UI: Readonly<Record<LearningKind, KindUiMeta>> = {
  lms: {
    label: 'LMS',
    pluralLabel: 'LMS',
    accentVar: 'accent-lms',
    accentHex: '#4f8cff',
    defaultIconEmoji: '\u{1F3DB}', // classical building
  },
  course: {
    label: 'Course',
    pluralLabel: 'Courses',
    accentVar: 'accent-course',
    accentHex: '#7bdbff',
    defaultIconEmoji: '\u{1F4DA}', // books
  },
  tutorial: {
    label: 'Tutorial',
    pluralLabel: 'Tutorials',
    accentVar: 'accent-tutorial',
    accentHex: '#6bff8a',
    defaultIconEmoji: '\u{1F393}', // graduation cap
  },
  feed: {
    label: 'Feed',
    pluralLabel: 'Feeds',
    accentVar: 'accent-feed',
    accentHex: '#ff9c4a',
    defaultIconEmoji: '\u{1F4F0}', // newspaper
  },
  method: {
    label: 'Method',
    pluralLabel: 'Methods',
    accentVar: 'accent-method',
    accentHex: '#b87bff',
    defaultIconEmoji: '\u{1F9ED}', // compass
  },
};

/**
 * The curated catalog. Mirrors the full app's University menu
 * structure plus a couple extras for the catalog window.
 */
export const CURATED: ReadonlyArray<LearningEntry> = [
  {
    id: 'lms',
    kind: 'lms',
    title: 'Open LMS',
    description:
      'The full OneReach Learning Management System -- courses, learning paths, certifications, and your progress across them.',
    url: `${LMS_BASE_URL}/`,
    category: 'Hub',
    iconEmoji: '\u{1F3DB}',
    inTopLevelMenu: true,
    featured: true,
  },
  {
    id: 'getting-started',
    kind: 'course',
    title: 'Getting Started',
    description:
      'A first-time-user walkthrough of OneReach concepts, terminology, and the studio interface. Recommended starting point.',
    url: `${LMS_BASE_URL}/courses/getting-started`,
    category: 'Foundations',
    duration: '~30 min',
    iconEmoji: '\u{1F680}',
    inTopLevelMenu: true,
    featured: true,
  },
  {
    id: 'first-agent',
    kind: 'course',
    title: 'Building Your First Agent',
    description:
      'Hands-on construction of a simple IDW agent from scratch. Covers prompts, tools, and the basics of conversation design.',
    url: `${LMS_BASE_URL}/courses/first-agent`,
    category: 'Foundations',
    duration: '~45 min',
    iconEmoji: '\u{1F916}',
    inTopLevelMenu: true,
    featured: true,
  },
  {
    id: 'workflow-basics',
    kind: 'course',
    title: 'Workflow Fundamentals',
    description:
      'How to compose multi-step workflows, branching, error handling, and state. The mental model behind the OneReach Studio canvas.',
    url: `${LMS_BASE_URL}/courses/workflow-basics`,
    category: 'Workflow',
    duration: '~60 min',
    iconEmoji: '\u{1F4D0}',
    inTopLevelMenu: true,
  },
  {
    id: 'api-integration',
    kind: 'course',
    title: 'API Integration',
    description:
      'Calling external APIs from a workflow: HTTP nodes, authentication, response shaping, and pagination.',
    url: `${LMS_BASE_URL}/courses/api-integration`,
    category: 'Integration',
    duration: '~50 min',
    iconEmoji: '\u{1F517}',
    inTopLevelMenu: true,
  },
  {
    id: 'ai-run-times',
    kind: 'feed',
    title: 'AI Run Times',
    description:
      'OneReach\u2019s article feed on the human side of AI products: design patterns, case studies, and field reports from teams shipping at the edge.',
    url: AI_RUN_TIMES_URL,
    category: 'Reading',
    iconEmoji: '\u{1F4F0}',
    inTopLevelMenu: true,
  },
  {
    id: 'wiser-method',
    kind: 'method',
    title: 'Wiser Method',
    description:
      'The Wiser Method site -- the methodology and operating model behind OneReach\u2019s practice. Reference reading for product experts.',
    url: WISER_METHOD_URL,
    category: 'Reference',
    iconEmoji: '\u{1F9ED}',
    inTopLevelMenu: false,
  },
];

/**
 * Lookup helper. Returns null when the id is not in the curated set.
 */
export function findCurated(id: string): LearningEntry | null {
  return CURATED.find((e) => e.id === id) ?? null;
}

/**
 * The subset that should appear as items in the top-level Agentic
 * University menu. The Quick Starts submenu derives its items from
 * `kind === 'course'` entries.
 */
export function getTopLevelMenuEntries(): ReadonlyArray<LearningEntry> {
  return CURATED.filter((e) => e.inTopLevelMenu === true);
}
