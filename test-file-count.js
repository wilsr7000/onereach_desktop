const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();

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
    } catch (_err) {
      // Skip inaccessible directories
    }
  }

  await scan(dirPath);
  return count;
}

(async () => {
  const orSpacesCount = await countFiles(path.join(HOME, 'Documents/OR-Spaces'));
  const desktopCount = await countFiles(path.join(HOME, 'Desktop'));

  console.log('OR-Spaces file count:', orSpacesCount);
  console.log('Desktop file count:', desktopCount);

  const documentsCount = await countFiles(path.join(HOME, 'Documents'));
  console.log('Documents file count:', documentsCount);
})();
