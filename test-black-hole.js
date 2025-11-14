#!/usr/bin/env node

/**
 * Black Hole Widget Integrity Test
 * Run this to check if critical components are intact
 */

const fs = require('fs');
const path = require('path');

console.log('🔍 Black Hole Widget Integrity Check\n');

let errors = 0;
let warnings = 0;

// Test 1: Check for duplicate createBlackHoleWindow method definitions
console.log('1. Checking for duplicate method definitions...');
const clipboardManagerPath = path.join(__dirname, 'clipboard-manager-v2-adapter.js');
const clipboardManagerContent = fs.readFileSync(clipboardManagerPath, 'utf8');
// Look for method definitions (not calls)
const blackHoleMethodCount = (clipboardManagerContent.match(/^\s*createBlackHoleWindow\s*\([^)]*\)\s*{/gm) || []).length;

if (blackHoleMethodCount > 1) {
  console.error('   ❌ ERROR: Found', blackHoleMethodCount, 'createBlackHoleWindow method definitions (should be 1)');
  errors++;
} else if (blackHoleMethodCount === 0) {
  console.error('   ❌ ERROR: No createBlackHoleWindow method definition found');
  errors++;
} else {
  console.log('   ✅ Only one createBlackHoleWindow method definition found');
}

// Test 2: Check for correct preload path in black hole window
console.log('\n2. Checking preload path configuration...');
// Extract just the createBlackHoleWindow method
const blackHoleMethod = clipboardManagerContent.match(/createBlackHoleWindow[\s\S]*?^\s*\}/m);
if (blackHoleMethod) {
  const methodContent = blackHoleMethod[0];
  const hasCorrectPreloadPath = methodContent.includes('app.getAppPath()') && 
                                 methodContent.includes("preload: preloadPath");
  const hasWrongPreloadPath = /preload:\s*path\.join\s*\(\s*__dirname/.test(methodContent);
  
  if (hasWrongPreloadPath) {
    console.error('   ❌ ERROR: Black hole window using __dirname for preload path (should use app.getAppPath())');
    errors++;
  } else if (!hasCorrectPreloadPath) {
    console.warn('   ⚠️  WARNING: Could not verify preload path configuration in black hole window');
    warnings++;
  } else {
    console.log('   ✅ Correct preload path configuration in black hole window');
  }
} else {
  console.error('   ❌ ERROR: Could not find createBlackHoleWindow method');
  errors++;
}

// Test 3: Check sandbox setting
console.log('\n3. Checking sandbox configuration...');
const blackHoleWindowSection = clipboardManagerContent.match(/createBlackHoleWindow[\s\S]*?^\s*\}/m);
if (blackHoleWindowSection) {
  const hasSandboxFalse = blackHoleWindowSection[0].includes('sandbox: false');
  if (!hasSandboxFalse) {
    console.warn('   ⚠️  WARNING: sandbox: false not found in black hole window config');
    warnings++;
  } else {
    console.log('   ✅ Sandbox properly disabled for preload');
  }
}

// Test 4: Check window dimensions
console.log('\n4. Checking window dimensions...');
const hasCorrectDimensions = clipboardManagerContent.includes('width = startExpanded ? 600 : 150') &&
                             clipboardManagerContent.includes('height = startExpanded ? 800 : 150');

if (!hasCorrectDimensions) {
  console.warn('   ⚠️  WARNING: Window dimensions may be incorrect');
  warnings++;
} else {
  console.log('   ✅ Correct window dimensions (150x150 normal, 600x800 expanded)');
}

// Test 5: Check resize handler
console.log('\n5. Checking resize handler...');
const hasResizeHandler = clipboardManagerContent.includes("ipcMain.on('black-hole:resize-window'");

if (!hasResizeHandler) {
  console.error('   ❌ ERROR: Resize handler not found');
  errors++;
} else {
  console.log('   ✅ Resize handler found');
}

// Test 6: Check main.js trigger-paste handler
console.log('\n6. Checking main.js handlers...');
const mainPath = path.join(__dirname, 'main.js');
const mainContent = fs.readFileSync(mainPath, 'utf8');
const hasTriggerPaste = mainContent.includes("ipcMain.on('black-hole:trigger-paste'");
const hasClipboardRead = mainContent.includes('clipboard.readText()') && 
                        mainContent.includes('clipboard.readImage()');

if (!hasTriggerPaste) {
  console.error('   ❌ ERROR: black-hole:trigger-paste handler not found in main.js');
  errors++;
} else if (!hasClipboardRead) {
  console.warn('   ⚠️  WARNING: Clipboard reading logic may be incomplete');
  warnings++;
} else {
  console.log('   ✅ Trigger-paste handler properly configured');
}

// Test 7: Check browser-renderer.js hover timeout
console.log('\n7. Checking browser renderer configuration...');
const browserRendererPath = path.join(__dirname, 'browser-renderer.js');
const browserRendererContent = fs.readFileSync(browserRendererPath, 'utf8');
const hasHoverTimeout = browserRendererContent.includes('3000') && 
                       browserRendererContent.includes('hoverTimeout');

if (!hasHoverTimeout) {
  console.warn('   ⚠️  WARNING: 3-second hover timeout may be missing');
  warnings++;
} else {
  console.log('   ✅ 3-second hover timeout configured');
}

// Test 8: Check black-hole.js paste handler
console.log('\n8. Checking black-hole.js handlers...');
const blackHolePath = path.join(__dirname, 'black-hole.js');
const blackHoleContent = fs.readFileSync(blackHolePath, 'utf8');
const hasPasteHandler = blackHoleContent.includes("'paste-clipboard-data'");
const hasAlwaysAsk = blackHoleContent.includes('alwaysAskForSpace');

if (!hasPasteHandler) {
  console.error('   ❌ ERROR: paste-clipboard-data handler not found');
  errors++;
} else if (!hasAlwaysAsk) {
  console.warn('   ⚠️  WARNING: alwaysAskForSpace logic may be missing');
  warnings++;
} else {
  console.log('   ✅ Paste handlers properly configured');
}

// Summary
console.log('\n' + '='.repeat(50));
console.log('SUMMARY:');
console.log('='.repeat(50));

if (errors === 0 && warnings === 0) {
  console.log('✅ All checks passed! Black hole widget should work correctly.');
} else {
  if (errors > 0) {
    console.error(`❌ Found ${errors} error(s) that need to be fixed`);
  }
  if (warnings > 0) {
    console.warn(`⚠️  Found ${warnings} warning(s) that should be reviewed`);
  }
  console.log('\n📖 See TEST-BLACKHOLE.md for troubleshooting guide');
}

process.exit(errors > 0 ? 1 : 0);
