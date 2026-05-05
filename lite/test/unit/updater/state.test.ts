/**
 * Unit tests for lite/updater/state.ts -- update-state.json read/write/clear.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import {
  readUpdateState,
  writeUpdateState,
  clearUpdateState,
  updateStateFile,
} from '../../../updater/state.js';

let userDataDir: string;

beforeEach(async () => {
  userDataDir = await fs.mkdtemp(path.join(tmpdir(), 'lite-state-test-'));
});

afterEach(async () => {
  await fs.rm(userDataDir, { recursive: true, force: true });
});

describe('updateStateFile', () => {
  it('returns userData/update-state.json', () => {
    expect(updateStateFile('/foo/bar')).toBe(path.join('/foo/bar', 'update-state.json'));
  });
});

describe('readUpdateState', () => {
  it('returns the empty default when the file does not exist', () => {
    const state = readUpdateState(userDataDir);
    expect(state).toEqual({
      failedAttempts: 0,
      lastAttemptVersion: null,
      lastAttemptTime: null,
      lastFailedVersions: [],
    });
  });

  it('reads back what writeUpdateState wrote', () => {
    writeUpdateState(userDataDir, {
      failedAttempts: 2,
      lastAttemptVersion: '1.2.3',
      lastAttemptTime: '2026-01-01T00:00:00.000Z',
      lastFailedVersions: ['1.0.0'],
    });
    const state = readUpdateState(userDataDir);
    expect(state).toEqual({
      failedAttempts: 2,
      lastAttemptVersion: '1.2.3',
      lastAttemptTime: '2026-01-01T00:00:00.000Z',
      lastFailedVersions: ['1.0.0'],
    });
  });

  it('recovers from a corrupt file by returning the empty default', async () => {
    await fs.writeFile(updateStateFile(userDataDir), 'not json{{{');
    const state = readUpdateState(userDataDir);
    expect(state).toEqual({
      failedAttempts: 0,
      lastAttemptVersion: null,
      lastAttemptTime: null,
      lastFailedVersions: [],
    });
  });

  it('coerces missing or wrong-type fields to defaults', async () => {
    await fs.writeFile(updateStateFile(userDataDir), JSON.stringify({ failedAttempts: 'oops' }));
    const state = readUpdateState(userDataDir);
    expect(state.failedAttempts).toBe(0);
    expect(state.lastAttemptVersion).toBeNull();
    expect(state.lastAttemptTime).toBeNull();
  });
});

describe('clearUpdateState', () => {
  it('resets to the empty state on disk', () => {
    writeUpdateState(userDataDir, {
      failedAttempts: 5,
      lastAttemptVersion: '9.9.9',
      lastAttemptTime: 'whenever',
      lastFailedVersions: ['1.0.0', '2.0.0'],
    });
    clearUpdateState(userDataDir);
    expect(readUpdateState(userDataDir)).toEqual({
      failedAttempts: 0,
      lastAttemptVersion: null,
      lastAttemptTime: null,
      lastFailedVersions: [],
    });
  });
});
