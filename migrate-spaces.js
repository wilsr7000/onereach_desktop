#!/usr/bin/env node
/**
 * Migration script to convert existing spaces to unified metadata format
 * Run with: node migrate-spaces.js
 */

const ClipboardStorage = require('./clipboard-storage-v2');

console.log('Starting space migration...\n');

const storage = new ClipboardStorage();

console.log('Found spaces:');
for (const space of storage.index.spaces) {
  console.log(`  - ${space.name} (${space.id})`);
}
console.log('');

const migrated = storage.migrateAllSpaces();

console.log(`\nMigration complete!`);
console.log(`Migrated ${migrated} spaces to unified metadata format.`);

// Show what was created
const fs = require('fs');
const path = require('path');

console.log('\nVerifying space-metadata.json files:');
for (const space of storage.index.spaces) {
  if (space.id === 'unclassified') continue;

  const metaPath = path.join(storage.spacesDir, space.id, 'space-metadata.json');
  if (fs.existsSync(metaPath)) {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    const fileCount = Object.keys(meta.files || {}).length;
    console.log(`  ✓ ${space.name}: ${fileCount} files tracked`);
  } else {
    console.log(`  ✗ ${space.name}: metadata file not found`);
  }
}
