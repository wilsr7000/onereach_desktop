/**
 * Onereach Lite -- shared error infrastructure.
 *
 * Every error a lite module surfaces to a caller should be a `LiteError`
 * (or a subclass). This gives consumers ONE shape to handle everywhere:
 *
 *   try {
 *     await getKVApi().get('coll', 'key');
 *   } catch (err) {
 *     if (err instanceof LiteError) {
 *       console.error(err.formatForLog());        // structured, debuggable
 *       toast(err.formatForUser());                // short, friendly
 *       if (err.code === 'KV_TIMEOUT') retry();    // programmatic branch
 *     }
 *   }
 *
 * Why a shared base class:
 *
 * - **Stable codes**: a string enum on every error lets consumers branch
 *   without parsing prose. Codes are namespaced by module (`KV_*`,
 *   `BR_*`, future `SETTINGS_*`).
 * - **Context**: every throw site captures the inputs that caused the
 *   failure (operation, collection, key, status, etc.) so logs aren't
 *   guesswork.
 * - **Remediation**: short string telling the caller (or the user) what
 *   to try next. "Check your network", "The report no longer exists",
 *   etc. Optional but encouraged on every code.
 * - **Cause chain**: original `Error`s bubble through via `.cause` so
 *   stack traces and platform-specific details (DNS failures, abort
 *   reasons, etc.) aren't lost.
 * - **Two formatters**: `formatForLog()` is verbose (code, context,
 *   cause); `formatForUser()` is short and remediation-focused. Modules
 *   wire the right one to the right surface.
 *
 * Convention for codes:
 *
 *   <MODULE_PREFIX>_<WHAT_FAILED>
 *
 *   KV_TIMEOUT, KV_HTTP, KV_NETWORK
 *   BR_SAVE_FAILED, BR_NOT_FOUND, BR_BAD_PAYLOAD
 *
 * The full catalog lives in each module's README.md.
 */

/** Default user-facing fallback when no remediation hint was provided. */
const DEFAULT_REMEDIATION = 'Try again. If the problem persists, file a bug report.';

export interface LiteErrorOptions {
  /**
   * Stable, machine-readable code. Convention: `<MODULE>_<WHAT>`, e.g.
   * `KV_TIMEOUT`, `BR_NOT_FOUND`. Avoid free-form strings -- consumers
   * branch on these.
   */
  code: string;
  /**
   * Human-readable, log-friendly description. Should answer "what was
   * attempted, what happened" in one sentence.
   */
  message: string;
  /**
   * Structured context: the inputs that caused the failure (operation,
   * collection, key, HTTP status, body preview, etc.). Goes into logs;
   * keep small (max ~10 fields, max ~200 chars per value -- truncate
   * response bodies).
   */
  context?: Record<string, unknown>;
  /**
   * Short, action-oriented hint for the caller or user. Omit when the
   * default fallback is fine.
   *
   * Good: "Check your network and try again."
   * Bad:  "An unknown error occurred." (not actionable)
   */
  remediation?: string;
  /**
   * The underlying error that triggered this one. Standard ES2022
   * `Error.cause` -- preserves stack traces across module boundaries.
   */
  cause?: unknown;
}

/**
 * Base class for every error a lite module surfaces. Subclass per
 * module so `instanceof` works at finer granularity (e.g. catch all
 * `KVError` separately from `BugReportError`).
 */
export class LiteError extends Error {
  public readonly code: string;
  public readonly context: Readonly<Record<string, unknown>>;
  public readonly remediation: string;

