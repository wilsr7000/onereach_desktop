#!/usr/bin/env node

/**
 * Command-line tool to validate and clean OR-Spaces storage
 * Can be run directly: node validate-storage.js
 * 
 * NOTE: With DuckDB transactional storage (v2.0+), orphans should rarely occur.
 * If you're seeing frequent orphans, consider:
 * 1. Running the DuckDB rebuild: POST /api/database/rebuild
 * 2. Checking for app crashes during write operations
 * 3. Verifying disk health
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const storageRoot = path.join(os.homedir(), 'Documents', 'OR-Spaces');
const indexPath = path.join(storageRoot, 'index.json');
const itemsDir = path.join(storageRoot, 'items');

console.log('='.repeat(60));
console.log('OR-Spaces Storage Validator');
console.log('='.repeat(60));
console.log('Storage location:', storageRoot);
console.log('');

// Check if storage exists
if (!fs.existsSync(storageRoot)) {
  console.log('❌ Storage directory does not exist!');
  process.exit(1);
}

// Load index
let index;
try {
  const indexData = fs.readFileSync(indexPath, 'utf8');
  index = JSON.parse(indexData);
  console.log(`✓ Index loaded: ${index.items.length} items`);
} catch (error) {
  console.error('❌ Failed to load index:', error.message);
  process.exit(1);
}

// Find problematic items
const problems = [];
const largeVideos = [];

// Check each item
for (const item of index.items) {
  const itemDir = path.join(itemsDir, item.id);
  
  // Check if directory exists
  if (!fs.existsSync(itemDir)) {
    problems.push({
      id: item.id,
      type: 'missing_directory',
      preview: item.preview?.substring(0, 50)
    });
    continue;
  }
  
  // For file items, check the actual file
  if (item.type === 'file') {
    const files = fs.readdirSync(itemDir).filter(f => 
      !f.endsWith('.json') && !f.endsWith('.png') && !f.startsWith('.')
    );
    
    if (files.length === 0) {
      problems.push({
        id: item.id,
        type: 'missing_file',
        fileName: item.fileName
      });
    } else {
      // Check file size for videos
      const filePath = path.join(itemDir, files[0]);
      try {
        const stats = fs.statSync(filePath);
        
        // Check for video files
        if (files[0].toLowerCase().match(/\.(mp4|mov|avi|mkv|wmv|webm)$/i)) {
          const sizeMB = stats.size / (1024 * 1024);
          
          if (files[0].toLowerCase().includes('grok') || files[0].toLowerCase().includes('screen recording')) {
            console.log(`\n⚠️  Found potentially problematic video:`);
            console.log(`   File: ${files[0]}`);
            console.log(`   Size: ${sizeMB.toFixed(2)} MB`);
            console.log(`   Path: ${filePath}`);
            console.log(`   Item ID: ${item.id}`);
            
            largeVideos.push({
              id: item.id,
              fileName: files[0],
              path: filePath,
              sizeMB: sizeMB
            });
          } else if (sizeMB > 100) {
            largeVideos.push({
              id: item.id,
              fileName: files[0],
              path: filePath,
              sizeMB: sizeMB
            });
          }
        }
      } catch (error) {
        problems.push({
          id: item.id,
          type: 'inaccessible_file',
          fileName: files[0],
          error: error.message
        });
      }
    }
  }
}

console.log('\n' + '='.repeat(60));
console.log('VALIDATION RESULTS');
console.log('='.repeat(60));

if (problems.length > 0) {
  console.log(`\n❌ Found ${problems.length} problems:`);
  for (const problem of problems) {
    console.log(`   - ${problem.type}: ${problem.id}`);
    if (problem.fileName) {
      console.log(`     File: ${problem.fileName}`);
    }
  }
}

if (largeVideos.length > 0) {
  console.log(`\n⚠️  Found ${largeVideos.length} large video files:`);
  for (const video of largeVideos) {
    console.log(`   - ${video.fileName} (${video.sizeMB.toFixed(2)} MB)`);
  }
}

if (problems.length === 0 && largeVideos.length === 0) {
  console.log('\n✅ No issues found!');
}

// Ask if user wants to fix issues
if (problems.length > 0 || largeVideos.length > 0) {
  console.log('\n' + '='.repeat(60));
  console.log('CLEANUP OPTIONS');
  console.log('='.repeat(60));
  
  const readline = require('readline');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  
  const question = (prompt) => new Promise(resolve => rl.question(prompt, resolve));
  
  (async () => {
    if (problems.length > 0) {
      const answer = await question('\nRemove orphaned metadata entries? (y/n): ');
      if (answer.toLowerCase() === 'y') {
        // Remove problematic items from index
        let removed = 0;
        for (const problem of problems) {
          const idx = index.items.findIndex(item => item.id === problem.id);
          if (idx !== -1) {
            index.items.splice(idx, 1);
            removed++;
          }
        }
        
        // Save backup
        fs.writeFileSync(indexPath + '.backup', fs.readFileSync(indexPath));
        
        // Save cleaned index
        fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));
        console.log(`✓ Removed ${removed} orphaned entries`);
      }
    }
    
    if (largeVideos.length > 0) {
      console.log('\n⚠️  Large video files may cause sync to hang.');
      const answer = await question('Remove large video files from storage? (y/n): ');
      if (answer.toLowerCase() === 'y') {
        let removed = 0;
        for (const video of largeVideos) {
          // Remove from index
          const idx = index.items.findIndex(item => item.id === video.id);
          if (idx !== -1) {
            index.items.splice(idx, 1);
            
            // Remove directory
            const itemDir = path.join(itemsDir, video.id);
            try {
              const rimraf = require('fs').rmSync || require('fs').rmdirSync;
              rimraf(itemDir, { recursive: true, force: true });
              console.log(`✓ Removed: ${video.fileName}`);
              removed++;
            } catch (error) {
              console.error(`❌ Failed to remove ${video.fileName}:`, error.message);
            }
          }
        }
        
        if (removed > 0) {
          // Save cleaned index
          fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));
          console.log(`\n✓ Removed ${removed} video files`);
        }
      }
    }
    
    console.log('\n✅ Cleanup complete!');
    console.log('You can now try syncing to GSX again.');
    
    rl.close();
  })();
}
