# Auto-Update Setup Guide

## Overview

The Onereach.ai app uses `electron-updater` for automatic updates. This guide explains how to configure and deploy updates.

## Current Status

- ✅ Auto-updater code is implemented
- ✅ UI for update notifications exists
- ⚠️ Update server not configured
- ⚠️ GitHub releases not set up

## Setup Options

### Option 1: GitHub Releases (Recommended)

1. **Create GitHub Repository**
   ```bash
   # Create a new repo: github.com/OneReachAI/onereach-desktop
   # Make it public or private (requires token for private)
   ```

2. **Update package.json**
   ```json
   "publish": [
     {
       "provider": "github",
       "owner": "OneReachAI",
       "repo": "onereach-desktop",
       "releaseType": "release"
     }
   ]
   ```

3. **Set GitHub Token**
   ```bash
   # Create a personal access token with 'repo' scope
   export GH_TOKEN=your_github_token
   ```

4. **Publish Release**
   ```bash
   # Bump version
   npm version patch  # or minor/major

   # Build and publish
   npm run publish:mac  # or publish:win
   ```

### Option 2: S3/Digital Ocean Spaces

1. **Update package.json**
   ```json
   "publish": {
     "provider": "s3",
     "bucket": "onereach-updates",
     "region": "us-east-1",
     "path": "/desktop",
     "acl": "public-read"
   }
   ```

2. **Set AWS Credentials**
   ```bash
   export AWS_ACCESS_KEY_ID=xxx
   export AWS_SECRET_ACCESS_KEY=xxx
   ```

3. **Publish**
   ```bash
   npm run publish:mac
   ```

### Option 3: Self-Hosted Server

1. **Update package.json**
   ```json
   "publish": {
     "provider": "generic",
     "url": "https://updates.onereach.ai/desktop/",
     "channel": "latest"
   }
   ```

2. **Server Structure**
   ```
   updates.onereach.ai/desktop/
   ├── latest-mac.yml
   ├── latest-mac-arm64.yml
   ├── Onereach.ai-1.0.3-arm64.dmg
   ├── Onereach.ai-1.0.3-arm64-mac.zip
   └── Onereach.ai-1.0.3-arm64-mac.zip.blockmap
   ```

3. **Deploy Files**
   ```bash
   # After building, upload dist/*.yml and dist/*.dmg files
   rsync -av dist/*.yml dist/*.dmg dist/*.zip* user@server:/path/to/updates/
   ```

## Testing Updates

### Development Testing

1. **Create test update**
   ```bash
   # Bump version for testing
   npm version prerelease --preid=beta
   
   # Build
   npm run package:mac
   ```

2. **Test locally**
   - Install current version
   - Place new version files in a local server
   - Update `dev-app-update.yml` to point to local server
   - Run app with: `npm run dev`

### Production Testing

1. **Deploy to staging channel**
   ```json
   "publish": {
     "provider": "generic",
     "url": "https://updates.onereach.ai/desktop/",
     "channel": "beta"  // Different channel for testing
   }
   ```

2. **Test update flow**
   - Install current stable version
   - Check for updates (should find beta)
   - Download and install
   - Verify app works correctly

## Update Flow

1. **User Experience**
   - App checks for updates on startup
   - User can manually check: Help → Check for Updates
   - Notification appears when update is available
   - User clicks "Download Update"
   - Progress bar shows download status
   - **Automatic backup of current version is created**
   - User clicks "Restart & Install" when ready
   - App quits and installs update

2. **Behind the Scenes**
   - `autoUpdater.checkForUpdates()` runs
   - Checks `latest-mac.yml` on update server
   - Compares versions (semantic versioning)
   - Downloads only if newer version exists
   - Verifies code signature and checksum
   - **Creates backup of current version before install**
   - Stages update for installation
   - Replaces app on restart

## Backup & Rollback System

The app automatically keeps backups of previous versions to allow rollback if needed.

### Automatic Backups
- **When**: Before each update is installed
- **Where**: `~/Library/Application Support/onereach-ai/app-backups/`
- **How many**: Last 3 versions are kept
- **What's backed up**: Essential app files and metadata

### Accessing Backups
1. **Via Menu**: Help → Manage Backups → View Available Backups
2. **Browse Folder**: Help → Manage Backups → Open Backups Folder
3. **Manual Access**: Navigate to the backup directory

### Rollback Process
1. Open Help → Manage Backups → View Available Backups
2. Select the version you want to restore
3. A restore script will be created
4. Follow the script instructions to rollback

### Manual Rollback (Advanced)
1. Quit Onereach.ai completely
2. Navigate to backup folder
3. Find the version folder (e.g., `v1.0.2`)
4. For macOS:
   - Move current app to Trash
   - Download the original installer for that version
   - Or restore from Time Machine if available
5. For Windows:
   - Uninstall current version
   - Install the backed-up version

### Backup Storage Location
- **macOS**: `~/Library/Application Support/onereach-ai/app-backups/`
- **Windows**: `%APPDATA%/onereach-ai/app-backups/`
- **Linux**: `~/.config/onereach-ai/app-backups/`

## Versioning Strategy

1. **Semantic Versioning**
   ```
   1.0.3 → 1.0.4  (patch: bug fixes)
   1.0.3 → 1.1.0  (minor: new features)
   1.0.3 → 2.0.0  (major: breaking changes)
   ```

2. **Release Channels**
   - `latest`: Stable releases
   - `beta`: Pre-release testing
   - `alpha`: Internal testing

3. **Version Bump Commands**
   ```bash
   npm version patch     # 1.0.3 → 1.0.4
   npm version minor     # 1.0.3 → 1.1.0
   npm version major     # 1.0.3 → 2.0.0
   npm version prerelease --preid=beta  # 1.0.3 → 1.0.4-beta.0
   ```

## Rollback Strategy

If an update causes issues:

1. **Keep Previous Versions**
   - Always archive previous releases
   - Users can manually download older versions

2. **Quick Fix**
   ```bash
   # Revert problematic changes
   git revert <commit>
   
   # Bump version higher than problematic one
   npm version patch
   
   # Publish fix
   npm run publish:mac
   ```

## Security Considerations

1. **Code Signing Required**
   - Updates must be signed with same certificate
   - Notarization recommended for macOS

2. **HTTPS Only**
   - Update server must use HTTPS
   - No insecure redirects

3. **Checksum Verification**
   - `.blockmap` files verify integrity
   - Automatic in electron-updater

## Monitoring

1. **Update Analytics**
   - Track update success/failure rates
   - Monitor download speeds
   - Log error messages

2. **User Feedback**
   - Provide feedback channel for update issues
   - Monitor crash reports after updates

## Next Steps

1. Choose update distribution method
2. Set up GitHub repo or update server
3. Configure credentials
4. Test with a beta release
5. Deploy first update
6. Monitor adoption rate 