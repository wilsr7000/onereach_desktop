# Automated Release System

## Quick Start - One Command Release!

### The Magic Command:
```bash
npm run release
```

That's it! This single command will:
1. Ask you for the new version
2. Generate release notes automatically 
3. Update your private source code
4. Build the app (universal binary by default)
5. Publish to your public releases repository
6. Trigger auto-updates for all users

## Build Modes (Optimized for Speed)

The release script supports three build modes to optimize build time:

### Default: Universal Binary (Recommended)
```bash
npm run release
# or
./scripts/release-master.sh --universal
```
- Builds a single binary that works on ALL Macs
- ~50% faster than building separate architectures
- Larger file size (~2x) but simpler releases
- Users don't need to choose ARM64 vs Intel

### Quick Release: ARM64 Only
```bash
npm run release:quick
# or
./scripts/release-master.sh --arm64-only
```
- Fastest build option (~5-7 minutes)
- Only for Apple Silicon users (M1/M2/M3/M4)
- Use when most users are on Apple Silicon
- Good for urgent hotfixes

### Legacy: Dual Architecture
```bash
./scripts/release-master.sh --dual-arch
```
- Builds ARM64 and x64 separately
- Produces 4 files (2 DMG + 2 ZIP)
- Slowest option but smallest individual file sizes
- Use if universal binary has issues with native modules

## 🎯 How It Works

### Your Repository Setup:
```
┌─────────────────────────────┐
│   PRIVATE REPOSITORY        │
│   github.com/wilsr7000/     │
│   onereach_desktop          │
│                             │
│   • Source code (hidden)    │
│   • Development files       │
│   • Your secrets safe       │
└─────────────────────────────┘
              ⬇️ 
         npm run release
              ⬇️
┌─────────────────────────────┐
│   PUBLIC REPOSITORY         │
│   github.com/wilsr7000/     │
│   onereach-desktop-releases │
│                             │
│   • DMG/ZIP files only      │
│   • Download page           │
│   • Auto-update endpoint    │
└─────────────────────────────┘
              ⬇️
         Auto-Updates
              ⬇️
    📱 All User Apps Updated!
```

## 📋 Before Your First Release

### 1. Create the Public Repository
Go to https://github.com/new and create:
- Name: `onereach-desktop-releases`
- Visibility: **PUBLIC** ✅ (This is critical!)
- Initialize with README: Yes
- Description: "Official releases for Onereach.ai Desktop"

### 2. That's It!
The release script will handle everything else.

## 🎮 Usage Examples

### Standard Release (Recommended):
```bash
npm run release
```
Interactive prompts will guide you through:
- Version selection (patch/minor/major)
- Auto-generated release notes
- Confirmation before publishing

### Quick Commands:
```bash
# Using the script directly
./scripts/release-master.sh

# View what changed since last release
git log --oneline -10

# Check current version
node -p "require('./package.json').version"
```

## 📝 Version Numbering Guide

### Semantic Versioning (X.Y.Z)
- **X (Major)**: Breaking changes, big redesigns
- **Y (Minor)**: New features, backwards compatible
- **Z (Patch)**: Bug fixes, small improvements

### Examples:
- `1.0.4` → `1.0.5`: Fixed a bug
- `1.0.5` → `1.1.0`: Added new feature
- `1.1.0` → `2.0.0`: Major overhaul

## What Happens During Release

### Step 1: Version Update
- You choose the new version
- package.json is updated automatically

### Step 2: Release Notes
- Automatically generated from your recent commits
- Option to customize or add highlights
- Includes download instructions

### Step 3: Private Repository Update
- All changes committed with proper message
- Pushed to your private GitHub repo
- Source code stays private

### Step 4: Build Process (depends on mode)
- **Universal (default)**: Single build for all Macs (~5-7 min)
- **ARM64-only**: Fastest build, Apple Silicon only (~5-7 min)
- **Dual-arch**: Separate builds for ARM64 + x64 (~10-14 min)
- Creates DMG and ZIP files
- Build cache preserved for faster subsequent builds

