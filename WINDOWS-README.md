# Onereach.ai - Windows Setup Guide

## 🚀 Quick Start (For Testing)

**Fastest way to test on Windows without signing issues:**

```bash
# Build portable ZIP version
npm run package:win

# Find in dist folder:
# - Onereach.ai-1.0.3-win.zip (portable, fewer warnings)
# - Onereach.ai Setup 1.0.3.exe (installer, more warnings)

# Use the ZIP version:
1. Extract ZIP to any folder
2. Run Onereach.ai.exe
3. No installation needed!
```

The ZIP version triggers fewer security warnings than the installer.

## System Requirements
- Windows 10 or later (64-bit)
- 4GB RAM minimum
- 200MB free disk space

## Development Setup

1. **Install Prerequisites**
   ```cmd
   # Install Node.js 18+ from nodejs.org
   # Install Git from git-scm.com
   ```

2. **Clone and Install**
   ```cmd
   git clone <repository-url>
   cd Onereach_app
   npm install
   ```

3. **Run in Development**
   ```cmd
   npm run dev:win
   ```

## Building for Windows

### Quick Build
```cmd
npm run package:win
```

### Using Build Script
```cmd
scripts\build-signed.bat
```

### Build Output
- `dist/Onereach.ai Setup x.x.x.exe` - NSIS installer
- Install by double-clicking the .exe file

## Known Windows Considerations

### 1. Tray Icon
- System tray icon works normally
- Right-click for menu options

### 2. Keyboard Shortcuts
- `Ctrl+Shift+V` - Show clipboard history
- `Ctrl+,` - Open preferences
- `Ctrl+A` - Add/Remove IDW

### 3. File Paths
All user data stored in:
```
%APPDATA%\onereach-ai\
```

### 4. Auto-Updates
- Works the same as macOS
- Check Help → Check for Updates

### 5. Backup Location
```
%APPDATA%\onereach-ai\app-backups\
```

## Troubleshooting

### Build Errors
If you get "cannot find module" errors:
```cmd
npm ci
npm rebuild
```

### Permission Issues
Run as Administrator if you encounter:
- Installation permission errors
- Can't write to AppData

### Antivirus False Positives
Some antivirus may flag Electron apps. Solutions:
1. Add exception for Onereach.ai
2. Use signed builds for production

## Windows-Specific Features

### Context Menu Integration
The app integrates with Windows clipboard and supports:
- Copy/paste from any Windows app
- Drag & drop files
- Screenshot capture

### Windows Defender SmartScreen ⚠️
**The app is currently NOT CODE SIGNED**, so users WILL see warnings:

1. **Download Warning**: Browser may warn about uncommon download
2. **SmartScreen Block**: "Windows protected your PC"
   - Click "More info"
   - Click "Run anyway"
3. **UAC Prompt**: Admin permission required

**This is normal for unsigned apps.** The app is safe but Windows doesn't recognize it yet.

To avoid these warnings, see [WINDOWS-SIGNING-GUIDE.md](WINDOWS-SIGNING-GUIDE.md)

## Development Tips

1. **Use PowerShell or Git Bash** for better command-line experience
2. **Windows Defender** may slow down first build - be patient
3. **File watchers** work normally for hot reload
4. **DevTools** - Press F12 in any window

## Production Deployment

For production Windows builds:
1. Obtain a code signing certificate
2. Configure electron-builder with certificate
3. Use `npm run publish:win` for signed builds

## Need Help?

- Check console for errors: `View → Toggle Developer Tools`
- Logs location: `%APPDATA%\onereach-ai\logs\`
- Report issues with Windows version details 