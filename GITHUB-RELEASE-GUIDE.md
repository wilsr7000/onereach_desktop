# GitHub Auto-Update Setup Guide

## ✅ Auto-Update is Now Configured!

Your app is now set up to automatically check for and download updates from your GitHub repository at:
`https://github.com/wilsr7000/onereach_desktop`

## 🚀 How Auto-Updates Work

1. **App checks for updates** on startup and periodically
2. **If a new version is found** on GitHub releases, users are notified
3. **Users can download** the update with one click
4. **Update installs** on next app restart

## 📦 How to Publish a New Version

### Step 1: Update Version Number

Edit `package.json` and increment the version:
```json
"version": "1.0.4",  // Change from 1.0.3 to 1.0.4
```

### Step 2: Commit Changes

```bash
git add .
git commit -m "Release v1.0.4"
git push origin main
```

### Step 3: Build Release Files

```bash
# Build for both Intel and Apple Silicon Macs
npm run package:mac        # ARM64 build
npx electron-builder build --mac --x64 --publish never  # Intel build
```

### Step 4: Create GitHub Release

#### Option A: Using GitHub CLI (Recommended)

```bash
# Install GitHub CLI if you haven't already
brew install gh

# Authenticate with GitHub
gh auth login

# Create release with all files
gh release create v1.0.4 \
  ./dist/Onereach.ai-1.0.4-arm64.dmg \
  ./dist/Onereach.ai-1.0.4-arm64-mac.zip \
  ./dist/Onereach.ai-1.0.4.dmg \
  ./dist/Onereach.ai-1.0.4-mac.zip \
  ./dist/latest-mac.yml \
  --title "Release v1.0.4" \
  --notes "### What's New
- Bug fixes and improvements
- Fixed space selection modal issues
- Added bug reporting to GitHub"
```

#### Option B: Manual Upload via GitHub Website

1. Go to: https://github.com/wilsr7000/onereach_desktop/releases
2. Click "Draft a new release"
3. Tag: `v1.0.4` (must match package.json version with 'v' prefix)
4. Title: `Release v1.0.4`
5. Upload these files from `dist/` folder:
   - `Onereach.ai-1.0.4-arm64.dmg` (Apple Silicon)
   - `Onereach.ai-1.0.4-arm64-mac.zip` (Apple Silicon ZIP)
   - `Onereach.ai-1.0.4.dmg` (Intel)
   - `Onereach.ai-1.0.4-mac.zip` (Intel ZIP)
   - `latest-mac.yml` (REQUIRED for auto-updater)
6. Write release notes
7. Click "Publish release"

## 🔄 What Users Experience

### First Time Setup
- Users download and install the app normally
- App automatically checks for updates on launch

### When Update is Available
1. User sees notification: "Update available! Version 1.0.4"
2. User clicks "Download Update"
3. Update downloads in background with progress bar
4. When complete: "Update ready! Restart to install"
5. On restart, new version is automatically installed

### Update Check Menu
Users can manually check for updates:
- **Help → Check for Updates**

## 📝 Important Files for Auto-Update

### Required in Each Release:
- **DMG files**: The actual app installers
- **ZIP files**: Alternative distribution format
- **latest-mac.yml**: Auto-generated file that tells the updater about the latest version

### Version Consistency:
These must all match:
- `package.json` version: `"1.0.4"`
- GitHub release tag: `v1.0.4`
- Built file names: `Onereach.ai-1.0.4-*.dmg`

## 🛠️ Testing Auto-Updates

### Test in Development:
1. Build the app: `npm run package:mac`
2. Install the built app from `dist/`
3. Create a new release on GitHub with higher version
4. Open installed app and check Help → Check for Updates

### Monitor Update Logs:
Logs are stored in:
- macOS: `~/Library/Logs/Onereach.ai/main.log`

## 🔧 Troubleshooting

### Updates Not Detected:
- Ensure version in package.json is lower than GitHub release
- Check `latest-mac.yml` is uploaded to release
- Verify tag format is `v1.0.4` (with 'v' prefix)

### Download Fails:
- Check GitHub release is public (not draft)
- Ensure all required files are uploaded
- Check network connectivity

### Update Installation Fails:
- App must be code-signed (already configured)
- User needs admin permissions
- Check disk space

## 🚨 Current Status

✅ **Auto-updater configured** to check your GitHub repository
✅ **Update mechanism** integrated in Help menu
✅ **Rollback system** available if updates fail
⚠️ **First release needed** - Follow steps above to publish v1.0.4

## 📈 Versioning Best Practices

- **Patch** (1.0.X): Bug fixes
- **Minor** (1.X.0): New features, backward compatible
- **Major** (X.0.0): Breaking changes

Always increment version for each release!
