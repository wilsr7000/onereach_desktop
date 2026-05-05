/**
 * Agentic University module -- PUBLIC API.
 *
 * The only file other lite modules should import from in this
 * module. Per ADR-019 / Rule 11, cross-module imports go through
 * `<module>/api.ts` -- never reach into `curated-content.ts`,
 * `menu-builder.ts`, or any other internal file.
 *
 * The University module hosts the top-level **Agentic University**
 * menu (Open LMS, Quick Starts -> View All Tutorials + courses, AI
 * Run Times) plus a polished tutorials catalog
 * window. All link items open in a shared Lite-native "Learning
 * Browser" window (separate persistent partition from the IDW
 * placeholder browser, so OAGI logins don't bleed into university
 * viewing).
 *
 * Forward-compat: the curated catalog is hand-maintained for v1;
 * a future port can pull from OAGI as `Course` / `Tutorial` node
 * types (similar pattern to `lite/idw/catalog-renderer.ts`).
 *
 * Tests: `_setUniversityApiForTesting(stub)` to inject a custom
 * implementation, `_resetUniversityApiForTesting()` to clear the
 * singleton.
 */

import { CURATED, KIND_UI } from './curated-content.js';
import type { LearningEntry, LearningKind } from './types.js';
import { UniversityError, UNIVERSITY_ERROR_CODES } from './errors.js';
import { getLoggingApi } from '../logging/api.js';
import type { EventRecord } from '../logging/events.js';
import { isUniversityEvent, type UniversityEvent } from './events.js';

// Re-export the public types consumers need to typecheck calls.
export type { LearningEntry, LearningKind } from './types.js';
export { LEARNING_KINDS, UNIVERSITY_MODULE_VERSION } from './types.js';

// Re-export the per-kind UI metadata table.
export { KIND_UI, LMS_BASE_URL, AI_RUN_TIMES_URL, WISER_METHOD_URL } from './curated-content.js';
export type { KindUiMeta } from './curated-content.js';

// Re-export structured error class + code catalog.
export type { UniversityErrorCode, UniversityErrorOptions } from './errors.js';
export { UniversityError, UNIVERSITY_ERROR_CODES };

// Re-export typed event surface (ADR-032).
export type {
  UniversityEvent,
  UniversityEventName,
  UniversityOpenedEvent,
  UniversityTutorialsOpenedEvent,
  UniversityBrowserLoadingEvent,
  UniversityBrowserLoadedEvent,
  UniversityIpcListEvent,
  UniversityIpcGetEvent,
  UniversityIpcOpenEvent,
  UniversityIpcOpenTutorialsEvent,
} from './events.js';
export { UNIVERSITY_EVENTS, isUniversityEvent } from './events.js';

// Generic base class -- consumers can also catch via instanceof
// LiteError if they want to handle errors uniformly across all
// lite modules.
export { LiteError, isLiteError } from '../errors.js';

/**
 * The public surface of the Agentic University module. Mostly
 * read-only -- the catalog is hand-curated and the only
 * mutations are click-driven (open URL in Learning Browser, open
 * tutorials window).
 *
 * **Error contract**: `get()` returns null for unknown ids (does
 * NOT throw). `openCourse(id)` / `openEntry(id)` throw
 * `UniversityError` with code `UNIV_NOT_FOUND` when the id is not
 * curated. Callers should branch on `instanceof UniversityError`
 * (or check `.code`).
 */
export interface UniversityApi {
  /** All curated learning entries, in catalog display order. */
  list(): Promise<LearningEntry[]>;
  /** Filter the curated catalog by kind. */
  listByKind(kind: LearningKind): Promise<LearningEntry[]>;
  /** Single curated entry by id, or null if absent. */
  get(id: string): Promise<LearningEntry | null>;
  /**
   * Subscribe to typed University events (ADR-032). Returns an
   * unsubscribe function.
   */
  onEvent(handler: (event: UniversityEvent) => void): () => void;
}

let _instance: UniversityApi | null = null;

/**
 * Get the singleton University API. Lazily instantiates on first
 * call.
 */
export function getUniversityApi(): UniversityApi {
  if (_instance === null) {
    _instance = buildDefaultApi();
  }
  return _instance;
}

/** Reset the singleton (for tests). */
export function _resetUniversityApiForTesting(): void {
  _instance = null;
}

/** Override the singleton with a custom implementation (for tests). */
export function _setUniversityApiForTesting(api: UniversityApi): void {
  _instance = api;
}

// ─── default implementation ──────────────────────────────────────────────

function buildDefaultApi(): UniversityApi {
  return {
    list: async () => [...CURATED],
    listByKind: async (kind) => CURATED.filter((e) => e.kind === kind),
    get: async (id) => CURATED.find((e) => e.id === id) ?? null,
    onEvent: (handler) =>
      getLoggingApi().onEvent('university.*', (ev: EventRecord) => {
        if (isUniversityEvent(ev)) {
          handler(ev as unknown as UniversityEvent);
        }
      }),
  };
}

// ─── helpers used by main.ts (not part of the public API) ────────────────

/**
 * Resolve a curated entry by id and validate its URL. Throws
 * `UniversityError` on either failure. Used by the click handlers
 * in `main.ts` / `menu-builder.ts` so the validation is centralized.
 *
 * @internal
 */
export function resolveEntryStrict(id: string): LearningEntry {
  const entry = CURATED.find((e) => e.id === id);
  if (entry === undefined) {
    throw new UniversityError({
      code: UNIVERSITY_ERROR_CODES.NOT_FOUND,
      message: `University entry not found: ${id}`,
      context: { op: 'resolve', id },
      remediation: 'Refresh the menu -- the catalog may have changed.',
    });
  }
  if (!isValidHttpUrl(entry.url)) {
    throw new UniversityError({
      code: UNIVERSITY_ERROR_CODES.INVALID_URL,
      message: `University entry ${id} has an invalid URL`,
      context: { op: 'resolve', id, url: entry.url },
      remediation: 'The curated catalog has a malformed URL; report a bug.',
    });
  }
  return entry;
}

function isValidHttpUrl(url: unknown): boolean {
  if (typeof url !== 'string' || url.length === 0) return false;
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Touch unused imports so dep-cruiser doesn't flag them. */
void KIND_UI;
