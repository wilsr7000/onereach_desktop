/**
 * Bug-report redaction patterns -- mandatory default-on scrubbing
 * applied BEFORE the user sees the captured payload. Per ADR-008,
 * this cannot be opted out of -- the redacted payload is the only
 * payload the user can see and edit.
 *
 * Versioned + auditable. Phase 3 security review revisits this file.
 *
 * Detected matches are masked as `[REDACTED:KIND]`. The mask preserves
 * a coarse signal that something was there without leaking length.
 */

export interface RedactionPattern {
  /** Stable name used in the [REDACTED:KIND] mask */
  kind: string;
  /** Regex pattern, must use the global flag */
  pattern: RegExp;
  /** Human-readable description for audit */
  description: string;
}

/**
 * Baseline redaction patterns. Order matters: more specific patterns
 * should come before more general ones to prevent double-masking.
 */
export const REDACTION_PATTERNS: ReadonlyArray<RedactionPattern> = [
  {
    kind: 'OPENAI_KEY',
    pattern: /sk-[A-Za-z0-9]{20,}/g,
    description: 'OpenAI API key (sk-...)',
  },
  {
    kind: 'AWS_ACCESS_KEY',
    pattern: /AKIA[0-9A-Z]{16}/g,
    description: 'AWS access key ID (AKIA...)',
  },
  {
    kind: 'GITHUB_PAT',
    pattern: /ghp_[A-Za-z0-9]{36}/g,
    description: 'GitHub Personal Access Token (ghp_...)',
  },
  {
    kind: 'GITHUB_OAUTH',
    pattern: /gho_[A-Za-z0-9]{36}/g,
    description: 'GitHub OAuth token (gho_...)',
  },
  {
    kind: 'JWT',
    pattern: /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
    description: 'JSON Web Token (header.payload.signature)',
  },
  {
    kind: 'BEARER_TOKEN',
    pattern: /Bearer\s+[A-Za-z0-9._\-=]+/gi,
    description: 'Authorization Bearer token',
  },
  {
    kind: 'API_KEY_ENV',
    pattern: /\b(OPENAI|ANTHROPIC|ELEVENLABS|GITHUB|AWS|GOOGLE|AZURE)_(API_)?(KEY|SECRET|TOKEN)\s*[=:]\s*\S+/gi,
    description: 'Common API key env-var idioms (OPENAI_API_KEY=..., ANTHROPIC_API_KEY=...)',
  },
];

/**
 * Apply all redaction patterns to a string. Returns the redacted text and
 * a count of matches per pattern kind (for cohort-aggregated telemetry --
 * counts are NEVER per-user-attributable per ADR-008).
 */
export interface RedactionResult {
  text: string;
  /** Total number of redactions performed (sum across all patterns) */
  totalCount: number;
  /** Per-kind counts for cohort-aggregated telemetry */
  counts: Record<string, number>;
}

export function redact(input: string): RedactionResult {
  let text = input;
  const counts: Record<string, number> = {};
  let totalCount = 0;

  for (const { kind, pattern } of REDACTION_PATTERNS) {
    let kindCount = 0;
    text = text.replace(pattern, () => {
      kindCount += 1;
      return `[REDACTED:${kind}]`;
    });
    if (kindCount > 0) {
      counts[kind] = kindCount;
      totalCount += kindCount;
    }
  }

  return { text, totalCount, counts };
}

/**
 * Convert a per-kind redaction count map into a coarse cohort bucket.
 * Per ADR-008: telemetry is bucketed (low/medium/high), not absolute.
 */
export type RedactionBucket = 'none' | 'low' | 'medium' | 'high';

export function bucketFor(totalCount: number): RedactionBucket {
  if (totalCount === 0) return 'none';
  if (totalCount <= 2) return 'low';
  if (totalCount <= 10) return 'medium';
  return 'high';
}