  constructor(options: LiteErrorOptions) {
    // Pass cause through to native Error so DevTools shows the chain.
    super(options.message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'LiteError';
    this.code = options.code;
    this.context = Object.freeze({ ...(options.context ?? {}) });
    this.remediation = options.remediation ?? DEFAULT_REMEDIATION;

    // Preserve the prototype chain across `target: ES2022` + Babel-style
    // transpilation. Without this, `instanceof LiteError` can fail in
    // some test runners.
    Object.setPrototypeOf(this, new.target.prototype);
  }

  /**
   * Verbose, log-friendly serialization. Use for console.error, log
   * shipping, bug-report capture.
   *
   *   [KV_TIMEOUT] KV get timed out after 5000ms
   *     context: {"op":"get","collection":"lite-bugs","key":"x"}
   *     remediation: Check your network and try again.
   *     cause: AbortError: aborted
   */
  formatForLog(): string {
    const lines = [`[${this.code}] ${this.message}`];
    if (Object.keys(this.context).length > 0) {
      lines.push(`  context: ${safeStringify(this.context)}`);
    }
    if (this.remediation) {
      lines.push(`  remediation: ${this.remediation}`);
    }
    if (this.cause !== undefined) {
      lines.push(`  cause: ${formatCause(this.cause)}`);
    }
    return lines.join('\n');
  }

  /**
   * Short, user-facing string. Combines the human message with the
   * remediation hint. Use for toasts, modal error states, status bars.
   *
   *   "KV get timed out after 5000ms. Check your network and try again."
   */
  formatForUser(): string {
    if (this.remediation && this.remediation !== DEFAULT_REMEDIATION) {
      return `${this.message} ${this.remediation}`;
    }
    return this.message;
  }

  /**
   * Structured representation for JSON logs / IPC transport. The cause
   * is reduced to its `.message` (the full Error doesn't survive JSON).
   */
  toJSON(): {
    name: string;
    code: string;
    message: string;
    context: Record<string, unknown>;
    remediation: string;
    cause?: string;
  } {
    const out: {
      name: string;
      code: string;
      message: string;
      context: Record<string, unknown>;
      remediation: string;
      cause?: string;
    } = {
      name: this.name,
      code: this.code,
      message: this.message,
      context: { ...this.context },
      remediation: this.remediation,
    };
    if (this.cause !== undefined) {
      out.cause = formatCause(this.cause);
    }
    return out;
  }
}

/**
 * Wrap an unknown thrown value in a LiteError. Use at module boundaries
 * where you want to guarantee callers see a LiteError. Pass-through if
 * the input is already a LiteError.
 *
 *   } catch (err) {
 *     throw wrapAsLiteError(err, {
 *       code: 'BR_SAVE_FAILED',
 *       message: 'Bug report save failed: KV write rejected',
 *       remediation: 'Check your network and try again.',
 *       context: { timestamp: payload.timestamp },
 *     });
 *   }
 */
export function wrapAsLiteError(
  cause: unknown,
  options: Omit<LiteErrorOptions, 'cause'>
): LiteError {
  if (cause instanceof LiteError) return cause;
  return new LiteError({ ...options, cause });
}

/**
 * Type-guard. Use in cross-module call sites so handlers don't have to
 * import every concrete subclass.
 */
export function isLiteError(value: unknown): value is LiteError {
  return value instanceof LiteError;
}

// ---------------------------------------------------------------------------
// IPC error envelopes (the `__xError` JSON pattern)
// ---------------------------------------------------------------------------

/**
 * Wire shape of an error crossing `ipcMain.handle` -> renderer.
 * Matches `LiteError.toJSON()`; the per-module `parseError`
 * implementations in `preload-lite.ts` re-materialize exactly this.
 */
export type LiteErrorJSON = ReturnType<LiteError['toJSON']>;

/**
 * Project any thrown value into the `__xError` JSON envelope that
 * crosses `ipcMain.handle` boundaries.
 *
 * Errors don't serialize losslessly through Electron IPC: the renderer
 * receives a generic `Error` whose `.message` is prefixed with
 * "Error invoking remote method '<channel>': ". The lite convention
 * (see each module's `parseError` in `preload-lite.ts`) is to smuggle
 * a JSON payload in the message under a module marker key, e.g.
 * `{"__neonError":{...}}` -- the preload skips to the first `{` and
 * parses from there.
 *
 * Before the 2026-08-08 hardening review only TYPED module errors were
 * enveloped; everything else was rethrown raw, so the renderer's
 * `parseError` returned null and the user saw Electron's generic
 * message. This helper is the catch-all:
 *
 *   - already-enveloped `Error` (message starts with the marker
 *     envelope) -- returned as-is, so double-wrapping is impossible
 *   - `LiteError` (any subclass) -- `err.toJSON()`, stable code kept
 *   - anything else -- `{ code: 'UNKNOWN', message }`
 *
 * @param marker Module marker key, e.g. `'__neonError'`. Must match
 *   the key the module's renderer-side `parseError` looks for.
 */
export function envelopeIpcError(marker: string, err: unknown): Error {
  if (err instanceof Error && err.message.startsWith(`{"${marker}"`)) {
    return err;
  }
  const json: LiteErrorJSON =
    err instanceof LiteError
      ? err.toJSON()
      : new LiteError({
          code: 'UNKNOWN',
          message: err instanceof Error ? err.message : String(err),
          cause: err,
        }).toJSON();
  let wire: string;
  try {
    wire = JSON.stringify({ [marker]: json });
  } catch {
    // A LiteError carried unserializable context. The catch-all must
    // never itself throw -- fall back to the minimal envelope.
    wire = JSON.stringify({
      [marker]: {
        name: 'LiteError',
        code: 'UNKNOWN',
        message: json.message,
        context: {},
        remediation: DEFAULT_REMEDIATION,
      },
    });
  }
  return new Error(wire);
}

/**
 * Wrap an `ipcMain.handle` listener so ANYTHING it throws crosses the
 * IPC boundary as a parseable envelope -- typed module errors keep
 * their code, unknown errors surface as `{ code: 'UNKNOWN', message }`
 * instead of Electron's opaque "Error invoking remote method".
 *
 * Wrap at the registration site; handler bodies stay untouched (their
 * own catch blocks keep doing contextual logging and rethrow raw):
 *
 *   ipcMain.handle(
 *     NEON_IPC.STATUS,
 *     wrapIpcHandler('__neonError', async (_event) => {
 *       return getNeonApi().status();
 *     })
 *   );
 */
export function wrapIpcHandler<Args extends unknown[], R>(
  marker: string,
  handler: (...args: Args) => R
): (...args: Args) => Promise<Awaited<R>> {
  return async (...args: Args): Promise<Awaited<R>> => {
    try {
      return await handler(...args);
    } catch (err) {
      throw envelopeIpcError(marker, err);
    }
  };
}

function formatCause(cause: unknown): string {
  if (cause instanceof Error) {
    return `${cause.name}: ${cause.message}`;
  }
  if (typeof cause === 'string') return cause;
  try {
    return JSON.stringify(cause);
  } catch {
    return String(cause);
  }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, val) => {
      if (typeof val === 'string' && val.length > 200) {
        return `${val.slice(0, 200)}...[truncated ${val.length - 200} chars]`;
      }
      return val;
    });
  } catch {
    return '[unserializable]';
  }
}
