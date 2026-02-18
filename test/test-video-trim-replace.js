/**
 * Test: Trim video and replace in space
 * This tests the two-step workflow:
 * 1. Trim the video to a shorter version
 * 2. Replace the original in the space (preserving metadata/scenes)
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const ffprobePath = require('@ffprobe-installer/ffprobe').path;

// Set FFmpeg paths
ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

const storageRoot = path.join(os.homedir(), 'Documents', 'OR-Spaces');
const indexPath = path.join(storageRoot, 'index.json');

async function getVideoInfo(videoPath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(videoPath, (err, metadata) => {
      if (err) reject(err);
      else resolve(metadata);
    });
  });
}

async function trimVideo(inputPath, outputPath, startTime, duration) {
  return new Promise((resolve, reject) => {
    console.log(`Trimming: ${startTime}s for ${duration}s`);

    ffmpeg(inputPath)
      .setStartTime(startTime)
      .setDuration(duration)
      .outputOptions(['-c', 'copy']) // Fast copy without re-encoding
      .output(outputPath)
      .on('start', (cmd) => console.log('FFmpeg command:', cmd))
      .on('progress', (p) => process.stdout.write(`\rProgress: ${Math.round(p.percent || 0)}%`))
      .on('end', () => {
        console.log('\nTrim complete!');
        resolve();
      })
      .on('error', reject)
      .run();
  });
}

async function main() {
  console.log('='.repeat(60));
  console.log('VIDEO TRIM & REPLACE TEST');
  console.log('='.repeat(60));

  // Load index and find video
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  const video = index.items.find(
    (item) => item.fileType?.includes('video') || item.fileName?.toLowerCase().match(/\.(mp4|mov|avi|mkv|webm)$/)
  );

  if (!video) {
    console.log('No video found!');
    process.exit(1);
  }

  const videoPath = path.join(storageRoot, video.contentPath);
  const metadataPath = path.join(storageRoot, video.metadataPath);
  const itemDir = path.dirname(videoPath);

  console.log('\n📹 Video:', video.fileName);
  console.log('   ID:', video.id);
  console.log('   Path:', videoPath);

  // Get original video info
  console.log('\n' + '─'.repeat(60));
  console.log('STEP 1: Get original video info');
  console.log('─'.repeat(60));

  const originalInfo = await getVideoInfo(videoPath);
  const originalDuration = originalInfo.format.duration;
  const originalSize = originalInfo.format.size;

  console.log('Original duration:', originalDuration.toFixed(2), 'seconds');
  console.log('Original size:', (originalSize / 1024 / 1024).toFixed(2), 'MB');

  // Read current metadata (with scenes)
  let metadata = {};
  if (fs.existsSync(metadataPath)) {
    metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    console.log('\nExisting scenes:', metadata.scenes?.length || 0);
  }

  // Create backup
  console.log('\n' + '─'.repeat(60));
  console.log('STEP 2: Backup original');
  console.log('─'.repeat(60));

  const backupPath = videoPath + '.backup';
  if (!fs.existsSync(backupPath)) {
    fs.copyFileSync(videoPath, backupPath);
    console.log('✓ Backup created:', backupPath);
  } else {
    console.log('Backup already exists');
  }

  // Trim video (first 5 seconds as test)
  console.log('\n' + '─'.repeat(60));
  console.log('STEP 3: Trim video');
  console.log('─'.repeat(60));

  const trimDuration = Math.min(5, originalDuration); // First 5 seconds
  const tempOutput = path.join(itemDir, 'trimmed_temp.mov');

  await trimVideo(videoPath, tempOutput, 0, trimDuration);

  // Verify trimmed file
  const trimmedInfo = await getVideoInfo(tempOutput);
  console.log('Trimmed duration:', trimmedInfo.format.duration.toFixed(2), 'seconds');
  console.log('Trimmed size:', (trimmedInfo.format.size / 1024 / 1024).toFixed(2), 'MB');

  // Replace original with trimmed
  console.log('\n' + '─'.repeat(60));
  console.log('STEP 4: Replace original with trimmed version');
  console.log('─'.repeat(60));

  // Remove original
  fs.unlinkSync(videoPath);
  console.log('✓ Removed original');

  // Move trimmed to original location
  fs.renameSync(tempOutput, videoPath);
  console.log('✓ Moved trimmed to original location');

  // Update metadata
  console.log('\n' + '─'.repeat(60));
  console.log('STEP 5: Update metadata');
  console.log('─'.repeat(60));

  // Update scenes to fit new duration (scale proportionally or just keep as-is for test)
  // For this test, we'll add a note about the edit
  metadata.editedAt = new Date().toISOString();
  metadata.editedFrom = 'trim-test';
  metadata.originalDuration = originalDuration;
  metadata.newDuration = trimmedInfo.format.duration;

  // Adjust scenes to fit new duration
  if (metadata.scenes && metadata.scenes.length > 0) {
    const scaleFactor = trimmedInfo.format.duration / originalDuration;
    metadata.scenes = metadata.scenes
      .map((scene) => ({
        ...scene,
        inTime: Math.min(scene.inTime * scaleFactor, trimmedInfo.format.duration),
        outTime: Math.min(scene.outTime * scaleFactor, trimmedInfo.format.duration),
      }))
      .filter((scene) => scene.inTime < trimmedInfo.format.duration);
    console.log('✓ Adjusted scenes for new duration');
  }

  fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
  console.log('✓ Updated metadata file');

  // Update index entry
  const indexEntry = index.items.find((i) => i.id === video.id);
  if (indexEntry) {
    indexEntry.fileSize = trimmedInfo.format.size;
    indexEntry.timestamp = Date.now();
    fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));
    console.log('✓ Updated index.json');
  }

  // Verify
  console.log('\n' + '─'.repeat(60));
  console.log('VERIFICATION');
  console.log('─'.repeat(60));

  const finalInfo = await getVideoInfo(videoPath);
  const finalMetadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));

  console.log('');
  console.log('Video file:');
  console.log('  Duration:', finalInfo.format.duration.toFixed(2), 'seconds');
  console.log('  Size:', (finalInfo.format.size / 1024 / 1024).toFixed(2), 'MB');

  console.log('');
  console.log('Metadata:');
  console.log('  Scenes:', finalMetadata.scenes?.length || 0);
  console.log('  Edited at:', finalMetadata.editedAt);
  console.log('  Original duration:', finalMetadata.originalDuration?.toFixed(2), 's');
  console.log('  New duration:', finalMetadata.newDuration?.toFixed(2), 's');

  if (finalMetadata.scenes) {
    console.log('');
    console.log('Scenes:');
    finalMetadata.scenes.forEach((s) => {
      console.log(`  - ${s.name}: ${s.inTime.toFixed(2)}s - ${s.outTime.toFixed(2)}s`);
    });
  }

  console.log('\n' + '='.repeat(60));
  console.log('✅ TEST COMPLETE - Video trimmed and replaced!');
  console.log('='.repeat(60));
  console.log('\nBackup available at:', backupPath);
  console.log('To restore: cp "' + backupPath + '" "' + videoPath + '"');
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
