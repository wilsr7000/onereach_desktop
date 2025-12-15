/**
 * Test script for video scenes metadata
 * Tests that scenes are properly saved to and retrieved from video metadata
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

// Storage paths
const storageRoot = path.join(os.homedir(), 'Documents', 'OR-Spaces');
const indexPath = path.join(storageRoot, 'index.json');

console.log('='.repeat(60));
console.log('VIDEO SCENES METADATA TEST');
console.log('='.repeat(60));

// Load index
if (!fs.existsSync(indexPath)) {
  console.error('ERROR: index.json not found at', indexPath);
  process.exit(1);
}

const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
console.log(`\nLoaded index with ${index.items.length} items`);

// Find video files
const videos = index.items.filter(item => 
  item.type === 'file' && item.fileType?.startsWith('video/')
);

console.log(`Found ${videos.length} video files:`);
videos.forEach((v, i) => {
  console.log(`  ${i + 1}. ${v.fileName} (ID: ${v.id})`);
});

if (videos.length === 0) {
  console.log('\nNo videos found to test. Please add a video to your Spaces first.');
  process.exit(0);
}

// Test with the first video
const testVideo = videos[0];
console.log(`\n${'─'.repeat(60)}`);
console.log(`Testing with: ${testVideo.fileName}`);
console.log(`Item ID: ${testVideo.id}`);
console.log(`Space ID: ${testVideo.spaceId}`);
console.log(`${'─'.repeat(60)}`);

// Get metadata path
const metadataPath = path.join(storageRoot, testVideo.metadataPath);
console.log(`\nMetadata path: ${metadataPath}`);

// Read current metadata
let metadata = {};
if (fs.existsSync(metadataPath)) {
  metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  console.log('\nCurrent metadata:');
  console.log(JSON.stringify(metadata, null, 2));
} else {
  console.log('\nNo existing metadata file - will create one');
}

// Check for existing scenes
console.log(`\n${'─'.repeat(60)}`);
console.log('EXISTING SCENES:');
console.log(`${'─'.repeat(60)}`);
if (metadata.scenes && metadata.scenes.length > 0) {
  console.log(`Found ${metadata.scenes.length} existing scenes:`);
  metadata.scenes.forEach((scene, i) => {
    console.log(`  Scene ${scene.id}: "${scene.name}" (${scene.inTime}s - ${scene.outTime}s)`);
    if (scene.description) console.log(`    Description: ${scene.description}`);
    if (scene.tags?.length) console.log(`    Tags: ${scene.tags.join(', ')}`);
  });
} else {
  console.log('No scenes found');
}

// Add test scenes
console.log(`\n${'─'.repeat(60)}`);
console.log('ADDING TEST SCENES:');
console.log(`${'─'.repeat(60)}`);

const testScenes = [
  {
    id: 1,
    name: 'Introduction',
    inTime: 0,
    outTime: 10,
    description: 'Opening sequence of the video',
    tags: ['intro', 'opening']
  },
  {
    id: 2,
    name: 'Main Content',
    inTime: 10,
    outTime: 30,
    description: 'The main demonstration',
    tags: ['demo', 'main']
  },
  {
    id: 3,
    name: 'Conclusion',
    inTime: 30,
    outTime: 45,
    description: 'Wrap up and summary',
    tags: ['outro', 'summary']
  }
];

console.log('Test scenes to add:');
testScenes.forEach(scene => {
  console.log(`  - ${scene.name}: ${scene.inTime}s to ${scene.outTime}s`);
});

// Update metadata
metadata.scenes = testScenes;
metadata.scenesUpdatedAt = new Date().toISOString();

// Write metadata
fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
console.log('\n✓ Wrote scenes to metadata file');

// Verify by reading it back
console.log(`\n${'─'.repeat(60)}`);
console.log('VERIFICATION - Reading back metadata:');
console.log(`${'─'.repeat(60)}`);

const verifyMetadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));

if (verifyMetadata.scenes && verifyMetadata.scenes.length === testScenes.length) {
  console.log('✓ Scenes successfully saved!');
  console.log(`  Total scenes: ${verifyMetadata.scenes.length}`);
  console.log(`  Updated at: ${verifyMetadata.scenesUpdatedAt}`);
  
  verifyMetadata.scenes.forEach(scene => {
    console.log(`  ✓ Scene ${scene.id}: "${scene.name}"`);
  });
} else {
  console.error('✗ Verification failed!');
  console.log('Expected:', testScenes.length, 'scenes');
  console.log('Got:', verifyMetadata.scenes?.length || 0, 'scenes');
}

// Check space metadata sync
console.log(`\n${'─'.repeat(60)}`);
console.log('CHECKING SPACE METADATA SYNC:');
console.log(`${'─'.repeat(60)}`);

if (testVideo.spaceId) {
  const spaceMetaPath = path.join(storageRoot, 'spaces', testVideo.spaceId, 'space-metadata.json');
  console.log(`Space metadata path: ${spaceMetaPath}`);
  
  if (fs.existsSync(spaceMetaPath)) {
    const spaceMeta = JSON.parse(fs.readFileSync(spaceMetaPath, 'utf8'));
    const fileKey = testVideo.fileName || `item-${testVideo.id}`;
    
    if (spaceMeta.files && spaceMeta.files[fileKey]) {
      const fileEntry = spaceMeta.files[fileKey];
      if (fileEntry.scenes) {
        console.log('✓ Scenes found in space metadata:');
        console.log(`  File key: ${fileKey}`);
        console.log(`  Scenes count: ${fileEntry.scenes.length}`);
      } else {
        console.log('Note: Scenes not yet synced to space metadata');
        console.log('(This would happen via IPC handler clipboard:update-video-scenes)');
      }
    } else {
      console.log('File entry not found in space metadata');
    }
  } else {
    console.log('Space metadata file does not exist yet');
  }
} else {
  console.log('Video is not in a specific space (unclassified)');
}

console.log(`\n${'='.repeat(60)}`);
console.log('TEST COMPLETE');
console.log(`${'='.repeat(60)}`);
console.log('\nFull metadata contents:');
console.log(JSON.stringify(verifyMetadata, null, 2));







