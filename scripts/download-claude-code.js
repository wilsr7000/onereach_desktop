#!/usr/bin/env node

/**
 * Download Claude Code Binary Script
 *
 * Downloads the Claude Code CLI binary for the current platform
 * or all platforms when building for release.
 *
 * Usage:
 *   node scripts/download-claude-code.js           # Download for current platform
 *   node scripts/download-claude-code.js --all     # Download for all platforms
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Configuration
const _CLAUDE_CODE_VERSION = 'latest'; // or specific version like 'v1.0.0'
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
 * Download Claude Code binary for a specific platform
 */
async function downloadForPlatform(platformKey) {
  const platformInfo = PLATFORMS[platformKey];
  if (!platformInfo) {
    console.warn(`[download-claude-code] Unknown platform: ${platformKey}`);
    return false;
  }

  const destDir = path.join(RESOURCES_DIR, platformKey);
  const binaryPath = path.join(destDir, platformInfo.binaryName);

  // Check if already downloaded
  if (fs.existsSync(binaryPath)) {
    console.log(`[download-claude-code] Binary already exists: ${binaryPath}`);
    return true;
  }

  // Create destination directory
  fs.mkdirSync(destDir, { recursive: true });

  // For now, we'll use npm install as the primary method
  // Binary download can be implemented when Anthropic provides direct binary downloads
  console.log(`[download-claude-code] Platform: ${platformKey}`);
  console.log('[download-claude-code] Note: Direct binary download not yet available.');
  console.log('[download-claude-code] Using npm install method instead.');

  // Create a wrapper script that calls the npm-installed CLI
  const wrapperContent =
    process.platform === 'win32'
      ? `@echo off\nnode "%~dp0node_modules\\@anthropic-ai\\claude-code\\cli.js" %*`
      : `#!/bin/sh\nexec node "$(dirname "$0")/node_modules/@anthropic-ai/claude-code/cli.js" "$@"`;

  const wrapperPath = binaryPath;

  // Install via npm
  const success = await installViaNpm(destDir);
  if (success) {
    // Create wrapper script
    fs.writeFileSync(wrapperPath, wrapperContent);
    setExecutable(wrapperPath);
    console.log(`[download-claude-code] Created wrapper: ${wrapperPath}`);
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

  console.log('[download-claude-code] Starting Claude Code download...');
  console.log(`[download-claude-code] Resources directory: ${RESOURCES_DIR}`);

  // Check global install
  if (checkGlobalInstall()) {
    console.log('[download-claude-code] Global Claude Code found - development will use global install');
  }

  if (downloadAll) {
    // Download for all platforms (for release builds)
    console.log('[download-claude-code] Downloading for all platforms...');

    for (const platform of Object.keys(PLATFORMS)) {
      console.log(`\n[download-claude-code] === ${platform} ===`);
      try {
        await downloadForPlatform(platform);
      } catch (error) {
        console.error(`[download-claude-code] Failed for ${platform}:`, error.message);
      }
    }
  } else {
    // Download for current platform only
    const currentPlatform = getCurrentPlatform();
    console.log(`[download-claude-code] Current platform: ${currentPlatform}`);

    try {
      await downloadForPlatform(currentPlatform);
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