### Step 5: Public Release
- Uploads only compiled apps to public repo
- Creates GitHub release with notes
- Updates the auto-update manifest (latest-mac.yml)

### Step 6: User Updates
- All existing users get notification
- One-click download and install
- Automatic installation on restart

## 🎯 User Experience

### For Existing Users:
1. App checks for updates (on startup)
2. Sees: "Update available! Version 1.0.5"
3. Clicks: "Download Update"
4. Update downloads in background
5. On next restart: Automatically updated!

### For New Users:
1. Visit: `github.com/wilsr7000/onereach-desktop-releases`
2. Download latest DMG for their Mac type
3. Install normally
4. Auto-updates enabled from then on

## 🛠️ Troubleshooting

### "GitHub CLI not installed"
```bash
brew install gh
gh auth login
```

### "Public repository not found"
Create it at https://github.com/new with name `onereach-desktop-releases`

### "Build failed"
```bash
# Clean and retry
rm -rf dist/
npm run release
```

### "Release already exists"
The script will ask if you want to recreate it.

## 📊 Monitoring Releases

### Check Release Status:
```bash
# View your releases
open https://github.com/wilsr7000/onereach-desktop-releases/releases

# Check download counts
gh release list --repo wilsr7000/onereach-desktop-releases
```

### User Update Logs:
Users' apps log update checks to:
- macOS: `~/Library/Logs/Onereach.ai/main.log`

## 🎉 Best Practices

### Do's:
- ✅ Test major features before releasing
- ✅ Write clear commit messages (they become release notes)
- ✅ Increment version for every release
- ✅ Keep releases frequent but stable

### Don'ts:
- ❌ Skip version numbers
- ❌ Release untested code
- ❌ Forget to create the public repo first
- ❌ Make the public repo private (breaks updates)

## 🚀 Advanced Options

### Custom Release Notes:
The script will prompt you to either:
1. Use auto-generated notes from commits
2. Write custom notes
3. Edit the auto-generated notes

### Force Specific Version:
When prompted, choose option 4 for custom version.

### Skip Confirmation:
Not recommended, but you can modify the script to skip confirmations.

## 📱 Testing Updates

### Test Flow:
1. Install current version on a test Mac
2. Run `npm run release` with higher version
3. Open the installed app
4. Check Help → Check for Updates
5. Verify update downloads and installs

## 🔒 Security Notes

### What Stays Private:
- All source code
- Development notes
- API keys and secrets
- Build configurations
- Internal documentation

### What Goes Public:
- Compiled DMG/ZIP files only
- Version number and release notes
- Download instructions
- No source code exposure

## Quick Reference

| Command | What it does |
|---------|--------------|
| `npm run release` | Full release with universal binary (recommended) |
| `npm run release:quick` | Quick release with ARM64 only |
| `./scripts/release-master.sh --universal` | Universal binary build (default) |
| `./scripts/release-master.sh --arm64-only` | ARM64 only (fastest) |
| `./scripts/release-master.sh --dual-arch` | Separate ARM64 + x64 builds |
| `npm run package:mac` | Build ARM64 without releasing |
| `npm run package:mac:universal` | Build universal without releasing |
| `git log --oneline -10` | See recent commits |
| `gh release list --repo wilsr7000/Onereach_Desktop_App` | List all releases |

## Summary

**Just run `npm run release` and follow the prompts!**

The system handles everything:
- Version management
- Building for all Macs (universal binary by default)
- Publishing to public repository
- Auto-updates for users
- Keeping source private

**Build Time Comparison:**
- Universal (default): ~5-7 minutes - works on all Macs
- ARM64-only (--quick): ~5-7 minutes - Apple Silicon only
- Dual-arch (legacy): ~10-14 minutes - separate builds

Your users will always have the latest version, and your code stays secure!
