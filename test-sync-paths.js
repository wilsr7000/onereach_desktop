const path = require('path');
const fs = require('fs');
const os = require('os');

// Simulate what the app does
const documentsPath = path.join(os.homedir(), 'Documents');
const orSpacesPath = path.join(documentsPath, 'OR-Spaces');
const desktopPath = path.join(os.homedir(), 'Desktop');

console.log('=== Path Resolution Test ===');
console.log('Home dir:', os.homedir());
console.log('Documents path:', documentsPath);
console.log('OR-Spaces path:', orSpacesPath);
console.log('Desktop path:', desktopPath);
console.log('');

// Check if paths exist
console.log('=== Path Existence ===');
console.log('Documents exists:', fs.existsSync(documentsPath));
console.log('OR-Spaces exists:', fs.existsSync(orSpacesPath));
console.log('Desktop exists:', fs.existsSync(desktopPath));
console.log('');

// Check index.json
const indexPath = path.join(orSpacesPath, 'index.json');
console.log('=== Index Check ===');
console.log('Index path:', indexPath);
console.log('Index exists:', fs.existsSync(indexPath));

if (fs.existsSync(indexPath)) {
  try {
    const data = fs.readFileSync(indexPath, 'utf8');
    const index = JSON.parse(data);
    console.log('Index parsed: YES');
    console.log('Spaces:', index.spaces?.length || 0);
    console.log('Items:', index.items?.length || 0);
  } catch (error) {
    console.log('Index parse error:', error.message);
  }
}
console.log('');

// Count files
async function countFiles(dir) {
  let count = 0;

  async function scan(currentDir) {
    try {
      const entries = fs.readdirSync(currentDir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(currentDir, entry.name);
        if (entry.isDirectory()) {
          await scan(fullPath);
        } else if (entry.isFile()) {
          count++;
        }
      }
    } catch (error) {
      console.error(`Error scanning ${currentDir}:`, error.message);
    }
  }

  await scan(dir);
  return count;
}

// Count files in each directory
(async () => {
  console.log('=== File Counts ===');
  const orSpacesCount = await countFiles(orSpacesPath);
  console.log('OR-Spaces files:', orSpacesCount);

  // Don't count all desktop files, just check a quick sample
  const desktopFiles = fs.readdirSync(desktopPath);
  console.log('Desktop items (sample):', desktopFiles.length);
  console.log('');

  // Check if there's any symlink weirdness
  console.log('=== Symlink Check ===');
  const orSpacesStat = fs.lstatSync(orSpacesPath);
  console.log('OR-Spaces is symlink:', orSpacesStat.isSymbolicLink());

  if (orSpacesStat.isSymbolicLink()) {
    console.log('Symlink target:', fs.readlinkSync(orSpacesPath));
  }
})();
