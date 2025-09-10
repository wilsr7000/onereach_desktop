# Complete Windows Compatibility Checklist

## Issues Found Beyond Path Problems

### 1. ❌ **Environment Variables**
**Problem**: Windows doesn't have `$HOME` or `$USER`
```javascript
// BAD - Crashes on Windows
process.env.HOME  // undefined on Windows
process.env.USER  // undefined on Windows

// GOOD - Cross-platform
os.homedir()  // Works everywhere
os.userInfo().username  // Works everywhere
process.env.HOME || process.env.USERPROFILE  // Fallback
```

**Files affected:**
- `website-monitor.js` - Uses `process.env.HOME`
- `clipboard-storage-v2.js` - Uses `process.env.USER`
- `clipboard-manager.js` - Uses both

### 2. ❌ **File Permissions (chmod)**
**Problem**: `fs.chmod()` doesn't work the same on Windows
```javascript
// BAD - No effect on Windows
await fs.chmod(scriptPath, '755');
fs.chmodSync(filePath, 0o666);

// GOOD - Check platform first
if (process.platform !== 'win32') {
  await fs.chmod(scriptPath, '755');
}
```

**Files affected:**
- `rollback-manager.js` - Makes scripts executable
- `clipboard-manager.js` - Changes file permissions

### 3. ⚠️ **File Watchers**
**Problem**: `fs.watch()` behaves differently on Windows
- May fire multiple events for one change
- Different event types
- Case sensitivity issues

```javascript
// Current implementation
fs.watch(desktopPath, (eventType, filename) => {
  // May fire 2-3 times on Windows for one file change
});

// Better: Use debouncing
const debounce = require('lodash.debounce');
const debouncedHandler = debounce((filename) => {
  // Handle file change
}, 100);
```

**Files affected:**
- `clipboard-manager.js` - Screenshot watcher
- `clipboard-manager-v2-adapter.js` - Screenshot watcher

### 4. ⚠️ **Tray Icon Differences**
**Problem**: System tray behaves differently
- Left vs right click behavior
- Menu positioning
- Icon format requirements

**Current code seems OK** - Using PNG icon which works on both platforms

### 5. ❌ **Shell/Process Execution**
**Problem**: Different shell commands and syntax
```javascript
// BAD - Unix-specific
exec('which qlmanage');
exec('rm -rf directory');

// GOOD - Cross-platform
exec(process.platform === 'win32' ? 'where' : 'which');
fs.rmSync(directory, { recursive: true }); // Node.js built-in
```

### 6. ⚠️ **Line Endings**
**Problem**: Windows uses CRLF (`\r\n`), Unix uses LF (`\n`)
- Git can change line endings
- Text file parsing might break

```javascript
// GOOD - Handle both
const lines = content.split(/\r?\n/);
```

### 7. ❌ **Hidden Files**
**Problem**: Different conventions
- Unix: Files starting with `.`
- Windows: File attribute

```javascript
// Unix hidden file check
if (filename.startsWith('.')) { /* hidden */ }

// Windows needs different approach
// Would need to check file attributes
```

### 8. ⚠️ **Process Management**
**Problem**: No SIGTERM on Windows
```javascript
// BAD - Doesn't work on Windows
process.kill(pid, 'SIGTERM');

// GOOD - Cross-platform
process.kill(pid); // Default signal works
```

### 9. ❌ **Network/UNC Paths**
**Problem**: Windows has UNC paths like `\\\\server\\share`
```javascript
// Need to handle:
// C:\path\to\file
// \\server\share\file
// file:///C:/path/to/file
```

### 10. ⚠️ **Case Sensitivity**
**Problem**: Windows filesystem is case-insensitive
```javascript
// These are the SAME file on Windows:
'MyFile.txt'
'myfile.txt'
'MYFILE.TXT'

// Can cause issues with:
- File lookups
- Duplicate detection
- Cache keys
```

## Quick Fixes Needed

### Fix Environment Variables
```javascript
// In clipboard-manager.js, website-monitor.js, etc.
const homeDir = os.homedir();
const userName = os.userInfo().username || 'User';
```

### Fix File Permissions
```javascript
// In rollback-manager.js
if (process.platform !== 'win32') {
  await fs.chmod(scriptPath, '755');
}
```

### Fix File Watchers
```javascript
// Add debouncing to prevent multiple events
const watchedFiles = new Map();
fs.watch(dir, (event, filename) => {
  const now = Date.now();
  const last = watchedFiles.get(filename) || 0;
  if (now - last < 100) return; // Debounce
  watchedFiles.set(filename, now);
  // Handle event...
});
```

## Testing Priority

1. **HIGH PRIORITY**
   - [ ] Environment variables (app might crash)
   - [ ] File permissions (features won't work)
   - [ ] Shell commands (features fail silently)

2. **MEDIUM PRIORITY**
   - [ ] File watchers (duplicate events)
   - [ ] Line endings (text parsing)
   - [ ] Case sensitivity (file conflicts)

3. **LOW PRIORITY**
   - [ ] Hidden files (cosmetic)
   - [ ] Process signals (edge cases)
   - [ ] UNC paths (rare usage)

## Recommended Actions

1. **Immediate**: Fix environment variables to prevent crashes
2. **Next**: Add platform checks for chmod/permissions
3. **Then**: Add debouncing to file watchers
4. **Later**: Handle edge cases like UNC paths

The app will run on Windows after these fixes, but some features may behave slightly differently than on macOS. 