# Build and Deploy Instructions for Onereach.ai v2.2.0

## Current Status
- **Current Version**: 2.2.0
- **Current Branch**: v2.0-development
- **Uncommitted Changes**: Yes (26 modified files, 8 new files)

## Prerequisites - Action Required! ⚠️

### 1. GitHub CLI Authentication
You need to re-authenticate with GitHub first:

```bash
gh auth login -h github.com
```

Follow the prompts:
- Choose: GitHub.com
- Protocol: HTTPS (recommended) or SSH
- Authenticate with: Login with a web browser (easiest)
- Copy the one-time code shown
- Press Enter to open browser
- Paste the code and authorize

Verify authentication:
```bash
gh auth status
```

### 2. Review Uncommitted Changes
You have the following changes:
- Modified: 26 files (including main.js, preload.js, package.json, etc.)
- New files: agentic-player/, video-editor files, test files

The release script will ask if you want to commit these as part of the release.

## Release Process

Once authenticated, run:

```bash
npm run release
```

Or directly:

```bash
./scripts/release-master.sh
```

### What the Script Will Do:

1. **Prompt for uncommitted changes**: It will ask if you want to commit them
2. **Version selection**: Choose version bump type:
   - Patch (2.2.0 → 2.2.1) - Bug fixes
   - Minor (2.2.0 → 2.3.0) - New features
   - Major (2.2.0 → 3.0.0) - Breaking changes
   - Custom version

3. **Release notes**: Auto-generate or customize release notes

4. **Confirmation**: Review and confirm release details

5. **Automated build process**:
   - Updates package.json
   - Commits and pushes to private repo (v2.0-development branch)
   - Cleans previous builds
   - Builds for Apple Silicon (ARM64)
   - Builds for Intel (x64)
   - Creates DMG and ZIP files for both architectures

6. **Public release**:
   - Publishes to public repository: `wilsr7000/Onereach_Desktop_App`
   - Creates GitHub release with all build files
   - Enables auto-update for existing users

## Expected Build Artifacts

After building, you should have in `dist/`:
- `Onereach.ai-2.2.0-arm64.dmg` (Apple Silicon)
- `Onereach.ai-2.2.0-arm64-mac.zip` (Apple Silicon)
- `Onereach.ai-2.2.0.dmg` (Intel)
- `Onereach.ai-2.2.0-mac.zip` (Intel)
- `latest-mac.yml` (Auto-update configuration)
- `.blockmap` files (For delta updates)

## Troubleshooting

### If build fails:
```bash
# Clean everything and try again
rm -rf dist/
rm -rf node_modules/
npm install
npm run release
```

### If GitHub authentication fails:
```bash
gh auth logout
gh auth login
```

### If you need to skip the script and do it manually:
```bash
# 1. Commit changes
git add -A
git commit -m "Release v2.2.1"
git push origin v2.0-development

# 2. Build
npm run package:mac

# 3. Publish manually
./scripts/publish-to-public.sh
```

## After Release

Once successful, you'll see:
- ✅ Public release URL
- ✅ Auto-update configuration active
- ✅ All users will receive update notifications

### Verify the release:
1. Visit: https://github.com/wilsr7000/Onereach_Desktop_App/releases
2. Check that all files are uploaded
3. Test download link
4. Verify auto-update by checking for updates in an existing installation

## Quick Start Command

```bash
# Step 1: Authenticate (if not already done)
gh auth login -h github.com

# Step 2: Run release
npm run release
```

That's it! The script handles everything else automatically.







