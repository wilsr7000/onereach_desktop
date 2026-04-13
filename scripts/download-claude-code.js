#!/usr/bin/env node

/**
 * Download Claude Code Binary Script
 *
 * Downloads the Claude Code CLI binary for the current platform
 * or all platforms when building for release.
 *
 * On every run, checks the installed version against the latest on npm.
 * Only re-downloads when a newer version is available.
 *
 * Usage:
 *   node scripts/download-claude-code.js           # Download/update for current platform
 *   node scripts/download-claude-code.js --all     # Download/update for all platforms
 *   node scripts/download-claude-code.js --force   # Force re-download even if up to date
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Configuration
const RESOURCES_DIR = path.join(__dirname, '..', 'resources', 'claude-code');

// Platform mapping
// Note: These URLs are placeholders - actual URLs depend on how Anthropic distributes binaries
const PLATFORMS = {
  'darwin-arm64': {
    binaryName: 'claude',
    archiveName: 'claude-code-macos-arm64.tar.gz',
  },
  'darwin-x64': {
    binaryName: 'claude',
    archiveName: 'claude-code-macos-x64.tar.gz',
  },
  'win32-x64': {
    binaryName: 'claude.exe',
    archiveName: 'claude-code-windows-x64.zip',
  },
  'linux-x64': {
    binaryName: 'claude',
    archiveName: 'claude-code-linux-x64.tar.gz',
  },
};

/**
 * Get current platform identifier
 */
function getCurrentPlatform() {
  const platform = process.platform;
  const arch = process.arch;
  return `${platform}-${arch}`;
}

/**
 * Get the installed version of Claude Code in a target directory.
 * Returns the semver string or null if not installed.
 */
function getInstalledVersion(targetDir) {
  try {
    const pkgPath = path.join(targetDir, 'node_modules', '@anthropic-ai', 'claude-code', 'package.json');
    if (!fs.existsSync(pkgPath)) return null;
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    return pkg.version || null;
  } catch {
    return null;
  }
}

/**
 * Get the latest published version of @anthropic-ai/claude-code from npm.
 * Returns the semver string or null on failure.
 */
function getLatestNpmVersion() {
  try {
    const result = execSync('npm view @anthropic-ai/claude-code version', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30000,
    });
    return result.trim() || null;
  } catch (error) {
    console.warn('[download-claude-code] Could not fetch latest version from npm:', error.message);
    return null;
  }
}

/**
 * Check if Claude Code is already installed globally via npm
 */
