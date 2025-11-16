const fs = require('fs');
const path = require('path');

async function countFiles(dirPath) {
  let count = 0;
  
  async function scan(dir) {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await scan(fullPath);
        } else if (entry.isFile()) {
          count++;
        }
      }
    } catch (err) {
      // Skip inaccessible directories
    }
  }
  
  await scan(dirPath);
  return count;
}

(async () => {
  const orSpacesCount = await countFiles('/Users/richardwilson/Documents/OR-Spaces');
  const desktopCount = await countFiles('/Users/richardwilson/Desktop');
  
  console.log('OR-Spaces file count:', orSpacesCount);
  console.log('Desktop file count:', desktopCount);
  
  // Check if OR-Spaces might be scanning parent directory
  const documentsCount = await countFiles('/Users/richardwilson/Documents');
  console.log('Documents file count:', documentsCount);
})();
