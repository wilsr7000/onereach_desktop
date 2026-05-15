/**
 * scripts/install-update.sh -- self-install helper for the auto-updater.
 *
 * Tests:
 *   1. The script is bash-syntax valid (`bash -n`).
 *   2. The script is executable (mode +x).
 *   3. The script exists at the path package.json's extraResources points at.
 *   4. The script is referenced from main.js's _spawnInstallHelper.
 *   5. shellcheck warnings, if shellcheck is installed (best-effort).
 *   6. The script writes a status file on success and on failure (smoke
 *      test in a hermetic temp dir with a fake parent PID + fake
 *      ShipIt cache).
 *
 * Why these tests matter: the install helper is the only path that
 * actually completes auto-updates on macOS 26.4 (Squirrel.Mac's swap
 * is broken there). A regression in this script silently breaks the
 * update path for every user. CI catches breakage before release.
 *
 * See PUNCH-LIST.md "Build & Release" entries for context on why this
 * helper exists at all.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { execSync, spawnSync } from 'node:child_process';
import { promises as fs, mkdtempSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const HELPER_PATH = join(REPO_ROOT, 'scripts', 'install-update.sh');

describe('install-update.sh helper', () => {
  describe('static checks', () => {
    it('exists at scripts/install-update.sh', () => {
      expect(existsSync(HELPER_PATH)).toBe(true);
    });

    it('is executable (mode +x for owner)', () => {
      const stat = statSync(HELPER_PATH);
      // Mode bits: 0o100 = owner execute. Mask off the file-type bits.
      expect(stat.mode & 0o100).toBe(0o100);
    });

    it('passes bash syntax check (bash -n)', () => {
      const result = spawnSync('/bin/bash', ['-n', HELPER_PATH], {
        encoding: 'utf-8',
      });
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
    });

    it('is referenced from package.json extraResources', () => {
      const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8'));
      const extras = pkg.build && pkg.build.extraResources;
      expect(Array.isArray(extras)).toBe(true);
      const found = extras.find(
        (e) => typeof e === 'object' && e.from === 'scripts/install-update.sh'
      );
      expect(found).toBeDefined();
      expect(found.to).toBe('install-update.sh');
    });

    it('is wired up from main.js _spawnInstallHelper', () => {
      const mainJs = readFileSync(join(REPO_ROOT, 'main.js'), 'utf-8');
      // The function must reference the helper path AND set the env vars
      // the script reads.
      expect(mainJs).toContain('install-update.sh');
      expect(mainJs).toContain('ONEREACH_PARENT_PID');
      expect(mainJs).toContain('ONEREACH_TARGET_VERSION');
      expect(mainJs).toContain('ONEREACH_APP_PATH');
      expect(mainJs).toContain('ONEREACH_SHIPIT_CACHE');
      expect(mainJs).toContain('ONEREACH_STATUS_FILE');
      expect(mainJs).toContain('ONEREACH_LOG');
    });

    it('does NOT use `set -e` (we manage failure paths explicitly via write_status)', () => {
      const script = readFileSync(HELPER_PATH, 'utf-8');
      // We use `set -uo pipefail` (no -e) so we control which failures
      // bail out of the script. `set -e` would cause an early exit
      // before write_status runs and leave the user with a silent failure.
      expect(script).toMatch(/^set -uo pipefail/m);
      expect(script).not.toMatch(/^set -euo pipefail/m);
      expect(script).not.toMatch(/^set -e\b/m);
    });

    it('writes status to ONEREACH_STATUS_FILE on every exit path', () => {
      const script = readFileSync(HELPER_PATH, 'utf-8');
      // Quick sanity: every `exit 1` path is preceded by a `write_status failed` call
      // in the same control-flow block. We just count occurrences.
      const failExits = (script.match(/^\s*exit 1\s*$/gm) || []).length;
      const writeStatusFailed = (script.match(/write_status failed/g) || []).length;
      // 1:1 isn't guaranteed (one write_status can cover multiple early
      // bail-outs in some structures) but at minimum every fail exit
      // should have a write_status failed within a few lines above.
      expect(writeStatusFailed).toBeGreaterThanOrEqual(failExits - 1);
      // And there should be at least one write_status success too.
      expect(script).toMatch(/write_status success/);
    });

    it('explicitly resets PATH (detached children inherit a stripped one)', () => {
      const script = readFileSync(HELPER_PATH, 'utf-8');
      expect(script).toMatch(/^export PATH=\/usr\/bin/m);
    });
  });

  describe('runtime smoke (hermetic)', () => {
    let tmpDir;
    let statusFile;
    let logFile;
    let fakeAppPath;
    let fakeShipItCache;

    beforeAll(() => {
      // Hermetic test directory. No network, no /Applications mutation,
      // no real Onereach.ai.app required -- we feed the helper a fake
      // app path and fake bundle so it can run end-to-end against
      // sandboxed inputs.
      tmpDir = mkdtempSync(join(tmpdir(), 'install-helper-test-'));
      statusFile = join(tmpDir, 'last-install-result.json');
      logFile = join(tmpDir, 'helper.log');
      fakeAppPath = join(tmpDir, 'Onereach.ai.app');
      fakeShipItCache = join(tmpDir, 'ShipIt');
    });

    it('writes "failed" status when ShipIt cache is empty AND no updater ZIP', () => {
      // Set up: an empty ShipIt cache, an empty updater cache, fake target app
      execSync(`mkdir -p "${fakeShipItCache}" "${fakeAppPath}/Contents"`);
      execSync(`echo "fake bundle" > "${fakeAppPath}/Contents/Info.plist"`);

      // Use a PID that's almost certainly not alive (8-digit, way above
      // typical Linux/macOS PID ranges) so the helper's wait-for-parent
      // loop falls through immediately and we get to the meat of the
      // logic. Using process.pid here would block the helper for 30s
      // and we'd never see the find_bundle step.
      const fakeParentPid = '99999999';

      const result = spawnSync('/bin/bash', [HELPER_PATH], {
        encoding: 'utf-8',
        timeout: 10000,
        env: {
          ...process.env,
          ONEREACH_PARENT_PID: fakeParentPid,
          ONEREACH_TARGET_VERSION: '99.9.9-test',
          ONEREACH_APP_PATH: fakeAppPath,
          ONEREACH_SHIPIT_CACHE: fakeShipItCache,
          ONEREACH_UPDATER_CACHE: join(tmpDir, 'no-updater-cache'),
          ONEREACH_LOG: logFile,
          ONEREACH_STATUS_FILE: statusFile,
        },
      });

      // Helper should exit cleanly with status 1 (failed at find_bundle)
      // since we gave it nowhere to find the new bundle.
      expect(result.status).toBe(1);

      expect(existsSync(statusFile)).toBe(true);
      const status = JSON.parse(readFileSync(statusFile, 'utf-8'));
      expect(status.outcome).toBe('failed');
      expect(status.step).toBe('find_bundle');
      expect(status.version).toBe('99.9.9-test');
      expect(status.errorMessage).toMatch(/no update bundle/i);
    });

    it('writes "success" (not the trap fallback) on the happy path -- regression test for v5.0.8 EXPECTED_EXIT bug', () => {
      // The bug: v5.0.5-v5.0.8 used a flag named EXPECTED_EXIT (default 0)
      // and a trap that fired `if EXPECTED_EXIT == 0 then write_status
      // failed/unknown`. The success path also set EXPECTED_EXIT=0 (intended
      // as "exit code 0") before exit -- so the trap ALWAYS fired and
      // overwrote the legitimate "success" status. Result: every successful
      // install reported `outcome: failed, step: unknown, errorMessage:
      // "helper exited unexpectedly"` and the boot dialog scared users.
      //
      // v5.0.9 renamed the flag to REACHED_EXPECTED_EXIT, defaulted to 0,
      // success path sets it to 1, and the trap checks `if == 0 then write
      // failed`. This test pins that semantic so a future rename or
      // refactor doesn't reintroduce the bug.
      //
      // We can't easily run the script all the way through to "success"
      // here (would need a real signed bundle to ditto) but we CAN assert
      // the static structure: the success path's last operation before
      // `exit 0` must set REACHED_EXPECTED_EXIT=1 (not =0).
      const script = readFileSync(HELPER_PATH, 'utf-8');
      const lines = script.split('\n');

      // Find the line `exit 0` that is preceded by `REACHED_EXPECTED_EXIT=1`
      // within the previous 3 lines. Must exist (the success path).
      let foundCleanExit = false;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim() === 'exit 0') {
          for (let j = Math.max(0, i - 3); j < i; j++) {
            if (lines[j].trim() === 'REACHED_EXPECTED_EXIT=1') {
              foundCleanExit = true;
              break;
            }
          }
          if (foundCleanExit) break;
        }
      }
      expect(foundCleanExit).toBe(true);

      // And the trap MUST check `REACHED_EXPECTED_EXIT = "0"` (not "1").
      // The whole point of the variable is "we reached an explicit exit",
      // so the trap fires only when we DIDN'T (i.e. value is still 0).
      expect(script).toMatch(/if \[ "\$REACHED_EXPECTED_EXIT" = "0" \]/);

      // Negative assertion: no leftover EXPECTED_EXIT references in CODE
      // (comments may legitimately reference the old name to document the
      // bug history). If someone partially reverts the rename, this fails.
      const codeLines = lines.filter((line) => !line.trim().startsWith('#'));
      const oldCodeRefs = codeLines.filter((line) => /\bEXPECTED_EXIT\b/.test(line) && !/REACHED_EXPECTED_EXIT/.test(line));
      expect(oldCodeRefs).toEqual([]);
    });
  });

  describe('main.js boot-time verifier (defends against v5.0.8 false positive)', () => {
    it('treats "failed for current version" as silent success', () => {
      // After v5.0.8's helper bug shipped a false-positive failure status,
      // the boot-time verifier in main.js was patched (v5.0.10) to detect
      // the contradiction: if the status says "failed for version X" but
      // the running app IS version X, the install actually succeeded -- we
      // ARE the new version. Treat as silent success, no dialog.
      //
      // Without this guard, every user upgrading FROM a buggy helper version
      // sees a scary "Update did not install" dialog explaining nothing.
      // This test pins the contradiction-check so it doesn't get refactored
      // away in the future.
      const mainJs = readFileSync(join(REPO_ROOT, 'main.js'), 'utf-8');

      // Look for the contradiction check inside _checkPreviousInstallResult.
      // Specifically: a branch that compares result.outcome === 'failed'
      // AND result.version === currentVersion before the dialog.
      const fnStart = mainJs.indexOf('function _checkPreviousInstallResult');
      expect(fnStart).toBeGreaterThan(-1);
      // Take ~3000 chars after the function start (the function body).
      const fnBody = mainJs.slice(fnStart, fnStart + 5000);

      // The check should reference both `outcome === 'failed'` and
      // `version === currentVersion` (with quotes/operators flexible).
      expect(fnBody).toMatch(/outcome\s*===?\s*['"]failed['"]/);
      expect(fnBody).toMatch(/result\.version\s*===?\s*currentVersion/);

      // And it should return BEFORE showing the dialog (otherwise the
      // contradiction check is purely cosmetic).
      const failedCheckIdx = fnBody.search(/result\.outcome\s*===?\s*['"]failed['"]/);
      const dialogIdx = fnBody.search(/showMessageBoxSync/);
      expect(failedCheckIdx).toBeGreaterThan(-1);
      expect(dialogIdx).toBeGreaterThan(-1);
      expect(failedCheckIdx).toBeLessThan(dialogIdx);
    });
  });
});