function checkGlobalInstall() {
  try {
    const result = execSync('claude --version', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
    console.log(`[download-claude-code] Found global Claude Code: ${result.trim()}`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Install Claude Code via npm (alternative to binary download)
 */
async function installViaNpm(targetDir) {
  console.log('[download-claude-code] Installing Claude Code via npm...');

  try {
    // Create a local node_modules in the target directory
    fs.mkdirSync(targetDir, { recursive: true });

    // Install the package locally
    execSync('npm install @anthropic-ai/claude-code --prefix .', {
      cwd: targetDir,
      encoding: 'utf-8',
      stdio: 'inherit',
    });

    console.log('[download-claude-code] npm install completed');
    return true;
  } catch (error) {
    console.error('[download-claude-code] npm install failed:', error.message);
    return false;
  }
}

/**
 * Set executable permissions (Unix only)
 */
function setExecutable(filePath) {
  if (process.platform !== 'win32') {
    fs.chmodSync(filePath, 0o755);
    console.log(`[download-claude-code] Set executable: ${filePath}`);
  }
}

/**
 * Download or update Claude Code for a specific platform.
 * Checks the installed version vs latest on npm and only re-installs when needed.
 */
async function downloadForPlatform(platformKey, { forceUpdate = false, latestVersion = null } = {}) {
  const platformInfo = PLATFORMS[platformKey];
  if (!platformInfo) {
    console.warn(`[download-claude-code] Unknown platform: ${platformKey}`);
    return false;
  }

  const destDir = path.join(RESOURCES_DIR, platformKey);
  const binaryPath = path.join(destDir, platformInfo.binaryName);

  const installedVersion = getInstalledVersion(destDir);

  if (installedVersion && !forceUpdate) {
    if (latestVersion && installedVersion === latestVersion) {
      console.log(`[download-claude-code] ${platformKey}: already at latest v${installedVersion} -- skipping`);
      return true;
    }
    if (latestVersion) {
      console.log(`[download-claude-code] ${platformKey}: upgrading v${installedVersion} -> v${latestVersion}`);
    } else {
      console.log(`[download-claude-code] ${platformKey}: installed v${installedVersion}, could not determine latest -- re-installing to be safe`);
    }
  } else if (installedVersion && forceUpdate) {
    console.log(`[download-claude-code] ${platformKey}: force update requested (current v${installedVersion})`);
  } else {
    console.log(`[download-claude-code] ${platformKey}: not installed -- installing fresh`);
  }

  // Clean out old install so npm gets the latest
  if (fs.existsSync(destDir)) {
    const nodeModulesDir = path.join(destDir, 'node_modules');
    if (fs.existsSync(nodeModulesDir)) {
      fs.rmSync(nodeModulesDir, { recursive: true, force: true });
    }
    // Also remove old wrapper and package files so we start clean
    for (const f of ['package.json', 'package-lock.json', platformInfo.binaryName]) {
      const p = path.join(destDir, f);
      if (fs.existsSync(p)) fs.rmSync(p, { force: true });
    }
  }

  fs.mkdirSync(destDir, { recursive: true });

  console.log(`[download-claude-code] Platform: ${platformKey}`);

  const wrapperContent =
    process.platform === 'win32'
      ? `@echo off\nnode "%~dp0node_modules\\@anthropic-ai\\claude-code\\cli.js" %*`
      : `#!/bin/sh\nexec node "$(dirname "$0")/node_modules/@anthropic-ai/claude-code/cli.js" "$@"`;

  const wrapperPath = binaryPath;

  const success = await installViaNpm(destDir);
  if (success) {
    fs.writeFileSync(wrapperPath, wrapperContent);
    setExecutable(wrapperPath);
    const newVersion = getInstalledVersion(destDir);
    console.log(`[download-claude-code] Installed v${newVersion} -> ${wrapperPath}`);
    return true;
  }

  return false;
}

/**
 * Main function
 */
async function main() {
  const args = process.argv.slice(2);
  const downloadAll = args.includes('--all');
  const forceUpdate = args.includes('--force');

  console.log('[download-claude-code] Starting Claude Code download/update...');
  console.log(`[download-claude-code] Resources directory: ${RESOURCES_DIR}`);

  if (checkGlobalInstall()) {
    console.log('[download-claude-code] Global Claude Code found - development will use global install');
  }

  // Fetch latest version once -- shared across all platforms
  console.log('[download-claude-code] Checking latest version on npm...');
  const latestVersion = getLatestNpmVersion();
  if (latestVersion) {
    console.log(`[download-claude-code] Latest npm version: ${latestVersion}`);
  } else {
    console.warn('[download-claude-code] Could not determine latest version -- will install/reinstall');
  }

  const opts = { forceUpdate, latestVersion };

  if (downloadAll) {
    console.log('[download-claude-code] Processing all platforms...');

    for (const platform of Object.keys(PLATFORMS)) {
      console.log(`\n[download-claude-code] === ${platform} ===`);
      try {
        await downloadForPlatform(platform, opts);
      } catch (error) {
        console.error(`[download-claude-code] Failed for ${platform}:`, error.message);
      }
    }
  } else {
    const currentPlatform = getCurrentPlatform();
    console.log(`[download-claude-code] Current platform: ${currentPlatform}`);

    try {
      await downloadForPlatform(currentPlatform, opts);
    } catch (error) {
      console.error('[download-claude-code] Download failed:', error.message);
      process.exit(1);
    }
  }

  console.log('\n[download-claude-code] Done!');
}

// Run
main().catch((error) => {
  console.error('[download-claude-code] Fatal error:', error);
  process.exit(1);
});
