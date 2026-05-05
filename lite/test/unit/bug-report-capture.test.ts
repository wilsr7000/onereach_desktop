import { describe, it, expect } from 'vitest';
import { capture, migrateLegacyPayload } from '../../bug-report/capture.js';

describe('capture', () => {
  const baseCtx = {
    version: '0.1.0',
    platform: 'darwin' as NodeJS.Platform,
    release: '23.5.0',
    arch: 'arm64',
    recentLogLines: ['2026-05-04T00:00:00Z [INFO] app: booted', '2026-05-04T00:00:01Z [INFO] app: ready'],
    userDescription: 'Something broke when I clicked Quit',
  };

  it('produces a payload with the required schema fields', () => {
    const payload = capture(baseCtx);
    expect(payload.schemaVersion).toBe(1);
    expect(payload.appTag).toBe('lite');
    expect(payload.source).toBe('user-bug-report');
    expect(payload.version).toBe('0.1.0');
    expect(payload.os.platform).toBe('darwin');
    expect(payload.os.release).toBe('23.5.0');
    expect(payload.os.arch).toBe('arm64');
    expect(payload.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('initializes status to "open" and notes to empty string', () => {
    const payload = capture(baseCtx);
    expect(payload.status).toBe('open');
    expect(payload.notes).toBe('');
  });

  it('sets lastModified equal to timestamp on initial capture', () => {
    const payload = capture(baseCtx);
    expect(payload.lastModified).toBe(payload.timestamp);
  });

  it('redacts secrets in user description', () => {
    const payload = capture({
      ...baseCtx,
      userDescription: 'My OpenAI key sk-abcdefghijklmnopqrstuvwx is leaked',
    });
    expect(payload.description).toContain('[REDACTED:OPENAI_KEY]');
    expect(payload.description).not.toContain('sk-abcdefghijklmnopqrstuvwx');
    expect(payload.redactionTelemetry.bucket).not.toBe('none');
    expect(payload.redactionTelemetry.countsByKind.OPENAI_KEY).toBe(1);
  });

  it('redacts secrets in log lines', () => {
    const payload = capture({
      ...baseCtx,
      recentLogLines: ['error: AKIAIOSFODNN7EXAMPLE failed to authenticate'],
      userDescription: 'see logs',
    });
    expect(payload.recentLogs).toContain('[REDACTED:AWS_ACCESS_KEY]');
    expect(payload.redactionTelemetry.countsByKind.AWS_ACCESS_KEY).toBe(1);
  });

  it('aggregates redaction counts across description + logs', () => {
    const payload = capture({
      ...baseCtx,
      recentLogLines: ['AKIAIOSFODNN7EXAMPLE'],
      userDescription: 'sk-abcdefghijklmnopqrstuvwx',
    });
    // 1 OPENAI_KEY in description, 1 AWS_ACCESS_KEY in logs
    expect(payload.redactionTelemetry.countsByKind.OPENAI_KEY).toBe(1);
    expect(payload.redactionTelemetry.countsByKind.AWS_ACCESS_KEY).toBe(1);
  });

  it('reports bucket "none" when no redactions happen', () => {
    const payload = capture(baseCtx);
    expect(payload.redactionTelemetry.bucket).toBe('none');
    expect(Object.keys(payload.redactionTelemetry.countsByKind).length).toBe(0);
  });

  it('joins log lines with newlines in recentLogs', () => {
    const payload = capture({
      ...baseCtx,
      recentLogLines: ['line one', 'line two', 'line three'],
    });
    expect(payload.recentLogs).toBe('line one\nline two\nline three');
  });

  it('handles empty log lines array', () => {
    const payload = capture({ ...baseCtx, recentLogLines: [] });
    expect(payload.recentLogs).toBe('');
  });

  it('handles empty user description', () => {
    const payload = capture({ ...baseCtx, userDescription: '' });
    expect(payload.description).toBe('');
  });

  // ─── Health snapshot integration (ADR-036) ────────────────────────────

  it('omits healthSnapshot when caller did not pass one', () => {
    const payload = capture(baseCtx);
    expect(payload.healthSnapshot).toBeUndefined();
  });

  it('passes healthSnapshot through when caller provides it', () => {
    const TOKEN_SENTINEL = 'eyJ_FAKE_JWT_DO_NOT_LEAK';
    const PASSWORD_SENTINEL = 'NEON_PASSWORD_DO_NOT_LEAK';
    // Build a snapshot whose presence booleans say "yes" but where
    // the type cannot carry the actual token / password values.
    const snapshot: import('../../health/api.js').AppHealthSnapshot = {
      schemaVersion: 1,
      capturedAt: '2026-05-04T17:00:00.000Z',
      app: {
        version: '0.1.0',
        platform: 'darwin',
        arch: 'arm64',
        uptimeMs: 1234,
        userDataPath: '/Users/test/.onereach-lite',
        startedAt: 1_000,
      },
      windows: [
        {
          id: 1,
          title: 'Onereach',
          url: 'file:///app/placeholder.html',
          type: 'main',
          focused: true,
          visible: true,
          destroyed: false,
        },
      ],
      auth: {
        signedIn: true,
        environment: 'edison',
        accountId: 'acc-uuid-1',
        email: 'alice@example.com',
        hasMultToken: true,
        hasAccountToken: true,
        expiresAt: 9_000,
      },
      totp: {
        configured: true,
        metadata: { issuer: 'OneReach', secretLength: 32 },
        hasCurrentCode: true,
        secondsRemaining: 17,
      },
      neon: {
        configured: true,
        ready: true,
        endpoint: 'https://files.edison.api.onereach.ai/flow/neon',
        uri: 'neo4j+s://abc.databases.neo4j.io',
        user: 'neo4j',
        database: 'neo4j',
        hasPassword: true,
      },
      updater: { failedAttempts: 0, lastAttemptVersion: null, lastAttemptTime: null },
      diagnostics: { recentErrorCount: 0, recentWarnCount: 0 },
    };

    const payload = capture({ ...baseCtx, healthSnapshot: snapshot });
    expect(payload.healthSnapshot).toBeDefined();
    expect(payload.healthSnapshot?.auth.signedIn).toBe(true);
    expect(payload.healthSnapshot?.auth.hasMultToken).toBe(true);
    expect(payload.healthSnapshot?.totp.configured).toBe(true);
    expect(payload.healthSnapshot?.neon.hasPassword).toBe(true);

    // The payload is JSON-serializable AND the secret sentinels
    // never appear in the serialized form -- the snapshot type
    // cannot carry them.
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain(TOKEN_SENTINEL);
    expect(serialized).not.toContain(PASSWORD_SENTINEL);
  });

  it('still redacts the description even when a healthSnapshot is attached', () => {
    const snapshot: import('../../health/api.js').AppHealthSnapshot = {
      schemaVersion: 1,
      capturedAt: '2026-05-04T17:00:00.000Z',
      app: {
        version: '0.1.0',
        platform: 'darwin',
        arch: 'arm64',
        uptimeMs: 0,
        userDataPath: '',
        startedAt: 0,
      },
      windows: [],
      auth: {
        signedIn: false,
        environment: 'edison',
        hasMultToken: false,
        hasAccountToken: false,
      },
      totp: { configured: false, hasCurrentCode: false },
      neon: { configured: false, ready: false, hasPassword: false },
      updater: { failedAttempts: 0, lastAttemptVersion: null, lastAttemptTime: null },
      diagnostics: { recentErrorCount: 0, recentWarnCount: 0 },
    };
    const payload = capture({
      ...baseCtx,
      userDescription: 'leaking sk-abcdefghijklmnopqrstuvwx in description',
      healthSnapshot: snapshot,
    });
    expect(payload.description).toContain('[REDACTED:OPENAI_KEY]');
    expect(payload.description).not.toContain('sk-abcdefghijklmnopqrstuvwx');
    expect(payload.healthSnapshot).toBeDefined();
  });
});

describe('migrateLegacyPayload', () => {
  it('defaults status to "open" when missing', () => {
    const legacy = {
      schemaVersion: 1,
      timestamp: '2026-05-04T01:00:00.000Z',
      appTag: 'lite',
      source: 'user-bug-report',
      version: '5.0.0',
      os: { platform: 'darwin', release: '23.0', arch: 'arm64' },
      description: 'old report',
      recentLogs: 'log',
      redactionTelemetry: { bucket: 'none', countsByKind: {} },
    };
    const migrated = migrateLegacyPayload(legacy as Record<string, unknown>);
    expect(migrated.status).toBe('open');
    expect(migrated.notes).toBe('');
    expect(migrated.lastModified).toBe(legacy.timestamp);
  });

  it('preserves existing status and notes when present', () => {
    const v2 = {
      schemaVersion: 1,
      timestamp: '2026-05-04T01:00:00.000Z',
      appTag: 'lite',
      source: 'user-bug-report',
      version: '5.0.0',
      os: { platform: 'darwin', release: '23.0', arch: 'arm64' },
      description: 'modern',
      recentLogs: '',
      redactionTelemetry: { bucket: 'none', countsByKind: {} },
      status: 'resolved' as const,
      notes: 'fixed in v5.0.1',
      lastModified: '2026-05-04T02:00:00.000Z',
    };
    const migrated = migrateLegacyPayload(v2 as Record<string, unknown>);
    expect(migrated.status).toBe('resolved');
    expect(migrated.notes).toBe('fixed in v5.0.1');
    expect(migrated.lastModified).toBe('2026-05-04T02:00:00.000Z');
  });

  it('coerces invalid status values to "open"', () => {
    const garbage = {
      timestamp: '2026-05-04T00:00:00.000Z',
      version: '5.0.0',
      description: 'x',
      status: 'invalid-state',
    };
    const migrated = migrateLegacyPayload(garbage as Record<string, unknown>);
    expect(migrated.status).toBe('open');
  });

  it('preserves an attached healthSnapshot through migration', () => {
    const snapshot: import('../../health/api.js').AppHealthSnapshot = {
      schemaVersion: 1,
      capturedAt: '2026-05-04T17:00:00.000Z',
      app: {
        version: '5.0.0',
        platform: 'darwin',
        arch: 'arm64',
        uptimeMs: 0,
        userDataPath: '',
        startedAt: 0,
      },
      windows: [],
      auth: {
        signedIn: false,
        environment: 'edison',
        hasMultToken: false,
        hasAccountToken: false,
      },
      totp: { configured: false, hasCurrentCode: false },
      neon: { configured: false, ready: false, hasPassword: false },
      updater: { failedAttempts: 0, lastAttemptVersion: null, lastAttemptTime: null },
      diagnostics: { recentErrorCount: 0, recentWarnCount: 0 },
    };
    const payload = {
      timestamp: '2026-05-04T00:00:00.000Z',
      version: '5.0.0',
      description: 'x',
      healthSnapshot: snapshot,
    };
    const migrated = migrateLegacyPayload(payload as Record<string, unknown>);
    expect(migrated.healthSnapshot).toEqual(snapshot);
  });

  it('omits healthSnapshot for pre-ADR-036 payloads', () => {
    const legacy = {
      timestamp: '2026-05-04T00:00:00.000Z',
      version: '4.9.0',
      description: 'old',
    };
    const migrated = migrateLegacyPayload(legacy as Record<string, unknown>);
    expect(migrated.healthSnapshot).toBeUndefined();
  });
});
