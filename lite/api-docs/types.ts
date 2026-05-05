/**
 * Shared types for the API Reference window (ADR-035).
 *
 * The manifest is harvested at build time from `lite/<module>/api.ts`,
 * `events.ts`, and `README.md`, then written to
 * `lite/api-docs/manifest.generated.ts`. Both the Node-side builder and
 * the renderer-side consumer agree on the shape via these types.
 */

/**
 * One documented method on a module's public API interface. Harvested
 * from the JSDoc block immediately preceding the method signature in
 * `lite/<module>/api.ts`.
 */
export interface MethodDoc {
  /** The method name (e.g. `set`, `signIn`, `onEvent`). */
  name: string;
  /**
   * The full method signature as it appears in the interface, with
   * `args: Type` syntax preserved. May span multiple lines for long
   * parameter lists.
   */
  signature: string;
  /**
   * Plain prose lifted from the JSDoc block. Empty string if no JSDoc
   * was present (the snapshot test treats this as drift and fails).
   */
  description: string;
  /**
   * `@param`, `@returns`, `@throws` lines extracted verbatim from the
   * JSDoc. Rendered as a bullet list under the method card.
   */
  tags: Array<{ tag: string; value: string }>;
  /**
   * `@example` blocks extracted from the JSDoc. Each entry is a
   * fenced code block string (without the surrounding ``` markers).
   * Pre-formatted; renderer wraps each in a `<pre><code>`.
   */
  examples: string[];
}

/**
 * One typed event emitted by a module. Harvested from the
 * `<MODULE>_EVENTS` const in `lite/<module>/events.ts`.
 */
export interface EventDoc {
  /** The constant key (e.g. `SET_START`). */
  constantKey: string;
  /** The event name (e.g. `kv.set.start`). */
  name: string;
  /**
   * Empty string in v1 -- per-event prose lives in the module README's
   * "Event taxonomy" section, not as JSDoc on each constant entry.
   * Reserved here for future enrichment.
   */
  description: string;
}

/** One module's complete documentation entry. */
export interface ModuleDoc {
  /** Lower-case directory name (e.g. `kv`, `bug-report`). Acts as the URL slug. */
  slug: string;
  /** Display title for the sidebar (e.g. `KV`, `Bug Report`). */
  title: string;
  /**
   * One-paragraph summary lifted from the top-of-file JSDoc on the
   * module's `api.ts`. Empty string if the file has no header comment.
   */
  summary: string;
  /** Public-API surface harvested from `lite/<module>/api.ts`. */
  surface: {
    /** Interface name as exported (e.g. `KVApi`). */
    interfaceName: string;
    /**
     * JSDoc block immediately preceding the interface declaration. May
     * include error-contract notes that apply to every method.
     */
    interfaceDescription: string;
    /** Methods declared on the interface, in source order. */
    methods: MethodDoc[];
  } | null;
  /**
   * Typed event constants harvested from `lite/<module>/events.ts`,
   * or null if the module has no `events.ts`.
   */
  events: {
    /** Constant name (e.g. `KV_EVENTS`). */
    constantName: string;
    /** Total number of events. */
    count: number;
    /** Each event's typed-constant key + emitted name. */
    entries: EventDoc[];
  } | null;
  /**
   * Full README contents (markdown source). The renderer feeds this
   * through `marked` to produce HTML. `null` when the module has no
   * README.
   */
  readme: string | null;
}

/**
 * Top-level manifest -- one entry per documented module, plus a list
 * of "untyped" modules that lack `api.ts` (rendered as a footer).
 */
export interface Manifest {
  /** Modules with a typed public API. */
  modules: ModuleDoc[];
  /** Modules without `api.ts` -- rendered as a flat footer list. */
  untyped: Array<{ slug: string; title: string; reason: string }>;
  /** When the manifest was generated (ISO timestamp). */
  generatedAt: string;
}
