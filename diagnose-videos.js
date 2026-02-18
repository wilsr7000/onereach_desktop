#!/usr/bin/env node

/**
 * Video File Diagnostic Tool
 *
 * Checks the integrity of video items in OR-Spaces storage
 * and reports any missing files, corrupted metadata, or orphaned entries.
 *
 * Usage:
 *   node diagnose-videos.js                  # Check all videos
 *   node diagnose-videos.js <itemId>         # Check specific video
 *   node diagnose-videos.js --space <id>     # Check videos in a space
 *   node diagnose-videos.js --fix            # Attempt to fix issues
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// Storage paths
const STORAGE_ROOT = path.join(os.homedir(), 'Documents', 'OR-Spaces');
const INDEX_PATH = path.join(STORAGE_ROOT, 'index.json');
const ITEMS_DIR = path.join(STORAGE_ROOT, 'items');

// Video extensions
const VIDEO_EXTENSIONS = ['.mp4', '.avi', '.mov', '.wmv', '.flv', '.mkv', '.webm', '.m4v', '.mpg', '.mpeg'];

// Colors for terminal output
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

function log(level, message, data = null) {
  const _timestamp = new Date().toISOString();
  let color = colors.reset;

  switch (level) {
    case 'error':
      color = colors.red;
      break;
    case 'warn':
      color = colors.yellow;
      break;
    case 'success':
      color = colors.green;
      break;
    case 'info':
      color = colors.cyan;
      break;
  }

  console.log(`${color}[${level.toUpperCase()}]${colors.reset} ${message}`);
  if (data) {
    console.log('  ', JSON.stringify(data, null, 2));
  }
}

function loadIndex() {
  try {
    if (!fs.existsSync(INDEX_PATH)) {
      log('error', 'Index file not found', { path: INDEX_PATH });
      return null;
    }

    const indexData = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'));
    log('success', `Loaded index with ${indexData.items.length} items`);
    return indexData;
  } catch (error) {
    log('error', 'Failed to load index', { error: error.message });
    return null;
  }
}

function getVideoItems(index, spaceId = null) {
  const videoItems = index.items.filter((item) => {
    // Videos are stored as type 'file' with video extensions
    if (item.type !== 'file') return false;

    // Check if it's a video file by extension
    const fileName = item.fileName || '';
    const isVideo = VIDEO_EXTENSIONS.some((ext) => fileName.toLowerCase().endsWith(ext));

    if (!isVideo) return false;
    if (spaceId && item.spaceId !== spaceId) return false;
    return true;
  });

  log('info', `Found ${videoItems.length} video items${spaceId ? ' in space ' + spaceId : ''}`);
  return videoItems;
}

function checkVideoFile(itemId, item) {
  const issues = [];
  const itemDir = path.join(ITEMS_DIR, itemId);

  // Check if item directory exists
  if (!fs.existsSync(itemDir)) {
    issues.push({
      type: 'missing_directory',
      severity: 'critical',
      message: 'Item directory does not exist',
      path: itemDir,
    });
    return issues;
  }

  // Check for metadata
  const metadataPath = path.join(itemDir, 'metadata.json');
  if (!fs.existsSync(metadataPath)) {
    issues.push({
      type: 'missing_metadata',
      severity: 'warning',
      message: 'Metadata file not found',
      path: metadataPath,
    });
  }

  // List files in directory
  const files = fs.readdirSync(itemDir);
  const videoFiles = files.filter(
    (f) => VIDEO_EXTENSIONS.some((ext) => f.toLowerCase().endsWith(ext)) && !f.startsWith('.')
  );

  // Check for video file
  if (videoFiles.length === 0) {
    issues.push({
      type: 'missing_video',
      severity: 'critical',
      message: 'No video file found in item directory',
      path: itemDir,
      expectedName: item.fileName || 'unknown',
      foundFiles: files,
    });
  } else if (videoFiles.length > 1) {
    issues.push({
      type: 'multiple_videos',
      severity: 'warning',
      message: 'Multiple video files found',
      files: videoFiles,
    });
  }

  // Verify video file matches expected name
  if (videoFiles.length === 1 && item.fileName) {
    const actualName = videoFiles[0];
    if (actualName !== item.fileName && actualName !== path.basename(item.fileName)) {
      issues.push({
        type: 'name_mismatch',
        severity: 'warning',
        message: 'Video filename does not match index',
        expected: item.fileName,
        actual: actualName,
      });
    }
  }

  // Check file size
  if (videoFiles.length === 1) {
    const videoPath = path.join(itemDir, videoFiles[0]);
    const stats = fs.statSync(videoPath);

    if (stats.size === 0) {
      issues.push({
        type: 'empty_file',
        severity: 'critical',
        message: 'Video file is empty (0 bytes)',
        path: videoPath,
      });
    } else if (stats.size < 1024) {
      issues.push({
        type: 'tiny_file',
        severity: 'warning',
        message: 'Video file is suspiciously small',
        path: videoPath,
        size: stats.size,
      });
    }
  }

  return issues;
}

function diagnoseVideo(itemId, index) {
  const item = index.items.find((i) => i.id === itemId);

  if (!item) {
    log('error', 'Item not found in index', { itemId });
    return;
  }

  if (item.type !== 'file') {
    log('warn', 'Item is not a file', { itemId, type: item.type });
    return;
  }

  // Check if it's a video file
  const fileName = item.fileName || '';
  const isVideo = VIDEO_EXTENSIONS.some((ext) => fileName.toLowerCase().endsWith(ext));

  if (!isVideo) {
    log('warn', 'File is not a video', { itemId, fileName, type: item.type });
    return;
  }

  console.log('\n' + '='.repeat(80));
  log('info', `Diagnosing video: ${item.fileName || itemId}`);
  console.log('  Item ID:', itemId);
  console.log('  Space ID:', item.spaceId);
  console.log('  Timestamp:', new Date(item.timestamp).toISOString());
  console.log('  Preview:', item.preview?.substring(0, 50) || 'N/A');

  const issues = checkVideoFile(itemId, item);

  if (issues.length === 0) {
    log('success', 'No issues found');
  } else {
    log('warn', `Found ${issues.length} issue(s):`);
    issues.forEach((issue, idx) => {
      console.log(`\n  ${idx + 1}. [${issue.severity.toUpperCase()}] ${issue.message}`);
      Object.entries(issue).forEach(([key, value]) => {
        if (key !== 'type' && key !== 'severity' && key !== 'message') {
          console.log(`     ${key}: ${JSON.stringify(value)}`);
        }
      });
    });
  }

  return issues;
}

function diagnoseAllVideos(index, spaceId = null) {
  const videoItems = getVideoItems(index, spaceId);
  const results = {
    total: videoItems.length,
    healthy: 0,
    issues: 0,
    critical: 0,
    itemsWithIssues: [],
  };

  console.log('\n' + '='.repeat(80));
  log('info', 'Starting bulk diagnosis...\n');

  videoItems.forEach((item) => {
    const issues = checkVideoFile(item.id, item);

    if (issues.length === 0) {
      results.healthy++;
      process.stdout.write(colors.green + '✓' + colors.reset);
    } else {
      results.issues++;
      const hasCritical = issues.some((i) => i.severity === 'critical');
      if (hasCritical) {
        results.critical++;
        process.stdout.write(colors.red + '✗' + colors.reset);
      } else {
        process.stdout.write(colors.yellow + '⚠' + colors.reset);
      }

      results.itemsWithIssues.push({
        id: item.id,
        fileName: item.fileName,
        spaceId: item.spaceId,
        issues,
      });
    }

    // New line every 50 items
    if ((results.healthy + results.issues) % 50 === 0) {
      console.log();
    }
  });

  console.log('\n\n' + '='.repeat(80));
  log('info', 'Diagnosis Summary:');
  console.log('  Total videos:', results.total);
  console.log('  Healthy:', colors.green + results.healthy + colors.reset);
  console.log('  With issues:', colors.yellow + results.issues + colors.reset);
  console.log('  Critical:', colors.red + results.critical + colors.reset);

  if (results.itemsWithIssues.length > 0) {
    console.log('\n' + '='.repeat(80));
    log('warn', 'Items with issues:');

    results.itemsWithIssues.forEach((item) => {
      console.log(`\n  ${item.fileName || item.id}`);
      console.log(`    ID: ${item.id}`);
      console.log(`    Space: ${item.spaceId}`);
      item.issues.forEach((issue) => {
        console.log(`    - [${issue.severity}] ${issue.message}`);
      });
    });
  }

  return results;
}

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    itemId: null,
    spaceId: null,
    fix: false,
    all: true,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--space' && args[i + 1]) {
      options.spaceId = args[i + 1];
      options.all = false;
      i++;
    } else if (arg === '--fix') {
      options.fix = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log(`
Video File Diagnostic Tool

Usage:
  node diagnose-videos.js                  # Check all videos
  node diagnose-videos.js <itemId>         # Check specific video
  node diagnose-videos.js --space <id>     # Check videos in a space
  node diagnose-videos.js --fix            # Attempt to fix issues

Options:
  --space <id>    Only check videos in specified space
  --fix           Attempt to fix issues (not implemented yet)
  -h, --help      Show this help message
      `);
      process.exit(0);
    } else if (!arg.startsWith('--')) {
      options.itemId = arg;
      options.all = false;
    }
  }

  return options;
}

// Main execution
function main() {
  console.log(colors.cyan + '\n╔════════════════════════════════════════════╗');
  console.log('║  OR-Spaces Video Diagnostic Tool          ║');
  console.log('╚════════════════════════════════════════════╝\n' + colors.reset);

  const options = parseArgs();
  const index = loadIndex();

  if (!index) {
    log('error', 'Cannot proceed without index');
    process.exit(1);
  }

  if (options.itemId) {
    // Single item diagnosis
    diagnoseVideo(options.itemId, index);
  } else {
    // Bulk diagnosis
    const results = diagnoseAllVideos(index, options.spaceId);

    if (results.critical > 0) {
      process.exit(1); // Exit with error if critical issues found
    }
  }

  console.log('\n' + '='.repeat(80) + '\n');
}

// Run if called directly
if (require.main === module) {
  main();
}

module.exports = {
  diagnoseVideo,
  diagnoseAllVideos,
  checkVideoFile,
};
