/**
 * Where the test suite's AI key comes from.
 *
 * The rule this file defends: a test that needs a model uses the key the
 * USER configured in Settings → AI, not one the suite happens to find in
 * its own shell. A suite wired only to `ANTHROPIC_API_KEY` passes on a
 * developer's machine and skips silently everywhere else — including on
 * the machine of the person who pasted a key into the app and reasonably
 * expects the tests to use it.
 *
 * So this pins three things about `harness/ai-key.ts`:
 *   1. the keychain (Settings → AI) outranks env, which outranks the file,
 *   2. it looks for `ai-config.json` in the directory the APP actually
 *      uses (so the product name can't drift out from under it),
 *   3. nothing it returns for logging contains the secret.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

import {
  LITE_PRODUCT_NAME,
  liteUserDataDir,
  fingerprintSecret,
  buildAppAiCredentials,
  describeAiCredentials,
} from '../harness/ai-key.js';

const KEYCHAIN = 'sk-ant-from-the-app-settings';
const ENV = 'sk-ant-from-the-shell';
const FILE_JSON = JSON.stringify({ claude: { apiKey: 'sk-ant-from-the-file' } });

describe('the key the suite runs with is the key the app is configured with', () => {
  it('prefers Settings → AI (keychain) over both the env var and the file', () => {
    const found = buildAppAiCredentials({ ANTHROPIC_API_KEY: ENV }, FILE_JSON, KEYCHAIN);
    expect(found?.config.provider).toBe('claude');
    if (found?.config.provider !== 'claude') throw new Error('expected a claude config');
    expect(found.config.apiKey).toBe(KEYCHAIN);
    expect(found.source).toBe('app-settings-keychain');
  });

  it('falls back to the env var when nothing is in Settings → AI', () => {
    const found = buildAppAiCredentials({ ANTHROPIC_API_KEY: ENV }, FILE_JSON, null);
    if (found?.config.provider !== 'claude') throw new Error('expected a claude config');
    expect(found.config.apiKey).toBe(ENV);
    expect(found.source).toBe('env');
  });

  it('falls back to ai-config.json when neither of the other two is set', () => {
    const found = buildAppAiCredentials({}, FILE_JSON, null);
    if (found?.config.provider !== 'claude') throw new Error('expected a claude config');
    expect(found.config.apiKey).toBe('sk-ant-from-the-file');
    expect(found.source).toBe('ai-config.json');
  });

  it('reports "nothing configured" rather than inventing a key', () => {
    expect(buildAppAiCredentials({}, null, null)).toBeNull();
    // A blank keychain entry is not a key — it must not shadow the env var.
    const blanked = buildAppAiCredentials({ ANTHROPIC_API_KEY: ENV }, null, '   ');
    if (blanked?.config.provider !== 'claude') throw new Error('expected a claude config');
    expect(blanked.config.apiKey).toBe(ENV);
  });

  it('carries the OneReach flow through when that is how the app is set up', () => {
    const found = buildAppAiCredentials(
      { ONEREACH_FLOW_URL: 'https://flow.example/run' },
      null,
      null
    );
    expect(found?.config.provider).toBe('onereach-flow');
  });
});

describe('ai-config.json is read from the directory the app really uses', () => {
  it('uses the app product name under the platform config root', () => {
    expect(liteUserDataDir('darwin')).toBe(
      join(homedir(), 'Library', 'Application Support', LITE_PRODUCT_NAME)
    );
    expect(liteUserDataDir('linux')).toBe(join(homedir(), '.config', LITE_PRODUCT_NAME));
  });

  it('honours LITE_USER_DATA_DIR, so a side-by-side dev profile is read, not the installed app', () => {
    const prior = process.env['LITE_USER_DATA_DIR'];
    process.env['LITE_USER_DATA_DIR'] = '/tmp/lite-dev-profile';
    try {
      expect(liteUserDataDir('darwin')).toBe('/tmp/lite-dev-profile');
    } finally {
      if (prior === undefined) delete process.env['LITE_USER_DATA_DIR'];
      else process.env['LITE_USER_DATA_DIR'] = prior;
    }
  });

  it('the product name matches main-lite.ts — the harness copy cannot drift', () => {
    // main-lite.ts can't be imported (it boots Electron), so the constant
    // is duplicated in the harness. This is the seam that keeps the two
    // honest: rename the app and this fails loudly instead of silently
    // reading an empty directory.
    const src = readFileSync(resolve(__dirname, '..', '..', 'main-lite.ts'), 'utf8');
    const m = /const LITE_PRODUCT_NAME = '([^']+)'/.exec(src);
    expect(m?.[1], 'LITE_PRODUCT_NAME not found in main-lite.ts').toBeDefined();
    expect(LITE_PRODUCT_NAME).toBe(m?.[1]);
  });
});

describe('a key never reaches a log line', () => {
  it('the fingerprint is a hash — no prefix, suffix or slice of the key', () => {
    const fp = fingerprintSecret(KEYCHAIN);
    expect(fp.startsWith('sha256:')).toBe(true);
    expect(fp).not.toContain(KEYCHAIN);
    // Not even the tail, which is the conventional (and still leaky) habit.
    expect(fp).not.toContain(KEYCHAIN.slice(-4));
    expect(fp).toBe(fingerprintSecret(KEYCHAIN)); // stable
    expect(fp).not.toBe(fingerprintSecret(ENV)); // and distinguishing
  });

  it('the human-readable status names the source, never the secret', () => {
    const found = buildAppAiCredentials({ ANTHROPIC_API_KEY: ENV }, FILE_JSON, KEYCHAIN);
    const line = describeAiCredentials(found);
    expect(line).toContain('source=app-settings-keychain');
    expect(line).not.toContain(KEYCHAIN);
    expect(line).not.toContain(ENV);
  });

  it('says how to configure one when there is none', () => {
    const line = describeAiCredentials(null);
    expect(line).toContain('Settings → AI');
    expect(line).toContain('ANTHROPIC_API_KEY');
  });
});
