#!/usr/bin/env node

// Final cleanup to update video and audio handlers in menu-action handler

const fs = require('fs');
const path = require('path');

const mainJsPath = path.join(__dirname, 'main.js');

console.log('Final cleanup: Updating video and audio handlers in menu-action handler...\n');

// Read the file
let content = fs.readFileSync(mainJsPath, 'utf8');

// Replace video creator handler in menu-action section
const videoOldPattern = /\/\/ Handle video creator opening\s*\n\s*if \(data\.action === 'open-video-creator' && data\.url\) \{\s*\n\s*console\.log\('Opening video creator in new tab:'.*?\n[\s\S]*?return;\s*\}/g;

const videoNewHandler = `    // Handle video creator opening - open in separate window
    if (data.action === 'open-video-creator' && data.url) {
      console.log('Opening video creator in separate window:', data.label, data.url);
      openExternalAIWindow(data.url, data.label || 'Video Creator', {
        width: 1400,
        height: 900
      });
      return;
    }`;

// Replace audio generator handler in menu-action section  
const audioOldPattern = /\/\/ Handle audio generator opening\s*\n\s*if \(data\.action === 'open-audio-generator' && data\.url\) \{\s*\n\s*console\.log\('Opening audio generator in new tab:'.*?\n[\s\S]*?return;\s*\}/g;

const audioNewHandler = `    // Handle audio generator opening - open in separate window
    if (data.action === 'open-audio-generator' && data.url) {
      console.log('Opening audio generator in separate window:', data.label, data.url);
      openExternalAIWindow(data.url, data.label || 'Audio Generator', {
        width: 1400,
        height: 900
      });
      return;
    }`;

// Find the menu-action handler section
const menuActionPattern = /ipcMain\.on\('menu-action'[\s\S]*?\}\);\s*\n\s*\/\*\*/;
const menuActionMatch = content.match(menuActionPattern);

if (menuActionMatch) {
    let menuActionSection = menuActionMatch[0];
    let updateCount = 0;
    
    // Replace video creator handler
    if (menuActionSection.includes('Opening video creator in new tab:')) {
        menuActionSection = menuActionSection.replace(videoOldPattern, videoNewHandler);
        updateCount++;
        console.log('✓ Updated video creator handler in menu-action handler');
    }
    
    // Replace audio generator handler
    if (menuActionSection.includes('Opening audio generator in new tab:')) {
        menuActionSection = menuActionSection.replace(audioOldPattern, audioNewHandler);
        updateCount++;
        console.log('✓ Updated audio generator handler in menu-action handler');
    }
    
    if (updateCount > 0) {
        content = content.replace(menuActionMatch[0], menuActionSection);
        fs.writeFileSync(mainJsPath, content);
        console.log(`\n✅ Successfully updated ${updateCount} handler(s) in menu-action handler`);
    } else {
        console.log('No handlers needed updating in menu-action handler');
    }
} else {
    console.log('Could not find menu-action handler section');
}

console.log('\nAll external AI services now open in separate windows with:');
console.log('- Authentication support (Google, Microsoft, Adobe, etc.)');
console.log('- Separate sessions for each service');
console.log('- Download handling with space selection');
console.log('- Special headers for Adobe Firefly'); 