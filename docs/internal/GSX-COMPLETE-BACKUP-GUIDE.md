# GSX Complete Backup Guide

## What Gets Backed Up

The **Complete Backup** feature syncs everything you need to seamlessly restore your Onereach app on a new machine.

### 📦 Backed Up Data

#### 1. **OR-Spaces** (Clipboard Data)
Location: `~/Documents/OR-Spaces/`

**Contents:**
- `index.json` - Master index of all clipboard items
- `items/` - All clipboard items with their content
  - Text snippets
  - Images and screenshots
  - Files and documents
  - HTML content
  - PDF files with thumbnails
- `spaces/` - All your clipboard spaces
  - Space definitions
  - Space metadata
  - Space-specific items

**GSX Location:** `Complete-Backup/OR-Spaces/`

#### 2. **App Configuration** (Settings & Data)
Location: `~/Library/Application Support/Onereach.ai/`

**Contents:**
- `app-settings-encrypted.json` - Your app settings (encrypted)
- `idw-entries.json` - IDW environment configurations
- `gsx-links.json` - GSX links and shortcuts
- `reading-log.json` - **Your reading log history** ✅
- `user-preferences.json` - User preferences
- `external-bots.json` - External bot configurations
- `image-creators.json` - Image creator tools
- `video-creators.json` - Video creator tools
- `audio-generators.json` - Audio generator tools
- `ui-design-tools.json` - UI design tools
- `clipboard-history.json` - Clipboard history index
- `clipboard-spaces.json` - Clipboard spaces definitions
- `clipboard-preferences.json` - Clipboard preferences

**GSX Location:** `Complete-Backup/App-Config/`

---

## 🚀 How to Use Complete Backup

### Method 1: Via Settings (Recommended)

1. Open Settings (`Cmd+,` or `Ctrl+,`)
2. Scroll to "GSX File Sync Configuration"
3. Enter your GSX token and test connection
4. Click the big blue button: **"🔒 Complete Backup (Recommended)"**
5. Wait for success message

### Method 2: Via Menu

1. Menu → **GSX** → **File Sync**
2. Click **"Complete Backup (Recommended)"**
3. Wait for success dialog

---

## 🔄 Restoring on a New Machine

When you install Onereach on a new machine, you can restore all your data:

### Step 1: Install & Configure
1. Install Onereach app on new machine
2. Open Settings and add your GSX token
3. Test connection to ensure it works

### Step 2: Download Backup from GSX Files
1. Log into your GSX account
2. Navigate to **Files** section
3. Find the `Complete-Backup` folder
4. Download both subdirectories:
   - `OR-Spaces/`
   - `App-Config/`

### Step 3: Restore Files

**Restore OR-Spaces:**
```bash
# Extract downloaded OR-Spaces to Documents
mv ~/Downloads/OR-Spaces ~/Documents/OR-Spaces
```

**Restore App Config:**
```bash
# Extract to Application Support
# Mac:
mv ~/Downloads/App-Config/* ~/Library/Application\ Support/Onereach.ai/

# Windows:
# Move to %APPDATA%/Onereach.ai/

# Linux:
# Move to ~/.config/Onereach.ai/
```

### Step 4: Restart App
1. Quit Onereach completely
2. Relaunch the app
3. Everything should be restored:
   - ✅ All clipboard items
   - ✅ All spaces
   - ✅ Reading logs
   - ✅ IDW environments
   - ✅ GSX links
   - ✅ All preferences
   - ✅ External tools

---

## 🔍 What's Included in Each Backup

### OR-Spaces Backup Includes:
- **All clipboard history** - Every item you've copied
- **All spaces** - Work, Personal, Projects, etc.
- **Images & Screenshots** - With thumbnails
- **Files** - Documents, PDFs, etc.
- **Metadata** - Tags, descriptions, AI-generated content

### App Config Backup Includes:
- **Reading logs** - Complete reading history ✅
- **IDW environments** - All configured IDW instances
- **GSX configurations** - Links and account settings
- **Tool configurations** - External bots, creators, generators
- **Clipboard settings** - Preferences and space configs
- **App preferences** - Theme, auto-save, etc.

---

## 📅 Backup Schedule Recommendations

### Manual Backup
Use **Complete Backup** when:
- Before updating the app
- Before switching machines
- After significant configuration changes
- Weekly for important data

### Auto-Sync (Coming Soon)
Enable auto-sync in settings to:
- Backup daily/hourly automatically
- Keep continuous backup of changes
- Never lose important data

---

## 💾 Storage & File Sizes

**Typical backup sizes:**
- OR-Spaces: 10-500 MB (depends on clipboard items)
- App Config: 1-50 MB (mostly text files)

**GSX Storage:**
- Check your GSX account for storage limits
- Backups are compressed during transfer
- Only changed files are uploaded (after first backup)

---

## 🔒 Security & Privacy

### Encrypted Data
- Settings with tokens are already encrypted
- Backed up in encrypted format
- Only decryptable on your machines

### Safe Storage
- All data uploaded via HTTPS
- Stored in your GSX Files account
- Only you have access

### What's NOT Backed Up
- Electron cache files
- Temporary files
- Session data
- Downloaded modules (can be re-downloaded)

---

## ❓ Troubleshooting

### Backup Failed
- Check GSX token is valid
- Ensure internet connection
- Verify sufficient GSX storage space
- Try individual backups (OR-Spaces, then Config)

### Restore Issues
- Make sure paths are correct
- Check file permissions
- Restart app after restore
- Clear app cache if issues persist

### Missing Data After Restore
- Verify both OR-Spaces and App-Config were restored
- Check file locations are correct
- Look for backup files with `.backup` extension
- Contact support with sync history

---

## 📊 Backup History

View your backup history:
- Menu → GSX → File Sync → **View Sync History**
- Shows last 10 backup operations
- Displays success/failure status
- Shows timestamps and locations

---

## 🎯 Best Practices

1. **Test Your Backup**
   - Do a complete backup
   - Verify files in GSX Files
   - Confirm both folders are present

2. **Regular Backups**
   - Weekly minimum
   - Before major changes
   - Before app updates

3. **Verify Restore Process**
   - Test restore on a test machine
   - Ensure all data appears correctly
   - Practice the process once

4. **Keep Multiple Backups**
   - Don't overwrite old backups immediately
   - Keep at least 2-3 recent backups
   - Rename backups with dates in GSX Files

---

## 📞 Support

For issues with Complete Backup:
1. Check this guide first
2. View sync history for error details
3. Test connection in Settings
4. Contact OneReach support with:
   - Sync history
   - Error messages
   - App version

---

**✅ With Complete Backup, your entire Onereach setup is portable and restorable!**
