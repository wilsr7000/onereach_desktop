/**
 * Unit tests for lib/neo4j-credentials.js
 *
 * Covers the three public functions:
 *   - parseAuraCredentialsFile(): canonical Aura .txt format, comments,
 *     trailing whitespace, missing password, quoted values
 *   - applyToSettings(): persists into settings AND pushes to live OmniGraph
 *     client; never logs the password in plain text
 *   - loadFromSettings(): no-op when password is unset; configures the live
 *     client when the four keys are present
 *   - _redact(): correctly hides secrets in logs
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('../../lib/log-event-queue', () => ({
  getLogQueue: () => ({ info: () => {}, warn: () => {}, error: () => {} }),
}));

const {
  parseAuraCredentialsFile,
  applyToSettings,
  loadFromSettings,
  SETTINGS_KEYS,
  _redact,
} = require('../../lib/neo4j-credentials');

const SAMPLE_AURA_TXT = `# Wait 60 seconds before connecting using these details, or login to https://console.neo4j.io
NEO4J_URI=neo4j+s://40c812ef.databases.neo4j.io
NEO4J_USERNAME=neo4j
NEO4J_PASSWORD=oCLF5bxkj66qivVDh1biePK7Byo9U1NUvFLJrHnQjzo
NEO4J_DATABASE=neo4j
AURA_INSTANCEID=40c812ef
AURA_INSTANCENAME=Instance01
`;

function writeTempFile(contents, suffix = 'neo4j-creds.txt') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neo4j-creds-test-'));
  const file = path.join(dir, suffix);
  fs.writeFileSync(file, contents, 'utf8');
  return file;
}

function makeFakeSettings() {
  const store = new Map();
  return {
    get: (k) => (store.has(k) ? store.get(k) : undefined),
    set: (k, v) => store.set(k, v),
    _store: store,
  };
}

function makeFakeOmniClient() {
  const config = { neo4jPassword: null, neo4jUri: null, neo4jUser: 'neo4j', database: 'neo4j' };
  return {
    setNeo4jConfig(c) {
      Object.assign(config, c);
    },
    setNeo4jPassword(p) {
      config.neo4jPassword = p;
    },
    isReady() {
      return !!config.neo4jPassword;
    },
    _config: config,
  };
}

// ────────────────────────────────────────────────────────────────────────────

describe('neo4j-credentials', () => {
  describe('parseAuraCredentialsFile', () => {
    it('parses the canonical Aura .txt file shape', () => {
      const file = writeTempFile(SAMPLE_AURA_TXT);
      const creds = parseAuraCredentialsFile(file);
      expect(creds.uri).toBe('neo4j+s://40c812ef.databases.neo4j.io');
      expect(creds.username).toBe('neo4j');
      expect(creds.password).toBe('oCLF5bxkj66qivVDh1biePK7Byo9U1NUvFLJrHnQjzo');
      expect(creds.database).toBe('neo4j');
      expect(creds.instanceId).toBe('40c812ef');
      expect(creds.instanceName).toBe('Instance01');
    });

    it('ignores leading "#" comment lines', () => {
      const file = writeTempFile(
        '# this is a comment\n# and another\nNEO4J_URI=neo4j+s://x.databases.neo4j.io\nNEO4J_PASSWORD=p\n'
      );
      const creds = parseAuraCredentialsFile(file);
      expect(creds.uri).toBe('neo4j+s://x.databases.neo4j.io');
      expect(creds.password).toBe('p');
    });

    it('tolerates blank lines + trailing whitespace', () => {
      const file = writeTempFile(
        '\n\nNEO4J_URI=neo4j+s://x.databases.neo4j.io   \n   NEO4J_PASSWORD=secret  \n\n'
      );
      const creds = parseAuraCredentialsFile(file);
      expect(creds.uri).toBe('neo4j+s://x.databases.neo4j.io');
      expect(creds.password).toBe('secret');
    });

    it('strips matched single or double quotes from values', () => {
      const file = writeTempFile(
        'NEO4J_URI="neo4j+s://x.databases.neo4j.io"\nNEO4J_PASSWORD=\'pa$$w0rd\'\n'
      );
      const creds = parseAuraCredentialsFile(file);
      expect(creds.uri).toBe('neo4j+s://x.databases.neo4j.io');
      expect(creds.password).toBe('pa$$w0rd');
    });

    it('rejects a file missing NEO4J_PASSWORD with a clear error', () => {
      const file = writeTempFile('NEO4J_URI=neo4j+s://x.databases.neo4j.io\nNEO4J_USERNAME=neo4j\n');
      expect(() => parseAuraCredentialsFile(file)).toThrow(/NEO4J_PASSWORD/);
    });

    it('throws when the file does not exist', () => {
      expect(() => parseAuraCredentialsFile('/tmp/__definitely_not_a_real_file__.txt')).toThrow(
        /not found/i
      );
    });

    it('falls back to defaults for username + database when missing', () => {
      const file = writeTempFile(
        'NEO4J_URI=neo4j+s://x.databases.neo4j.io\nNEO4J_PASSWORD=p\n'
      );
      const creds = parseAuraCredentialsFile(file);
      expect(creds.username).toBe('neo4j');
      expect(creds.database).toBe('neo4j');
    });
  });

  describe('applyToSettings', () => {
    let settings;
    let omniClient;

    beforeEach(() => {
      settings = makeFakeSettings();
      omniClient = makeFakeOmniClient();
    });

    it('persists all four neo4j settings keys', () => {
      applyToSettings(
        {
          uri: 'neo4j+s://x.databases.neo4j.io',
          username: 'neo4j',
          password: 'secret',
          database: 'neo4j',
        },
        { settingsManager: settings, omniClient }
      );
      expect(settings.get(SETTINGS_KEYS.password)).toBe('secret');
      expect(settings.get(SETTINGS_KEYS.uri)).toBe('neo4j+s://x.databases.neo4j.io');
      expect(settings.get(SETTINGS_KEYS.user)).toBe('neo4j');
      expect(settings.get(SETTINGS_KEYS.database)).toBe('neo4j');
    });

    it('pushes config into the live OmniGraph client immediately', () => {
      applyToSettings(
        {
          uri: 'neo4j+s://x.databases.neo4j.io',
          username: 'neo4j',
          password: 'secret-key-xyz',
          database: 'neo4j',
        },
        { settingsManager: settings, omniClient }
      );
      expect(omniClient.isReady()).toBe(true);
      expect(omniClient._config.neo4jPassword).toBe('secret-key-xyz');
      expect(omniClient._config.neo4jUri).toBe('neo4j+s://x.databases.neo4j.io');
    });

    it('refuses to apply without a password', () => {
      expect(() =>
        applyToSettings({ uri: 'x', username: 'neo4j', database: 'neo4j' }, { settingsManager: settings })
      ).toThrow(/password is required/i);
    });

    it('returns a redacted echo of the password (not the raw value)', () => {
      const result = applyToSettings(
        { password: 'oCLF5bxkj66qivVDh1biePK7Byo9U1NUvFLJrHnQjzo' },
        { settingsManager: settings, omniClient }
      );
      expect(result.redactedPassword).not.toContain('oCLF5bxkj66qiv');
      expect(result.redactedPassword.length).toBeLessThan(20);
      expect(result.saved).toBe(true);
      expect(result.applied).toBe(true);
    });

    it('reports applied:false when the omniClient lacks setNeo4jConfig', () => {
      // Passing `null` falls through to the real singleton; to test the
      // applied:false branch we provide a stub that explicitly lacks
      // setNeo4jConfig so _resolveOmniClient returns it but the apply step
      // refuses to call it.
      const stubWithoutSetter = { isReady: () => false };
      const result = applyToSettings(
        { password: 'x' },
        { settingsManager: settings, omniClient: stubWithoutSetter }
      );
      expect(result.saved).toBe(true);
      expect(result.applied).toBe(false);
    });
  });

  describe('loadFromSettings', () => {
    it('returns configured:false when no password is in settings', () => {
      const settings = makeFakeSettings();
      const omniClient = makeFakeOmniClient();
      const result = loadFromSettings({ settingsManager: settings, omniClient });
      expect(result.configured).toBe(false);
      expect(omniClient.isReady()).toBe(false);
    });

    it('hydrates the live OmniGraph client when settings have a password', () => {
      const settings = makeFakeSettings();
      settings.set(SETTINGS_KEYS.password, 'persisted-password');
      settings.set(SETTINGS_KEYS.uri, 'neo4j+s://saved.databases.neo4j.io');
      settings.set(SETTINGS_KEYS.user, 'neo4j');
      settings.set(SETTINGS_KEYS.database, 'neo4j');
      const omniClient = makeFakeOmniClient();
      const result = loadFromSettings({ settingsManager: settings, omniClient });
      expect(result.configured).toBe(true);
      expect(omniClient.isReady()).toBe(true);
      expect(omniClient._config.neo4jPassword).toBe('persisted-password');
      expect(omniClient._config.neo4jUri).toBe('neo4j+s://saved.databases.neo4j.io');
    });

    it('handles a missing settings manager gracefully', () => {
      const result = loadFromSettings({ settingsManager: null });
      expect(result.configured).toBe(false);
    });
  });

  describe('_redact', () => {
    it('hides full secrets longer than 8 chars', () => {
      const r = _redact('oCLF5bxkj66qivVDh1biePK7Byo9U1NUvFLJrHnQjzo');
      expect(r).not.toContain('5bxkj66qiv');
      expect(r.startsWith('oCLF')).toBe(true);
      expect(r.endsWith('zo')).toBe(true);
    });

    it('returns a generic mask for short secrets', () => {
      expect(_redact('shortpw')).toBe('****');
    });

    it('handles empty / null safely', () => {
      expect(_redact('')).toBe('');
      expect(_redact(null)).toBe('');
      expect(_redact(undefined)).toBe('');
    });
  });
});
