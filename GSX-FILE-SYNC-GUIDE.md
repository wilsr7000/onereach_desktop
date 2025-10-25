# GSX File Sync Guide

## Overview

The GSX File Sync feature allows you to synchronize local files and directories from your desktop to your OneReach GSX Files account. This provides an easy way to backup your work and access it from the GSX platform.

## Setup

### 1. Configure Your GSX Token

1. Open the application Settings (Cmd+, on Mac or Ctrl+, on Windows)
2. Navigate to the "GSX File Sync Configuration" section
3. Select your environment:
   - **Production** (default) - for production GSX accounts
   - **Staging** - for staging environment testing
   - **QA** - for QA environment testing
4. Enter your OneReach GSX token
5. Click "Test Connection" to verify your token is valid
6. Save your settings

### 2. Getting Your GSX Token

To obtain your OneReach GSX token:
1. Log into your OneReach account
2. Navigate to your account settings
3. Look for API tokens or developer settings
4. Generate a new token with Files API permissions
5. Copy the token and paste it into the settings

## Features

### Manual Sync

You can manually sync files through multiple methods:

#### Via Settings Page
- Click the "Sync Now" button to sync all configured paths
- Configure custom sync paths using "Configure Sync Paths"

#### Via Menu
Navigate to **GSX → File Sync** menu:
- **Sync Desktop to GSX** - Syncs your entire desktop folder
- **Sync OR-Spaces to GSX** - Syncs your clipboard spaces data
- **Sync Custom Directory** - Choose any directory to sync

### Auto-Sync

Enable automatic syncing in settings:
1. Check "Enable Auto-Sync"
2. Select sync interval:
   - Hourly
   - Daily
   - Weekly
   - Manual Only

### Default Sync Paths

By default, the following directories are configured for syncing:
- **Desktop** → `GSX Files/Desktop-Backup`
- **OR-Spaces** → `GSX Files/OR-Spaces-Backup`

## Sync History

View and manage your sync history:
- **View Sync History** - Shows the last 10 sync operations
- **Clear Sync History** - Removes all sync history records

## File Options

When syncing, you can configure:
- **Public Access** - Make synced files publicly accessible
- **Expiration** - Set TTL (time-to-live) for uploaded files

## Troubleshooting

### Connection Failed
- Verify your token is correct
- Check your internet connection
- Ensure you're using the correct environment (production/staging/qa)
- Try regenerating your token in OneReach

### Sync Failed
- Check if the local directory exists
- Ensure you have read permissions for the directory
- Verify there's enough space in your GSX account
- Check for very large files that might timeout

### Token Not Working
- Ensure the token has Files API permissions
- Check if the token has expired
- Try testing the connection in settings

## API Integration

The sync feature uses the `@or-sdk/files-sync-node` SDK which connects to:
- **Production**: `https://discovery.api.onereach.ai`
- **Staging**: `https://discovery.staging.api.onereach.ai`
- **QA**: `https://discovery.qa.api.onereach.ai`

## Security

- Your GSX token is encrypted and stored securely using your system's keychain
- Tokens are never transmitted except to OneReach servers
- All file transfers use secure HTTPS connections

## Debug Mode

To enable debug logging for sync operations:
1. Set environment variable: `DEBUG='files-sync'`
2. Run the application from terminal
3. Check console output for detailed sync logs

## Limitations

- Large files may take time to sync
- Network interruptions will cause sync to fail
- Sync is one-way (local to GSX only)
- Directory structure is preserved in GSX Files

## Support

For issues with the GSX File Sync feature:
1. Check this guide for troubleshooting steps
2. Verify your token and permissions
3. Check the application logs for error details
4. Contact OneReach support if the issue persists
